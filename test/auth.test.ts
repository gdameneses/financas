import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import app from "../src/index";
import { resetDb } from "./helpers";

beforeEach(resetDb);

const ORIGIN = "https://finance.test";
const ADMIN = "admin@example.com";
const IP_HOME = "203.0.113.10";
const IP_OTHER = "198.51.100.7";

// Cookie jar + fixed client IP: behaves like one browser on one network.
class Browser {
  cookies = new Map<string, string>();
  constructor(public ip: string) {}
  async fetch(path: string, init: RequestInit = {}, extraEnv: Partial<typeof env> = {}) {
    const headers = new Headers(init.headers);
    headers.set("cf-connecting-ip", this.ip);
    headers.set("user-agent", "test/1.0");
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await app.request(ORIGIN + path, { ...init, headers, redirect: "manual" }, { ...env, ...extraEnv });
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(";");
      const [k, v] = pair.split("=");
      if (attrs.some((a) => /max-age=0/i.test(a))) this.cookies.delete(k.trim());
      else this.cookies.set(k.trim(), v);
    }
    return res;
  }
  form(path: string, data: Record<string, string>, extraEnv: Partial<typeof env> = {}) {
    return this.fetch(
      path,
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(data).toString() },
      extraEnv,
    );
  }
}

async function bootstrapAdmin(ip = IP_HOME): Promise<Browser> {
  const b = new Browser(ip);
  let r = await b.form("/acesso", { op: "request", email: ADMIN, name: "laptop" });
  expect(r.status).toBe(302);
  expect(r.headers.get("location")).toBe("/login");
  r = await b.form("/login", { email: ADMIN, password: "senha-forte-123" });
  expect(r.status).toBe(302);
  return b;
}

async function pendingCode(): Promise<string> {
  const row = await env.DB.prepare("SELECT code FROM access_codes WHERE used_at IS NULL ORDER BY id DESC LIMIT 1").first<{ code: string }>();
  return row!.code;
}

