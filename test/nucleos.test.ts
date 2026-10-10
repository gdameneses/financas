import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { Browser, latestInvite, nucleoIdByName, resetDb } from "./helpers";

beforeEach(resetDb);

const ADMIN = "admin@example.com";
const IP = "203.0.113.10";

/** Bootstraps the app admin (first device) and lets them create a núcleo named `nucleo`. */
async function appAdmin(nucleo = "Casa"): Promise<Browser> {
  const b = new Browser(IP);
  await b.form("/acesso", { op: "request", email: ADMIN, name: "laptop" });
  await b.form("/login", { email: ADMIN, password: "senha-forte-123" });
  expect((await b.form("/nucleos", { name: nucleo })).status).toBe(302);
  return b;
}

/** A second person: device approved by the admin (no núcleo), account created. */
async function newPerson(admin: Browser, email: string, device: string): Promise<Browser> {
  const b = new Browser(IP);
  await b.form("/acesso", { op: "request", email, name: device });
  const id = (await env.DB.prepare("SELECT id FROM devices WHERE name = ?").bind(device).first<{ id: number }>())!.id;
  await admin.form(`/acessos/aparelhos/${id}/aprovar`, { allow_ip: "1" });
  expect((await b.form("/login", { email, password: "senha-forte-123" })).headers.get("location")).toBe("/");
  return b;
}

async function invite(admin: Browser, nucleo: string, role: "membro" | "admin" = "membro"): Promise<string> {
  expect((await admin.form("/nucleo/convites", { role })).status).toBe(302);
  return latestInvite(await nucleoIdByName(nucleo));
}

async function firstCategory(nucleo: string, name = "Mercado"): Promise<number> {
  return (await env.DB.prepare("SELECT c.id FROM categories c JOIN nucleos n ON n.id = c.nucleo_id WHERE n.name = ? AND c.name = ?").bind(nucleo, name).first<{ id: number }>())!.id;
}

