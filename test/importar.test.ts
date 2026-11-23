import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { Browser, categoryId, nucleoIdByName, resetDb } from "./helpers";

beforeEach(resetDb);

const ADMIN = "admin@example.com";

async function admin(): Promise<Browser> {
  const b = new Browser("203.0.113.10");
  await b.form("/acesso", { op: "request", email: ADMIN, name: "laptop" });
  await b.form("/login", { email: ADMIN, password: "senha-forte-123" });
  expect((await b.form("/nucleos", { name: "Casa" })).status).toBe(302);
  return b;
}

// rows 0..5: market, pharmacy, investment, transfer from "Maria", a transfer and its reversal
const CSV = `conta,titular,data,hora,descricao,valor,saldo,id
Nubank,,2026-11-03,,Transferência enviada pelo Pix - MERCADO EXEMPLO - 00.000.000/0001-00 - BANCO X (0001) Agência: 1 Conta: 2-3,-51.46,,aaaa-1
Nubank,,2026-11-05,,Compra no débito - FARMACIA EXEMPLO,-27.99,,aaaa-2
Nubank,,2026-11-08,,Resgate RDB,350.00,,aaaa-3
Nubank,,2026-11-09,,Transferência recebida pelo Pix - Maria Teste da Silva - doc - NEON (0536) Agência: 655 Conta: 1-8,500.00,,aaaa-4
Nubank,,2026-11-18,,Transferência enviada pelo Pix - Joao Teste Souza - doc - BANCO X (0001) Agência: 1 Conta: 9-9,-140.00,,aaaa-5
Nubank,,2026-11-18,,Estorno - Transferência enviada pelo Pix - Joao Teste Souza - doc - BANCO X (0001) Agência: 1 Conta: 9-9,140.00,,aaaa-5
`;

const txs = async () =>
  (await env.DB.prepare("SELECT date, amount_cents, kind, category_id, payee, import_ref, import_desc FROM transactions ORDER BY date, id").all<Record<string, unknown>>()).results;

/** The form exactly as the review page shows it: every row on screen (r), ticked or not (i). */
async function defaults(b: Browser, csv = CSV): Promise<Record<string, string>> {
  const page = await (await b.form("/importar/revisar", { csv })).text();
  const out: Record<string, string> = {};
  for (const m of page.matchAll(/name="r(\d+)" value="1"/g)) out[`r${m[1]}`] = "1";
  for (const m of page.matchAll(/<input type="checkbox" name="i(\d+)" value="1"( checked="")?/g)) if (m[2]) out[`i${m[1]}`] = "1";
  return out;
}
const without = (o: Record<string, string>, key: string) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