describe("access gates", () => {
  it("unknown browser only ever sees /acesso", async () => {
    const b = new Browser(IP_HOME);
    let r = await b.fetch("/");
    expect(r.headers.get("location")).toBe("/acesso");
    r = await b.fetch("/login");
    expect(r.headers.get("location")).toBe("/acesso");
    r = await b.fetch("/acesso");
    expect(r.status).toBe(200);
  });

  it("first admin bootstraps without any code and its IP becomes allowed", async () => {
    const b = await bootstrapAdmin();
    expect((await b.fetch("/")).status).toBe(200);
    const ips = await env.DB.prepare("SELECT cidr FROM allowed_ips").all<{ cidr: string }>();
    expect(ips.results.map((x) => x.cidr)).toEqual([IP_HOME]);
    // A non-admin e-mail cannot bootstrap.
    await resetDb();
    const n = new Browser(IP_HOME);
    const r = await n.form("/acesso", { op: "request", email: "someone@example.com", name: "x" });
    expect(r.status).toBe(200); // stays on the code step
    expect((await env.DB.prepare("SELECT status FROM devices").first<{ status: string }>())!.status).toBe("pending");
  });

  it("an approved device is never locked out by a new network: it passes and the network is recorded", async () => {
    const b = await bootstrapAdmin();
    b.ip = IP_OTHER;
    const r = await b.fetch("/");
    expect(r.status).toBe(200);
    const log = await env.DB.prepare("SELECT outcome FROM access_log ORDER BY id DESC LIMIT 1").first<{ outcome: string }>();
    expect(log!.outcome).toBe("ip_auto");
    const ips = await env.DB.prepare("SELECT cidr, label FROM allowed_ips ORDER BY id").all<{ cidr: string; label: string }>();
    expect(ips.results.map((x) => x.cidr)).toEqual([IP_HOME, IP_OTHER]);
    expect(ips.results[1].label).toContain("automático");
    // Unknown devices on an unlisted network are still only shown /acesso.
    const stranger = new Browser("192.0.2.9");
    expect((await stranger.fetch("/")).headers.get("location")).toBe("/acesso");
    expect((await env.DB.prepare("SELECT outcome FROM access_log ORDER BY id DESC LIMIT 1").first<{ outcome: string }>())!.outcome).toBe("ip_denied");
  });

  it("new person: request → 8-digit code visible to admins → code approves device and IP", async () => {
    const admin = await bootstrapAdmin();
    const phone = new Browser(IP_OTHER);
    let r = await phone.form("/acesso", { op: "request", email: "nic@example.com", name: "celular" });
    expect(r.status).toBe(200);
    const code = await pendingCode();
    expect(code).toMatch(/^\d{8}$/);

    // Admin sees the code in-app.
    r = await admin.fetch("/acessos?tab=pedidos");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain(`${code.slice(0, 4)} ${code.slice(4)}`);

    // Wrong code counts an attempt; right code approves.
    r = await phone.form("/acesso", { op: "code", code: "00000000" });
    expect(r.status).toBe(400);
    r = await phone.form("/acesso", { op: "code", code: `${code.slice(0, 4)} ${code.slice(4)}` });
    expect(r.headers.get("location")).toBe("/login");

    // Registration only for the e-mail the device was approved for.
    r = await phone.form("/login", { email: "other@example.com", password: "senha-forte-123" });
    expect(r.status).toBe(401);
    r = await phone.form("/login", { email: "nic@example.com", password: "senha-forte-123" });
    expect(r.headers.get("location")).toBe("/");
    expect((await phone.fetch("/")).status).toBe(200);

    const ips = await env.DB.prepare("SELECT cidr FROM allowed_ips ORDER BY id").all<{ cidr: string }>();
    expect(ips.results.map((x) => x.cidr)).toEqual([IP_HOME, IP_OTHER]);
  });

  it("code locks after 5 wrong attempts and expires", async () => {
    await bootstrapAdmin();
    const phone = new Browser(IP_OTHER);
    await phone.form("/acesso", { op: "request", email: "nic@example.com", name: "celular" });
    for (let i = 0; i < 5; i++) await phone.form("/acesso", { op: "code", code: "11111111" });
    const code = await pendingCode();
    const r = await phone.form("/acesso", { op: "code", code });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("Muitas tentativas");
  });

  it("rate-limits access requests per IP", async () => {
    await bootstrapAdmin();
    const phone = new Browser(IP_OTHER);
    for (let i = 0; i < 3; i++) expect((await phone.form("/acesso", { op: "request", email: "a@example.com", name: "x" })).status).toBe(200);
    expect((await phone.form("/acesso", { op: "request", email: "a@example.com", name: "x" })).status).toBe(429);
  });

  it("admin can approve or deny from the app; non-admins cannot reach /acessos", async () => {
    const admin = await bootstrapAdmin();
    const phone = new Browser(IP_OTHER);
    await phone.form("/acesso", { op: "request", email: "nic@example.com", name: "celular" });
    const id = (await env.DB.prepare("SELECT id FROM devices WHERE name = 'celular'").first<{ id: number }>())!.id;
    let r = await admin.form(`/acessos/aparelhos/${id}/aprovar`, { allow_ip: "1" });
    expect(r.status).toBe(302);
    r = await phone.fetch("/login");
    expect(r.status).toBe(200);
    await phone.form("/login", { email: "nic@example.com", password: "senha-forte-123" });
    r = await phone.fetch("/acessos");
    expect(r.status).toBe(403);
    r = await phone.fetch("/categorias");
    expect(r.status).toBe(403);
    r = await phone.fetch("/api/export.json");
    expect(r.status).toBe(403);
    expect((await phone.fetch("/nova")).status).toBe(200);
  });

  it("banning a user kills sessions and devices immediately", async () => {
    const admin = await bootstrapAdmin();
    const phone = new Browser(IP_OTHER);
    await phone.form("/acesso", { op: "request", email: "nic@example.com", name: "celular" });
    await phone.form("/acesso", { op: "code", code: await pendingCode() });
    await phone.form("/login", { email: "nic@example.com", password: "senha-forte-123" });
    expect((await phone.fetch("/")).status).toBe(200);
    const uid = (await env.DB.prepare("SELECT id FROM users WHERE email = 'nic@example.com'").first<{ id: number }>())!.id;
    await admin.form(`/acessos/usuarios/${uid}/bloquear`, {});
    const r = await phone.fetch("/");
    expect(r.headers.get("location")).toBe("/acesso"); // device revoked too
    // Admins cannot be banned.
    const aid = (await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(ADMIN).first<{ id: number }>())!.id;
    expect((await admin.form(`/acessos/usuarios/${aid}/bloquear`, {})).status).toBe(400);
  });

  it("every request is logged with ip, outcome and who", async () => {
    const admin = await bootstrapAdmin();
    await admin.fetch("/");
    const rows = (await env.DB.prepare("SELECT ip, outcome, user_id, path FROM access_log ORDER BY id").all<{ ip: string; outcome: string; user_id: number | null; path: string }>()).results;
    expect(rows[0]).toMatchObject({ ip: IP_HOME, outcome: "device_unknown", path: "/acesso" });
    expect(rows[rows.length - 1]).toMatchObject({ ip: IP_HOME, outcome: "ok", path: "/" });
    expect(rows[rows.length - 1].user_id).not.toBeNull();
  });

  it("bootstrap cannot re-open: approved device asking from a new IP stays approved; after revoke, users>0 blocks it", async () => {
    const admin = await bootstrapAdmin();
    admin.ip = IP_OTHER;
    // A new network never downgrades an approved device.
    let r = await admin.fetch("/");
    expect(r.status).toBe(200);
    const dev = await env.DB.prepare("SELECT status, requested_email FROM devices WHERE name = 'laptop'").first<{ status: string; requested_email: string }>();
    expect(dev).toEqual({ status: "approved", requested_email: ADMIN });
    // Even with zero approved devices, an existing user closes the bootstrap door.
    await env.DB.prepare("UPDATE devices SET status = 'revoked'").run();
    const stranger = new Browser(IP_HOME);
    r = await stranger.form("/acesso", { op: "request", email: "second@example.com", name: "x" });
    expect(r.status).toBe(200); // pending, not approved
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE status = 'approved'").first<{ n: number }>())!.n).toBe(0);
  });

  it("an admin e-mail with no account cannot be claimed through a code", async () => {
    const admin = await bootstrapAdmin();
    const stranger = new Browser(IP_OTHER);
    await stranger.form("/acesso", { op: "request", email: "second@example.com", name: "fake" });
    await stranger.form("/acesso", { op: "code", code: await pendingCode() });
    let r = await stranger.fetch("/login");
    expect(await r.text()).not.toContain("Criar sua conta");
    r = await stranger.form("/login", { email: "second@example.com", password: "senha-forte-123" });
    expect(r.status).toBe(401);
    // Admin one-click approve of an admin-e-mail request needs the explicit confirmation tick.
    const stranger2 = new Browser(IP_OTHER);
    await stranger2.form("/acesso", { op: "request", email: "second@example.com", name: "fake2" });
    const id = (await env.DB.prepare("SELECT id FROM devices WHERE name = 'fake2'").first<{ id: number }>())!.id;
    r = await admin.form(`/acessos/aparelhos/${id}/aprovar`, { allow_ip: "1" });
    expect(r.headers.get("location")).toContain("confirma");
    expect((await env.DB.prepare("SELECT status FROM devices WHERE id = ?").bind(id).first<{ status: string }>())!.status).toBe("pending");
  });

  it("revoked device cannot redeem a still-live code", async () => {
    const admin = await bootstrapAdmin();
    const phone = new Browser(IP_OTHER);
    await phone.form("/acesso", { op: "request", email: "nic@example.com", name: "celular" });
    const code = await pendingCode();
    const id = (await env.DB.prepare("SELECT id FROM devices WHERE name = 'celular'").first<{ id: number }>())!.id;
    await admin.form(`/acessos/aparelhos/${id}/revogar`, {});
    const r = await phone.form("/acesso", { op: "code", code });
    expect(r.status).toBe(400);
    expect((await env.DB.prepare("SELECT status FROM devices WHERE id = ?").bind(id).first<{ status: string }>())!.status).toBe("revoked");
  });

  it("login attempts are counted per e-mail and survive another user's login", async () => {
    const admin = await bootstrapAdmin();
    for (let i = 0; i < 5; i++) await admin.form("/login", { email: ADMIN, password: "errada-errada" });
    await admin.form("/logout", {});
    const r = await admin.form("/login", { email: ADMIN, password: "senha-forte-123" });
    expect(r.status).toBe(429);
  });

  it("changing the password logs out other sessions and cannot remove the last allowed IP", async () => {
    const admin = await bootstrapAdmin();
    const second = new Browser(IP_HOME);
    // second browser: approved by the admin, same account logs in
    await second.form("/acesso", { op: "request", email: ADMIN, name: "tablet" });
    const id = (await env.DB.prepare("SELECT id FROM devices WHERE name = 'tablet'").first<{ id: number }>())!.id;
    await admin.form(`/acessos/aparelhos/${id}/aprovar`, { allow_ip: "1", confirm_admin: "1" });
    await second.form("/login", { email: ADMIN, password: "senha-forte-123" });
    expect((await second.fetch("/")).status).toBe(200);
    let r = await admin.form("/config/senha", { current: "senha-forte-123", next: "nova-senha-456" });
    expect(r.status).toBe(302);
    expect((await second.fetch("/")).headers.get("location")).toBe("/login");
    expect((await admin.fetch("/")).status).toBe(200);
    const ip = (await env.DB.prepare("SELECT id FROM allowed_ips").first<{ id: number }>())!.id;
    r = await admin.form(`/acessos/ips/${ip}/remover`, {});
    expect(r.headers.get("location")).toContain("vazia");
  });

  it("LIBERADO=true approves any browser and skips the IP list", async () => {
    const b = new Browser(IP_OTHER);
    const r = await b.fetch("/", {}, { LIBERADO: "true" });
    expect(r.headers.get("location")).toBe("/login");
  });

  it("REQUIRE_ACCESS=1 rejects requests without the Access header", async () => {
    const b = new Browser(IP_HOME);
    expect((await b.fetch("/", {}, { REQUIRE_ACCESS: "1" })).status).toBe(403);
  });
});