describe("núcleos: isolation", () => {
  it("two núcleos never see each other's ledger, categories, plan or export", async () => {
    const gus = await appAdmin("Casa");
    const ana = await newPerson(gus, "ana@example.com", "ana-phone");
    expect((await ana.form("/nucleos", { name: "Ana" })).status).toBe(302);

    const mercadoCasa = await firstCategory("Casa");
    const mercadoAna = await firstCategory("Ana");
    expect(mercadoCasa).not.toBe(mercadoAna); // each núcleo seeds its own presets

    await gus.form("/nova", { kind: "out", amount: "100,00", date: "2026-10-05", category_id: String(mercadoCasa), payee: "Padaria do Gus" });
    await ana.form("/nova", { kind: "out", amount: "7,00", date: "2026-10-05", category_id: String(mercadoAna), payee: "Café da Ana" });
    const txGus = (await env.DB.prepare("SELECT id FROM transactions WHERE payee = 'Padaria do Gus'").first<{ id: number }>())!.id;

    // Pages
    const anaHome = await (await ana.fetch("/")).text();
    expect(anaHome).toContain("Café da Ana");
    expect(anaHome).not.toContain("Padaria do Gus");
    expect(anaHome).toContain("Ana"); // hero names the núcleo
    expect(await (await gus.fetch("/transacoes?mes=2026-10")).text()).not.toContain("Café da Ana");

    // Direct ids from the other núcleo are "not found", and nothing changes.
    expect((await ana.fetch(`/transacoes/${txGus}`)).status).toBe(404);
    expect((await ana.form(`/transacoes/${txGus}`, { kind: "out", amount: "1", date: "2026-10-05", category_id: "" })).status).toBe(404);
    expect((await ana.form(`/transacoes/${txGus}/excluir`, {})).status).toBe(404);
    expect((await ana.fetch(`/categorias/${mercadoCasa}`)).status).toBe(404);
    expect((await ana.form(`/categorias/${mercadoCasa}/excluir`, {})).status).toBe(404);
    const still = await env.DB.prepare("SELECT amount_cents FROM transactions WHERE id = ?").bind(txGus).first<{ amount_cents: number }>();
    expect(still!.amount_cents).toBe(10000);
    expect(await env.DB.prepare("SELECT id FROM categories WHERE id = ?").bind(mercadoCasa).first()).not.toBeNull();

    // A category id from another núcleo is rejected on the transaction form.
    expect((await ana.form("/nova", { kind: "out", amount: "1", date: "2026-10-05", category_id: String(mercadoCasa) })).status).toBe(400);

    // Planning caps only land on the núcleo's own categories.
    await ana.form("/planejamento?mes=2026-10", { [`cap_${mercadoCasa}`]: "500", [`cap_${mercadoAna}`]: "50" });
    const caps = (await env.DB.prepare("SELECT category_id, cap_cents FROM budgets ORDER BY category_id").all<{ category_id: number; cap_cents: number }>()).results;
    expect(caps).toEqual([{ category_id: mercadoAna, cap_cents: 5000 }]);

    // Export and reports are per núcleo.
    const exp = (await (await ana.fetch("/api/export.json")).json()) as { nucleo: string; transactions: { payee: string }[]; categories: unknown[] };
    expect(exp.nucleo).toBe("Ana");
    expect(exp.transactions.map((t) => t.payee)).toEqual(["Café da Ana"]);
    expect(exp.categories).toHaveLength(18);
    const mensal = (await (await gus.fetch("/api/report/mensal/2026-10.json")).json()) as { expense: number };
    expect(mensal.expense).toBe(10000);
  });

  it("alerts fire per núcleo and cannot be dismissed from another", async () => {
    const gus = await appAdmin("Casa");
    const ana = await newPerson(gus, "ana@example.com", "ana-phone");
    await ana.form("/nucleos", { name: "Ana" });
    const mercadoCasa = await firstCategory("Casa");
    const month = new Date().toISOString().slice(0, 7);
    const today = new Date().toISOString().slice(0, 10);
    await gus.form(`/planejamento?mes=${month}`, { [`cap_${mercadoCasa}`]: "100" });
    await gus.form("/nova", { kind: "out", amount: "150,00", date: today, category_id: String(mercadoCasa), payee: "Estouro" });
    expect(await (await gus.fetch("/")).text()).toContain("estourou o planejado");
    expect(await (await ana.fetch("/")).text()).not.toContain("estourou");
    const alertId = (await env.DB.prepare("SELECT id FROM alerts WHERE level = '100'").first<{ id: number }>())!.id;
    await ana.form(`/avisos/${alertId}/ignorar`, {});
    expect((await env.DB.prepare("SELECT dismissed_at FROM alerts WHERE id = ?").bind(alertId).first<{ dismissed_at: string | null }>())!.dismissed_at).toBeNull();
    await gus.form(`/avisos/${alertId}/ignorar`, {});
    expect((await env.DB.prepare("SELECT dismissed_at FROM alerts WHERE id = ?").bind(alertId).first<{ dismissed_at: string | null }>())!.dismissed_at).not.toBeNull();
  });
});