describe("importar extrato", () => {
  it("is for núcleo admins: the menu links it and the page opens", async () => {
    const b = await admin();
    expect(await (await b.fetch("/mais")).text()).toContain('href="/importar"');
    const r = await b.fetch("/importar");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("Importar extrato");
  });

  it("converts files to the app's CSV, only for the page's own script", async () => {
    const b = await admin();
    const body = JSON.stringify({ arquivos: [{ nome: "nu.csv", conteudo: "Data,Valor,Identificador,Descrição\n05/11/2026,-27.99,aaaa-2,Compra no débito - FARMACIA EXEMPLO\n" }] });
    const semHeader = await b.fetch("/importar/converter", { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(semHeader.status).toBe(400);
    const r = await b.fetch("/importar/converter", { method: "POST", headers: { "content-type": "application/json", "x-fetch": "1" }, body });
    expect(r.status).toBe(200);
    const j = await r.json<{ csv: string; linhas: number; fontes: { formato: string }[] }>();
    expect(j.linhas).toBe(1);
    expect(j.fontes[0].formato).toBe("Nubank CSV");
    expect(j.csv).toContain("Nubank,,2026-11-05,,Compra no débito - FARMACIA EXEMPLO,-27.99,,aaaa-2");
    const ruim = await b.fetch("/importar/converter", {
      method: "POST",
      headers: { "content-type": "application/json", "x-fetch": "1" },
      body: JSON.stringify({ arquivos: [{ nome: "x.txt", conteudo: "nada" }] }),
    });
    expect(ruim.status).toBe(400);
    expect((await ruim.json<{ error: string }>()).error).toMatch(/^x\.txt: formato não reconhecido/);
  });

  it("an unreadable statement comes back to the first page with the reason", async () => {
    const b = await admin();
    const r = await b.form("/importar/revisar", { csv: "isto não é um extrato" });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("formato não reconhecido");
  });

  it("the review lists every row with its possible duplicate; only what looks new comes ticked", async () => {
    const b = await admin();
    const nid = await nucleoIdByName("Casa");
    // typed in by hand two days after the pharmacy purchase
    await env.DB.prepare("INSERT INTO transactions (nucleo_id, date, amount_cents, kind, payee) VALUES (?, '2026-10-01', 100, 'out', 'Primeiro'), (?, '2026-11-07', 2799, 'out', 'Farmácia')").bind(nid, nid).run();
    await env.DB.prepare("INSERT INTO nucleo_titulares (nucleo_id, nome) VALUES (?, 'MARIA TESTE DA SILVA')").bind(nid).run();
    const page = await (await b.form("/importar/revisar", { csv: CSV })).text();
    for (const t of ["Lançamentos do extrato", "Entre contas do núcleo", "Investimentos", "Estornados"]) expect(page).toContain(t);
    expect(page).toContain("Já no app em 07/11: Farmácia");
    // date, name and one radio per category of the row's kind
    expect(page).toMatch(/<input type="date" name="d0" value="2026-11-03"/);
    expect(page).toMatch(/name="p0" value="MERCADO EXEMPLO"/);
    const mercado = await categoryId(nid, "Mercado");
    const salario = await categoryId(nid, "Salário");
    expect(page).toContain(`<input type="radio" name="c0" value="${mercado}"`);
    expect(page).not.toContain(`<input type="radio" name="c0" value="${salario}"`);
    expect(await defaults(b)).toEqual({ r0: "1", i0: "1", r1: "1", r2: "1", r3: "1", r4: "1", r5: "1" });
  });

  it("saving writes the ticked rows as edited, ties the duplicate, and a second import finds nothing new", async () => {
    const b = await admin();
    const nid = await nucleoIdByName("Casa");
    const mercado = await categoryId(nid, "Mercado");
    await env.DB.prepare("INSERT INTO transactions (nucleo_id, date, amount_cents, kind, payee) VALUES (?, '2026-10-01', 100, 'out', 'Primeiro'), (?, '2026-11-07', 2799, 'out', 'Farmácia')").bind(nid, nid).run();
    const fields = { ...without(await defaults(b), "i3"), p0: "Mercado do bairro", c0: String(mercado), d0: "2026-11-04", x3: "1" };
    const r = await b.form("/importar/confirmar", { csv: CSV, ...fields });
    expect(r.status).toBe(302);
    expect(decodeURIComponent(r.headers.get("location")!)).toBe("/importar?ok=1 importado, 1 já estava no app");
    expect((await txs()).slice(1)).toEqual([
      { date: "2026-11-04", amount_cents: 5146, kind: "out", category_id: mercado, payee: "Mercado do bairro", import_ref: "aaaa-1:-5146", import_desc: "MERCADO EXEMPLO" },
      { date: "2026-11-07", amount_cents: 2799, kind: "out", category_id: null, payee: "Farmácia", import_ref: "aaaa-2:-2799", import_desc: "FARMACIA EXEMPLO" },
    ]);
    // "é entre nossas contas" remembered the name
    expect((await env.DB.prepare("SELECT nome FROM nucleo_titulares").all()).results).toEqual([{ nome: "MARIA TESTE DA SILVA" }]);

    // rows 0 and 1 are "já importados" now (the edited date does not fool it): no field for them
    const again = await defaults(b);
    expect(again).toEqual({ r2: "1", r3: "1", r4: "1", r5: "1" });
    await b.form("/importar/confirmar", { csv: CSV, ...again });
    expect(await txs()).toHaveLength(3);
  });

  it("the same save sent twice imports once", async () => {
    const b = await admin();
    const fields = { csv: CSV, ...(await defaults(b)) };
    await b.form("/importar/confirmar", fields);
    await b.form("/importar/confirmar", fields);
    expect((await txs()).map((t) => t.import_ref)).toEqual(["aaaa-1:-5146", "aaaa-2:-2799", "aaaa-4:50000"]);
  });

  it("an unticked row stays out of the next import, and can still be brought back", async () => {
    const b = await admin();
    await b.form("/importar/confirmar", { csv: CSV, ...without(await defaults(b), "i0") });
    expect((await txs()).map((t) => t.import_ref)).not.toContain("aaaa-1:-5146");
    const next = await defaults(b);
    expect(next.r0).toBe("1");
    expect(next.i0).toBeUndefined();
    const page = await (await b.form("/importar/revisar", { csv: CSV })).text();
    expect(page).toContain("Ignorados antes");
    await b.form("/importar/confirmar", { csv: CSV, ...next, i0: "1" });
    expect((await txs()).map((t) => t.import_ref)).toContain("aaaa-1:-5146");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM import_ignored").first<{ n: number }>())!.n).toBe(0);
  });

  it("a row the form did not send is left alone, ticked or not", async () => {
    const b = await admin();
    await b.form("/importar/confirmar", { csv: CSV, i0: "1", r1: "1", i1: "1" });
    expect((await txs()).map((t) => t.import_ref)).toEqual(["aaaa-2:-2799"]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM import_ignored").first<{ n: number }>())!.n).toBe(0);
  });

  it("the next statement gets the name and category used last time for the same place", async () => {
    const b = await admin();
    const nid = await nucleoIdByName("Casa");
    const mercado = await categoryId(nid, "Mercado");
    await b.form("/importar/confirmar", { csv: CSV, ...(await defaults(b)), p0: "Mercado do bairro", c0: String(mercado) });
    const depois = `conta,titular,data,hora,descricao,valor,saldo,id\nNubank,,2026-12-02,,Compra no débito - MERCADO EXEMPLO,-80.00,,bbbb-1\n`;
    const page = await (await b.form("/importar/revisar", { csv: depois })).text();
    expect(page).toMatch(/name="p0" value="Mercado do bairro"/);
    expect(page).toContain(`<input type="radio" name="c0" value="${mercado}" checked=""`);
  });

  it("a category of the wrong kind or of another núcleo, or a broken date, is dropped instead of saved", async () => {
    const b = await admin();
    const nid = await nucleoIdByName("Casa");
    const salario = await categoryId(nid, "Salário");
    await b.form("/importar/confirmar", { csv: CSV, ...(await defaults(b)), c0: String(salario), c1: "999999", d1: "ontem" });
    const out = (await txs()).filter((t) => t.kind === "out");
    expect(out.map((t) => t.category_id)).toEqual([null, null]);
    expect(out[1].date).toBe("2026-11-05");
  });

  it("a statement's own holder is remembered on save", async () => {
    const b = await admin();
    const neon = `conta,titular,data,hora,descricao,valor,saldo,id\nNeon 1-8,MARIA TESTE DA SILVA,2026-11-09,10:00,PIX enviado para Maria Teste da Silva,-500.00,10.00,\n`;
    expect(await defaults(b, neon)).toEqual({ r0: "1" });
    await b.form("/importar/confirmar", { csv: neon, r0: "1" });
    expect(await txs()).toHaveLength(0);
    // now the other account's statement sees the same transfer as internal
    expect((await defaults(b)).i3).toBeUndefined();
    const page = await (await b.fetch("/importar")).text();
    expect(page).toContain("MARIA TESTE DA SILVA");
    await b.form("/importar/titulares/excluir", { nome: "MARIA TESTE DA SILVA" });
    expect((await defaults(b)).i3).toBe("1");
  });

  it("a member who is not a núcleo admin cannot import", async () => {
    const b = await admin();
    const nid = await nucleoIdByName("Casa");
    await env.DB.prepare("UPDATE nucleo_members SET role = 'membro' WHERE nucleo_id = ?").bind(nid).run();
    expect((await b.fetch("/importar")).status).toBe(403);
    expect((await b.form("/importar/confirmar", { csv: CSV, r0: "1", i0: "1" })).status).toBe(403);
    expect(await txs()).toHaveLength(0);
  });
});