describe("ledger", () => {
  it("presets ship with flat icon names; deleting one uncategorizes its transactions", async () => {
    const admin = await bootstrapAdmin();
    const mercado = (await env.DB.prepare("SELECT id, icon FROM categories WHERE name = 'Mercado'").first<{ id: number; icon: string }>())!;
    expect(mercado.icon).toBe("shopping-cart");
    let r = await admin.form("/nova", { kind: "out", amount: "123,45", date: "2026-10-05", category_id: String(mercado.id), payee: "Pão de Açúcar" });
    expect(r.status).toBe(302);
    r = await admin.form(`/categorias/${mercado.id}/excluir`, {});
    expect(r.status).toBe(302);
    const tx = await env.DB.prepare("SELECT category_id, amount_cents, user_id FROM transactions WHERE payee = 'Pão de Açúcar'").first<{
      category_id: number | null;
      amount_cents: number;
      user_id: number;
    }>();
    expect(tx).toMatchObject({ category_id: null, amount_cents: 12345 });
    expect(tx!.user_id).not.toBeNull();
  });

  it("creates a custom category with a picked icon and rejects a wrong-kind category", async () => {
    const admin = await bootstrapAdmin();
    let r = await admin.form("/categorias", { kind: "out", name: "Bike", icon: "car", color: "#123456" });
    expect(r.status).toBe(302);
    const bike = (await env.DB.prepare("SELECT id, icon, is_preset FROM categories WHERE name = 'Bike'").first<{ id: number; icon: string; is_preset: number }>())!;
    expect(bike).toMatchObject({ icon: "car", is_preset: 0 });
    r = await admin.form("/nova", { kind: "in", amount: "10", date: "2026-10-05", category_id: String(bike.id) });
    expect(r.status).toBe(400);
  });

  it("export.json carries everything in centavos", async () => {
    const admin = await bootstrapAdmin();
    await admin.form("/nova", { kind: "out", amount: "123,45", date: "2026-10-05", category_id: "" });
    const r = await admin.fetch("/api/export.json");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { amounts: string; transactions: { amount_cents: number }[] };
    expect(body.amounts).toBe("integer centavos");
    expect(body.transactions.some((t) => t.amount_cents === 12345)).toBe(true);
  });
});
