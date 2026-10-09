import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createTransaction, setBudget, type Transaction } from "../src/db";
import { buildMensal } from "../src/reports/mensal";
import { buildTendencia } from "../src/reports/tendencia";
import { detectRecorrentes } from "../src/reports/recorrentes";
import { buildOrcamento } from "../src/reports/orcamento";
import { parseBRL, formatBRL } from "../src/lib/money";
import { resetDb } from "./helpers";

const tx = (date: string, amount_cents: number, payee: string, kind: "in" | "out" = "out", category_id: number | null = null): Transaction => ({
  id: 0, date, amount_cents, kind, category_id, payee, note: "", created_at: "", updated_at: "",
});

describe("money", () => {
  it("parses BR and US styles", () => {
    expect(parseBRL("1.234,56")).toBe(123456);
    expect(parseBRL("1234.56")).toBe(123456);
    expect(parseBRL("R$ 12")).toBe(1200);
    expect(parseBRL("12,5")).toBe(1250);
    expect(parseBRL("abc")).toBeNull();
  });
  it("formats BRL", () => {
    expect(formatBRL(123456).replace(/ /g, " ")).toBe("R$ 1.234,56");
  });
});

describe("recorrentes", () => {
  it("detects monthly items within ±5% and flags novo/sumido", () => {
    const txs = [
      // 4150 is within ±5% of 3990 (199.5); a 200 step would split the cluster.
      tx("2026-07-05", 3990, "Netflix"), tx("2026-08-05", 3990, "Netflix"), tx("2026-09-06", 4150, "netflix"), tx("2026-10-05", 4150, "Netflix"),
      tx("2026-07-10", 10000, "Academia"), tx("2026-08-10", 10000, "Academia"), tx("2026-09-10", 10000, "Academia"), // missing in Oct
      tx("2026-08-01", 5000, "Spotify"), tx("2026-09-01", 5000, "Spotify"), tx("2026-10-01", 5000, "Spotify"), // too few before Oct? no: 3 occurrences, first in Aug
      tx("2026-10-02", 2000, "Padaria"), tx("2026-10-09", 2000, "Padaria"), tx("2026-10-16", 2000, "Padaria"), // weekly: not monthly
      tx("2026-07-20", 30000, "Aluguel"), tx("2026-08-20", 90000, "Aluguel"), // amounts too different
    ];
    const r = detectRecorrentes(txs, "2026-10");
    const by = Object.fromEntries(r.items.map((i) => [i.payee.toLowerCase(), i]));
    expect(by.netflix.status).toBe("ativo");
    expect(by.netflix.occurrences).toBe(4);
    expect(by.academia.status).toBe("sumido");
    expect(by.spotify.status).toBe("ativo");
    expect(by.padaria).toBeUndefined();
    expect(by.aluguel).toBeUndefined();
    expect(r.monthly_total).toBe(by.netflix.amount + by.spotify.amount);
  });

  it("marks a series that starts this month as novo", () => {
    // 3 occurrences all inside the report month cannot be monthly; novo needs ≥3 monthly hits
    // whose first is in the month — only possible with backdated data, so assert the rule directly.
    const txs = [tx("2026-10-01", 1000, "X"), tx("2026-10-30", 1000, "X"), tx("2026-11-29", 1000, "X")];
    expect(detectRecorrentes(txs, "2026-10").items[0]?.status).toBe("novo");
  });
});

describe("db-backed reports", () => {
  let mercado: number;
  let salario: number;
  beforeAll(async () => {
    await resetDb();
    mercado =(await env.DB.prepare("SELECT id FROM categories WHERE name = 'Mercado'").first<{ id: number }>())!.id;
    salario = (await env.DB.prepare("SELECT id FROM categories WHERE name = 'Salário'").first<{ id: number }>())!.id;
    await createTransaction(env.DB, { date: "2026-09-10", amount_cents: 50000, kind: "out", category_id: mercado, payee: "A", note: "" });
    await createTransaction(env.DB, { date: "2026-10-03", amount_cents: 30000, kind: "out", category_id: mercado, payee: "A", note: "" });
    await createTransaction(env.DB, { date: "2026-10-04", amount_cents: 20000, kind: "out", category_id: null, payee: "B", note: "" });
    await createTransaction(env.DB, { date: "2026-10-01", amount_cents: 500000, kind: "in", category_id: salario, payee: "", note: "" });
    await setBudget(env.DB, mercado, "2026-10", 40000);
  });

  it("mensal totals, shares and delta vs previous month", async () => {
    const r = await buildMensal(env.DB, "2026-10");
    expect(r.income).toBe(500000);
    expect(r.expense).toBe(50000);
    expect(r.net).toBe(450000);
    const m = r.out.find((l) => l.category_id === mercado)!;
    expect(m.share_pct).toBe(60);
    expect(m.prev_total).toBe(50000);
    expect(m.delta).toBe(-20000);
    expect(r.out.find((l) => l.category_id === null)!.name).toBe("Sem categoria");
    expect(r.top_payees[0]).toEqual({ payee: "A", total: 30000, count: 1 });
  });

  it("tendencia pads 12 months and averages only active ones", async () => {
    const r = await buildTendencia(env.DB, "2026-10");
    expect(r.rows).toHaveLength(12);
    expect(r.rows[0].month).toBe("2025-11");
    expect(r.rows[11].net).toBe(450000);
    expect(r.avg_expense).toBe(50000); // (50000 + 50000) / 2 active months
  });

  it("orcamento projects spend and lists unbudgeted categories", async () => {
    const r = await buildOrcamento(env.DB, "2026-10", new Date("2026-10-10T15:00:00Z"));
    const m = r.lines.find((l) => l.category_id === mercado)!;
    expect(m.spent).toBe(30000);
    expect(m.used_pct).toBe(75);
    expect(m.projected).toBe(Math.round(30000 * (31 / 10)));
    expect(m.over).toBe(false);
    // Past month: projection equals spend.
    const past = await buildOrcamento(env.DB, "2026-09", new Date("2026-10-10T15:00:00Z"));
    expect(past.unbudgeted[0]).toEqual({ name: "Mercado", icon: "🛒", spent: 50000 });
  });
});