describe("núcleos: invites and roles", () => {
  it("invite joins with the chosen role, once; revoked codes and wrong guesses fail; guesses are rate-limited", async () => {
    const gus = await appAdmin("Casa");
    const nic = await newPerson(gus, "nic@example.com", "nic-phone");
    expect((await nic.fetch("/")).headers.get("location")).toBe("/comecar");

    const code = await invite(gus, "Casa", "membro");
    expect(code).toMatch(/^\d{8}$/);
    expect(await (await gus.fetch("/nucleo")).text()).toContain(`${code.slice(0, 4)} ${code.slice(4)}`);

    let r = await nic.form("/nucleos/entrar", { code: "00000000" });
    expect(r.status).toBe(400);
    r = await nic.form("/nucleos/entrar", { code });
    expect(r.headers.get("location")).toContain("Casa");
    expect((await nic.fetch("/")).status).toBe(200);
    expect((await nic.fetch("/categorias")).status).toBe(403); // membro
    const members = (await env.DB.prepare("SELECT role FROM nucleo_members WHERE user_id = (SELECT id FROM users WHERE email = 'nic@example.com')").all<{ role: string }>()).results;
    expect(members).toEqual([{ role: "membro" }]);

    // Single use.
    const third = await newPerson(gus, "third@example.com", "third-phone");
    r = await third.form("/nucleos/entrar", { code });
    expect(r.status).toBe(400);

    // Revoked codes die.
    const code2 = await invite(gus, "Casa", "admin");
    const inv = (await env.DB.prepare("SELECT id FROM nucleo_invites WHERE code = ?").bind(code2).first<{ id: number }>())!.id;
    await gus.form(`/nucleo/convites/${inv}/revogar`, {});
    expect((await third.form("/nucleos/entrar", { code: code2 })).status).toBe(400);

    // Admin invites make admins.
    const code3 = await invite(gus, "Casa", "admin");
    await third.form("/nucleos/entrar", { code: code3 });
    expect((await third.fetch("/categorias")).status).toBe(200);

    // 10 wrong guesses per IP per hour, then 429 even for a right code.
    const fourth = await newPerson(gus, "fourth@example.com", "fourth-phone");
    for (let i = 0; i < 8; i++) await fourth.form("/nucleos/entrar", { code: "12345678" }); // + the 2 wrong ones above on the same IP
    const code4 = await invite(gus, "Casa");
    expect((await fourth.form("/nucleos/entrar", { code: code4 })).status).toBe(429);
  });

  it("the last admin cannot be demoted, removed or leave; members can leave", async () => {
    const gus = await appAdmin("Casa");
    const nic = await newPerson(gus, "nic@example.com", "nic-phone");
    await nic.form("/nucleos/entrar", { code: await invite(gus, "Casa") });
    const gusId = (await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(ADMIN).first<{ id: number }>())!.id;
    const nicId = (await env.DB.prepare("SELECT id FROM users WHERE email = 'nic@example.com'").first<{ id: number }>())!.id;

    // Members cannot manage the núcleo.
    expect((await nic.form(`/nucleo/membros/${gusId}/remover`, {})).status).toBe(403);
    expect((await nic.form("/nucleo/convites", { role: "admin" })).status).toBe(403);
    expect((await nic.form("/nucleo/nome", { name: "Hacked" })).status).toBe(403);

    // Gus is the only admin: leaving is refused, so is self-demotion via the role route.
    let r = await gus.form("/nucleo/sair", {});
    expect(r.headers.get("location")).toContain("nico");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM nucleo_members").first<{ n: number }>())!.n).toBe(2);
    r = await gus.form(`/nucleo/membros/${gusId}/papel`, { role: "membro" });
    expect(await (await gus.fetch("/nucleo")).text()).toContain("admin");

    // Promote Nic, then Gus can leave; Nic now sees the ledger alone.
    await gus.form(`/nucleo/membros/${nicId}/papel`, { role: "admin" });
    r = await gus.form("/nucleo/sair", {});
    expect(r.headers.get("location")).toContain("/mais");
    expect((await gus.fetch("/")).headers.get("location")).toBe("/comecar");
    expect((await nic.fetch("/categorias")).status).toBe(200);

    // Admin removes a member: their pointer clears and they land on /comecar.
    const code = await invite(nic, "Casa");
    const third = await newPerson(gus, "third@example.com", "third-phone");
    await third.form("/nucleos/entrar", { code });
    const thirdId = (await env.DB.prepare("SELECT id FROM users WHERE email = 'third@example.com'").first<{ id: number }>())!.id;
    await nic.form(`/nucleo/membros/${thirdId}/remover`, {});
    expect((await third.fetch("/")).headers.get("location")).toBe("/comecar");
  });

  it("a user in two núcleos switches between them; switching to a foreign one is not found", async () => {
    const gus = await appAdmin("Casa");
    const ana = await newPerson(gus, "ana@example.com", "ana-phone");
    await ana.form("/nucleos", { name: "Ana" });
    await ana.form("/nova", { kind: "out", amount: "7,00", date: "2026-10-05", category_id: "", payee: "Só da Ana" });
    await ana.form("/nucleos/entrar", { code: await invite(gus, "Casa") });
    const casa = await nucleoIdByName("Casa");
    const anaN = await nucleoIdByName("Ana");

    // Joining made Casa current.
    let home = await (await ana.fetch("/?mes=2026-10")).text();
    expect(home).toContain("Casa");
    expect(home).not.toContain("Só da Ana");
    // Back to her own.
    expect((await ana.form(`/nucleos/${anaN}/ativar`, {})).headers.get("location")).toBe("/");
    home = await (await ana.fetch("/?mes=2026-10")).text();
    expect(home).toContain("Só da Ana");
    // Gus is not a member of Ana.
    expect((await gus.form(`/nucleos/${anaN}/ativar`, {})).status).toBe(404);
    expect((await gus.fetch("/?mes=2026-10")).status).toBe(200);
    expect(await (await gus.fetch("/?mes=2026-10")).text()).not.toContain("Só da Ana");
    // The Núcleo page lists the other núcleo with a switch button.
    const page = await (await ana.fetch("/nucleo")).text();
    expect(page).toContain("Trocar de núcleo");
    expect(page).toContain(`/nucleos/${casa}/ativar`);
  });
});
