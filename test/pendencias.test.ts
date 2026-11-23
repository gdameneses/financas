import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { Browser, categoryId, latestInvite, nucleoIdByName, resetDb } from "./helpers";

beforeEach(resetDb);

const ADMIN = "admin@example.com";
const IP = "203.0.113.10";

async function appAdmin(nucleo = "Casa"): Promise<Browser> {
  const b = new Browser(IP);
  await b.form("/acesso", { op: "request", email: ADMIN, name: "laptop" });
  await b.form("/login", { email: ADMIN, password: "senha-forte-123" });
  expect((await b.form("/nucleos", { name: nucleo })).status).toBe(302);
  return b;
}

async function newPerson(admin: Browser, email: string, device: string): Promise<Browser> {
  const b = new Browser(IP);
  await b.form("/acesso", { op: "request", email, name: device });
  const id = (await env.DB.prepare("SELECT id FROM devices WHERE name = ?").bind(device).first<{ id: number }>())!.id;
  await admin.form(`/acessos/aparelhos/${id}/aprovar`, { allow_ip: "1" });
  expect((await b.form("/login", { email, password: "senha-forte-123" })).headers.get("location")).toBe("/");
  return b;
}

async function seed(nid: number, p: { ref?: string | null; kind?: "in" | "out"; cents?: number; payee?: string; cat?: number | null } = {}): Promise<number> {
  const r = await env.DB.prepare(
    `INSERT INTO pendencias (nucleo_id, conta, date, hora, amount_cents, kind, descricao, ref, sugestao_payee, sugestao_category_id)
     VALUES (?, 'Banco Teste', '2026-11-08', '12:11', ?, ?, 'Pix enviado', ?, ?, ?)`,
  )
    .bind(nid, p.cents ?? 30000, p.kind ?? "out", p.ref === undefined ? "ref-1" : p.ref, p.payee ?? "", p.cat ?? null)
    .run();
  return Number(r.meta.last_row_id);
}

const pend = (id: number) => env.DB.prepare("SELECT * FROM pendencias WHERE id = ?").bind(id).first<Record<string, unknown>>();
const ignored = async (ref: string) => !!(await env.DB.prepare("SELECT 1 FROM import_ignored WHERE ref = ?").bind(ref).first());

