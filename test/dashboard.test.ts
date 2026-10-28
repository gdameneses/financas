import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { Browser, nucleoIdByName, resetDb } from "./helpers";
import { ajustesTotal, cashBalance, totalsByCategory } from "../src/db";
import { debtPayoff, fimDoMes, proximosMeses } from "../src/lib/projecoes";
import { parsePeriod } from "../src/lib/dates";

beforeEach(resetDb);

const IP = "203.0.113.10";

async function admin(email = "admin@example.com", nucleo = "Casa"): Promise<Browser> {
  const b = new Browser(IP);
  await b.form("/acesso", { op: "request", email, name: `laptop-${email}` });
  await b.form("/login", { email, password: "senha-forte-123" });
  expect((await b.form("/nucleos", { name: nucleo })).status).toBe(302);
  return b;
}

const cat = async (nid: number, name: string, kind: "in" | "out") =>
  (await env.DB.prepare("SELECT id FROM categories WHERE nucleo_id = ? AND name = ? AND kind = ?").bind(nid, name, kind).first<{ id: number }>())!.id;

describe("ajuste de saldo", () => {
  it("counts in the balance and cash, stays out of category totals", async () => {
    const b = await admin();
    const nid = await nucleoIdByName("Casa");
    await b.form("/nova", { kind: "out", amount: "100,00", date: "2026-10-05", category_id: String(await cat(nid, "Mercado", "out")) });
    await b.form("/nova", { kind: "out", amount: "30,00", date: "2026-10-06", category_id: String(await cat(nid, "Ajuste de saldo", "out")) });
    const totals = await totalsByCategory(env.DB, nid, "2026-10");
    expect(totals.map((t) => t.name)).toEqual(["Mercado"]);
    expect(await ajustesTotal(env.DB, nid, "2026-10")).toEqual({ in: 0, out: 3000 });
    expect(await cashBalance(env.DB, nid, "2026-10-31")).toBe(-13000);
    // the home shows the adjustment beside income and expense
    const page = await (await b.fetch("/?mes=2026-10")).text();
    expect(page).toContain("ajustes");
  });

  it("never gets a planning cap", async () => {
    const b = await admin();
    const nid = await nucleoIdByName("Casa");
    const aj = await cat(nid, "Ajuste de saldo", "out");
    expect(await (await b.fetch("/planejamento?mes=2026-10")).text()).not.toContain(`cap_${aj}`);
    await b.form("/planejamento?mes=2026-10", { [`cap_${aj}`]: "500" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM budgets WHERE category_id = ?").bind(aj).first<{ n: number }>()).toEqual({ n: 0 });
  });
});

describe("período", () => {
  it("parses a by-hand range and falls back to the month on bad input", () => {
    expect(parsePeriod({ de: "2026-10-01", ate: "2026-10-15" })).toEqual({ kind: "periodo", from: "2026-10-01", to: "2026-10-15" });
    expect(parsePeriod({ de: "2026-10-15", ate: "2026-10-01", mes: "2026-09" })).toMatchObject({ kind: "mes", month: "2026-09" });
    expect(parsePeriod({ de: "lixo", ate: "2026-10-01", mes: "2026-09" }).kind).toBe("mes");
  });

  it("filters the list to the range", async () => {
    const b = await admin();
    await b.form("/nova", { kind: "out", amount: "1", date: "2026-10-02", category_id: "", payee: "Dentro" });
    await b.form("/nova", { kind: "out", amount: "1", date: "2026-10-20", category_id: "", payee: "Fora" });
    const page = await (await b.fetch("/transacoes?de=2026-10-01&ate=2026-10-10")).text();
    expect(page).toContain("Dentro");
    expect(page).not.toContain("Fora");
  });
});

describe("dívidas", () => {
  it("admin registers and edits a debt; the balance only changes by hand", async () => {
    const b = await admin();
    let r = await b.form("/dividas/nova", { name: "Carro", creditor: "Banco", balance: "10.000,00", installment: "1.000,00", due_day: "10", interest: "1,5" });
    expect(r.status).toBe(302);
    const d = await env.DB.prepare("SELECT * FROM debts").first<{ id: number; balance_cents: number; interest_bp: number }>();
    expect(d).toMatchObject({ balance_cents: 1_000_000, interest_bp: 150 });
    expect(await (await b.fetch("/dividas")).text()).toContain("termina em");
    r = await b.form(`/dividas/${d!.id}`, { name: "Carro", balance: "9.000,00", installment: "1.000,00" });
    expect((await env.DB.prepare("SELECT balance_cents FROM debts").first<{ balance_cents: number }>())!.balance_cents).toBe(900_000);
  });

  it("another núcleo's debt is not found", async () => {
    const a = await admin();
    await a.form("/dividas/nova", { name: "Carro", balance: "100", installment: "10" });
    const id = (await env.DB.prepare("SELECT id FROM debts").first<{ id: number }>())!.id;
    // same person, now working in a second núcleo they also administer
    expect((await a.form("/nucleos", { name: "Outra" })).status).toBe(302);
    expect((await a.fetch(`/dividas/${id}`)).status).toBe(404);
    expect((await a.form(`/dividas/${id}/excluir`, {})).status).toBe(404);
    expect(await (await a.fetch("/dividas")).text()).not.toContain("Carro");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM debts").first<{ n: number }>()).toEqual({ n: 1 });
  });
});

describe("projeções", () => {
  const now = new Date("2026-10-15T15:00:00Z");

  it("payoff: no interest, with interest, and an installment that never catches up", () => {
    expect(debtPayoff({ balance_cents: 1000, installment_cents: 300, interest_bp: null }, now)).toEqual({ status: "termina", months: 4, end_month: "2027-02", interest: 0 });
    const p = debtPayoff({ balance_cents: 100_000, installment_cents: 10_000, interest_bp: 100 }, now);
    expect(p.status === "termina" && p.months === 11 && p.interest > 0).toBe(true);
    expect(debtPayoff({ balance_cents: 100_000, installment_cents: 1_000, interest_bp: 100 }, now)).toEqual({ status: "nunca", reason: "parcela não cobre os juros" });
    expect(debtPayoff({ balance_cents: 0, installment_cents: 1_000, interest_bp: null }, now)).toEqual({ status: "quitada" });
  });

  it("end of month: continuous spend extrapolated, fixed spend kept", () => {
    const totals = [
      { category_id: 1, name: "Mercado", icon: "", color: "", kind: "out" as const, total: 15_000, count: 3 },
      { category_id: 2, name: "Moradia", icon: "", color: "", kind: "out" as const, total: 200_000, count: 1 },
      { category_id: 3, name: "Salário", icon: "", color: "", kind: "in" as const, total: 500_000, count: 1 },
    ];
    const f = fimDoMes(totals, [{ id: 1, pace: "continuo" }, { id: 2, pace: "fixo" }], { in: 0, out: 1_000 }, now);
    expect(f.expense_projected).toBe(31_000 + 200_000); // 150 × 31/15 + rent as paid
    expect(f.balance_projected).toBe(500_000 - 231_000 - 1_000);
  });

  it("next months add the average result and free a finished debt's installment", () => {
    const fim = { balance: 0, balance_projected: 0 };
    const history = [
      { month: "2026-07", income: 100, expense: 0 },
      { month: "2026-08", income: 300, expense: 0 },
      { month: "2026-09", income: 200, expense: 0 },
    ];
    const r = proximosMeses(1_000, fim, history, [{ balance_cents: 50, installment_cents: 50, interest_bp: null }], 3, now);
    expect(r.avg_net).toBe(200);
    // the debt ends in month 1; its installment is freed from month 2 on
    expect(r.points.map((p) => p.balance)).toEqual([1_000, 1_200, 1_450, 1_700]);
  });
});

describe("planejamento anual", () => {
  it("renders planned and spent per month", async () => {
    const b = await admin();
    const nid = await nucleoIdByName("Casa");
    const mercado = await cat(nid, "Mercado", "out");
    await b.form("/planejamento?mes=2026-03", { [`cap_${mercado}`]: "500" });
    await b.form("/nova", { kind: "out", amount: "600,00", date: "2026-03-05", category_id: String(mercado) });
    const page = await (await b.fetch("/planejamento/anual?ano=2026")).text();
    expect(page).toContain("Mercado");
    expect(page).toMatch(/R\$\s600,00/); // Intl puts a no-break space after R$
    expect(page).toContain('class="over');
  });
});
