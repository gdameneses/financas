import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import app from "../src/index";
import { resetDb } from "./helpers";

beforeEach(resetDb);

const ORIGIN = "https://finance.test";

// Cookie jar: keeps fin_device / fin_session across requests like a browser would.
class Jar {
  cookies = new Map<string, string>();
  async fetch(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await app.request(ORIGIN + path, { ...init, headers, redirect: "manual" }, env);
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(";");
      const [k, v] = pair.split("=");
      if (attrs.some((a) => /max-age=0/i.test(a))) this.cookies.delete(k.trim());
      else this.cookies.set(k.trim(), v);
    }
    return res;
  }
  form(path: string, data: Record<string, string>) {
    return this.fetch(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(data).toString(),
    });
  }
}

async function enrolledAndLoggedIn(): Promise<Jar> {
  const jar = new Jar();
  let r = await jar.form("/enroll", { code: "test-enroll-secret", name: "laptop" });
  expect(r.status).toBe(302);
  r = await jar.form("/login", { email: "gus@example.com", password: "senha-forte-123" });
  expect(r.status).toBe(302);
  return jar;
}

describe("gates", () => {
  it("unenrolled browser is sent to /enroll and cannot see /login", async () => {
    const jar = new Jar();
    let r = await jar.fetch("/");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/enroll");
    r = await jar.fetch("/login");
    expect(r.headers.get("location")).toBe("/enroll");
  });

  it("rejects a bad enroll code", async () => {
    const jar = new Jar();
    const r = await jar.form("/enroll", { code: "NOPE1234", name: "x" });
    expect(r.status).toBe(400);
    expect(jar.cookies.has("fin_device")).toBe(false);
  });

  it("bootstrap secret enrolls the first device only", async () => {
    const jar = await enrolledAndLoggedIn();
    expect(jar.cookies.has("fin_device")).toBe(true);
    expect(jar.cookies.has("fin_session")).toBe(true);
    // Second device cannot use the bootstrap secret any more.
    const other = new Jar();
    const r = await other.form("/enroll", { code: "test-enroll-secret", name: "phone" });
    expect(r.status).toBe(400);
  });

  it("session survives and a device code enrolls a second device", async () => {
    const laptop = await enrolledAndLoggedIn();
    let r = await laptop.fetch("/");
    expect(r.status).toBe(200);

    r = await laptop.form("/dispositivos/codigo", {});
    const code = new URL(r.headers.get("location")!, ORIGIN).searchParams.get("code")!;
    expect(code).toMatch(/^[0-9A-F]{8}$/);

    const phone = new Jar();
    r = await phone.form("/enroll", { code, name: "phone" });
    expect(r.status).toBe(302);
    // Code is single use.
    const again = new Jar();
    r = await again.form("/enroll", { code, name: "again" });
    expect(r.status).toBe(400);

    // Phone needs its own login; the laptop session cookie is bound to the laptop device.
    r = await phone.fetch("/");
    expect(r.headers.get("location")).toBe("/login");
    r = await phone.form("/login", { email: "gus@example.com", password: "senha-forte-123" });
    expect(r.status).toBe(302);
    r = await phone.fetch("/");
    expect(r.status).toBe(200);

    // Revoking the phone from the laptop kills its session and device.
    const id = (await env.DB.prepare("SELECT id FROM devices WHERE name = 'phone'").first<{ id: number }>())!.id;
    r = await laptop.form(`/dispositivos/${id}/revogar`, {});
    expect(r.status).toBe(302);
    r = await phone.fetch("/");
    expect(r.headers.get("location")).toBe("/enroll");
  });

  it("rate-limits after 5 bad passwords", async () => {
    const jar = await enrolledAndLoggedIn();
    await jar.form("/logout", {});
    for (let i = 0; i < 5; i++) {
      const r = await jar.form("/login", { email: "gus@example.com", password: "errada-errada" });
      expect(r.status).toBe(401);
    }
    const r = await jar.form("/login", { email: "gus@example.com", password: "senha-forte-123" });
    expect(r.status).toBe(429);
  });

  it("LIBERADO=true enrolls unknown browsers automatically", async () => {
    const open = { ...env, LIBERADO: "true" };
    const r = await app.request(ORIGIN + "/", { redirect: "manual" }, open);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/login"); // past the device gate, straight to login
    expect(r.headers.getSetCookie().some((c) => c.startsWith("fin_device="))).toBe(true);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM devices").first<{ n: number }>();
    expect(n).toEqual({ n: 1 });
  });

  it("REQUIRE_ACCESS=1 rejects requests without the Access header", async () => {
    const res = await app.request(ORIGIN + "/", {}, { ...env, REQUIRE_ACCESS: "1" });
    expect(res.status).toBe(403);
    const ok = await app.request(ORIGIN + "/", { headers: { "cf-access-jwt-assertion": "x" } }, { ...env, REQUIRE_ACCESS: "1" });
    expect(ok.status).toBe(302); // past Access, now the device gate
  });
});

describe("categories & transactions", () => {
  it("ships presets and lets you delete one; its transactions become uncategorized", async () => {
    const jar = await enrolledAndLoggedIn();
    const mercado = (await env.DB.prepare("SELECT id FROM categories WHERE name = 'Mercado'").first<{ id: number }>())!;
    let r = await jar.form("/nova", { kind: "out", amount: "123,45", date: "2026-10-05", category_id: String(mercado.id), payee: "Pão de Açúcar" });
    expect(r.status).toBe(302);
    r = await jar.form(`/categorias/${mercado.id}/excluir`, {});
    expect(r.status).toBe(302);
    const tx = await env.DB.prepare("SELECT category_id, amount_cents FROM transactions WHERE payee = 'Pão de Açúcar'").first<{
      category_id: number | null;
      amount_cents: number;
    }>();
    expect(tx).toEqual({ category_id: null, amount_cents: 12345 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM categories WHERE name = 'Mercado'").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("creates a custom category and rejects a category of the wrong kind", async () => {
    const jar = await enrolledAndLoggedIn();
    let r = await jar.form("/categorias", { kind: "out", name: "Bike", icon: "🚲", color: "#123456" });
    expect(r.status).toBe(302);
    const bike = (await env.DB.prepare("SELECT id, is_preset FROM categories WHERE name = 'Bike'").first<{ id: number; is_preset: number }>())!;
    expect(bike.is_preset).toBe(0);
    r = await jar.form("/nova", { kind: "in", amount: "10", date: "2026-10-05", category_id: String(bike.id) });
    expect(r.status).toBe(400);
  });

  it("export.json carries everything in centavos", async () => {
    const jar = await enrolledAndLoggedIn();
    await jar.form("/nova", { kind: "out", amount: "123,45", date: "2026-10-05", category_id: "" });
    const r = await jar.fetch("/api/export.json");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { amounts: string; transactions: { amount_cents: number }[] };
    expect(body.amounts).toBe("integer centavos");
    expect(body.transactions.some((t) => t.amount_cents === 12345)).toBe(true);
  });
});