describe("pendências", () => {
  it("is for núcleo admins: Mais and home show the open count, members get 403", async () => {
    const gus = await appAdmin();
    const nid = await nucleoIdByName("Casa");
    await seed(nid);
    expect(await (await gus.fetch("/mais")).text()).toMatch(/href="\/pendencias"[\s\S]*1 em aberto/);
    expect(await (await gus.fetch("/")).text()).toContain("1 linha de extrato");
    const page = await gus.fetch("/pendencias");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Pix enviado");

    const nic = await newPerson(gus, "nic@example.com", "nic-phone");
    expect((await gus.form("/nucleo/convites", { role: "membro" })).status).toBe(302);
    await nic.form("/nucleos/entrar", { code: await latestInvite(nid) });
    expect((await nic.fetch("/pendencias")).status).toBe(403);
    expect(await (await nic.fetch("/")).text()).not.toContain("linha de extrato");
  });

  it("lançar creates the entry with the statement ref; reabrir removes exactly that entry", async () => {
    const gus = await appAdmin();
    const nid = await nucleoIdByName("Casa");
    const cat = await categoryId(nid, "Restaurantes");
    const id = await seed(nid, { ref: "ref-lancar" });

    let r = await gus.form(`/pendencias/${id}`, { op: "lancar", resposta: "jantar", payee: "Pizzaria", category_id: String(cat) });
    expect(r.status).toBe(302);
    const tx = await env.DB.prepare("SELECT * FROM transactions WHERE import_ref = 'ref-lancar'").first<Record<string, unknown>>();
    expect(tx).toMatchObject({ date: "2026-11-08", amount_cents: 30000, kind: "out", category_id: cat, payee: "Pizzaria", note: "jantar", import_desc: null });
    expect(await pend(id)).toMatchObject({ status: "lancada", transaction_id: tx!.id, resposta: "jantar" });
    expect((await pend(id))!.resolved_by).not.toBeNull();

    // Deciding twice does nothing.
    await gus.form(`/pendencias/${id}`, { op: "lancar" });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM transactions").first<{ n: number }>())!.n).toBe(1);

    // A category of the other kind is refused.
    const id2 = await seed(nid, { ref: "ref-2" });
    r = await gus.form(`/pendencias/${id2}`, { op: "lancar", category_id: String(await categoryId(nid, "Salário")) });
    expect(r.status).toBe(400);

    r = await gus.form(`/pendencias/${id}/reabrir`, {});
    expect(r.status).toBe(302);
    expect(await env.DB.prepare("SELECT 1 FROM transactions WHERE import_ref = 'ref-lancar'").first()).toBeNull();
    expect(await pend(id)).toMatchObject({ status: "aberta", transaction_id: null, resolved_by: null, resposta: "jantar" });
  });

  it("a ref already on another entry is not copied again", async () => {
    const gus = await appAdmin();
    const nid = await nucleoIdByName("Casa");
    await env.DB.prepare("INSERT INTO transactions (nucleo_id, date, amount_cents, kind, payee, import_ref) VALUES (?, '2026-11-08', 100, 'out', 'x', 'ref-dup')").bind(nid).run();
    const id = await seed(nid, { ref: "ref-dup" });
    await gus.form(`/pendencias/${id}`, { op: "lancar" });
    const t = await env.DB.prepare("SELECT import_ref, payee FROM transactions WHERE amount_cents = 30000").first<Record<string, unknown>>();
    expect(t).toEqual({ import_ref: null, payee: "Pix enviado" });
  });

  it("entre nossas contas and ignorar record the ref for the next import; reabrir clears it", async () => {
    const gus = await appAdmin();
    const nid = await nucleoIdByName("Casa");
    const a = await seed(nid, { ref: "ref-interna" });
    const b = await seed(nid, { ref: "ref-ignorar" });

    await gus.form(`/pendencias/${a}`, { op: "interna", resposta: "foi para a outra conta" });
    await gus.form(`/pendencias/${b}`, { op: "ignorar" });
    expect(await pend(a)).toMatchObject({ status: "interna", resposta: "foi para a outra conta" });
    expect(await pend(b)).toMatchObject({ status: "ignorada" });
    expect(await ignored("ref-interna")).toBe(true);
    expect(await ignored("ref-ignorar")).toBe(true);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM transactions").first<{ n: number }>())!.n).toBe(0);

    await gus.form(`/pendencias/${a}/reabrir`, {});
    expect(await ignored("ref-interna")).toBe(false);
    expect(await pend(a)).toMatchObject({ status: "aberta" });
  });

  it("salvar nota keeps it open", async () => {
    const gus = await appAdmin();
    const id = await seed(await nucleoIdByName("Casa"));
    await gus.form(`/pendencias/${id}`, { op: "nota", resposta: "acho que foi pro Gus" });
    expect(await pend(id)).toMatchObject({ status: "aberta", resposta: "acho que foi pro Gus" });
    expect(await (await gus.fetch("/pendencias")).text()).toContain("acho que foi pro Gus");
  });

  it("ids from another núcleo are not found and nothing changes", async () => {
    const gus = await appAdmin("Casa");
    const ana = await newPerson(gus, "ana@example.com", "ana-phone");
    expect((await ana.form("/nucleos", { name: "Ana" })).status).toBe(302);
    const id = await seed(await nucleoIdByName("Casa"), { ref: "ref-casa" });

    expect((await ana.form(`/pendencias/${id}`, { op: "lancar" })).status).toBe(404);
    expect((await ana.form(`/pendencias/${id}`, { op: "ignorar" })).status).toBe(404);
    expect((await ana.form(`/pendencias/${id}/reabrir`, {})).status).toBe(404);
    expect(await (await ana.fetch("/pendencias")).text()).not.toContain("Pix enviado");
    expect(await pend(id)).toMatchObject({ status: "aberta" });
    expect(await ignored("ref-casa")).toBe(false);
  });
});
