import { totalsByCategory, listTransactions, type Kind } from "../db";
import { addMonths, monthLabel } from "../lib/dates";
import { formatBRL, pct } from "../lib/money";

export type MensalLine = {
  category_id: number | null;
  name: string;
  icon: string;
  color: string;
  total: number;
  count: number;
  share_pct: number;
  prev_total: number;
  delta: number;
};

export type MensalReport = {
  month: string;
  label: string;
  income: number;
  expense: number;
  net: number;
  prev: { month: string; income: number; expense: number; net: number };
  out: MensalLine[];
  in: MensalLine[];
  top_payees: { payee: string; total: number; count: number }[];
};

export async function buildMensal(db: D1Database, month: string): Promise<MensalReport> {
  const prevMonth = addMonths(month, -1);
  const [cur, prev, txs] = await Promise.all([
    totalsByCategory(db, month),
    totalsByCategory(db, prevMonth),
    listTransactions(db, { month }),
  ]);

  const sum = (rows: typeof cur, kind: Kind) => rows.filter((r) => r.kind === kind).reduce((a, r) => a + r.total, 0);
  const income = sum(cur, "in");
  const expense = sum(cur, "out");
  const prevIncome = sum(prev, "in");
  const prevExpense = sum(prev, "out");

  const lines = (kind: Kind): MensalLine[] =>
    cur
      .filter((r) => r.kind === kind)
      .map((r) => {
        const p = prev.find((x) => x.kind === kind && x.category_id === r.category_id);
        const prevTotal = p?.total ?? 0;
        return {
          category_id: r.category_id,
          name: r.name ?? "Sem categoria",
          icon: r.icon ?? "❔",
          color: r.color ?? "#9ca3af",
          total: r.total,
          count: r.count,
          share_pct: pct(r.total, kind === "in" ? income : expense),
          prev_total: prevTotal,
          delta: r.total - prevTotal,
        };
      });

  const payees = new Map<string, { total: number; count: number }>();
  for (const t of txs) {
    if (t.kind !== "out" || !t.payee) continue;
    const key = t.payee.trim();
    const cur = payees.get(key) ?? { total: 0, count: 0 };
    payees.set(key, { total: cur.total + t.amount_cents, count: cur.count + 1 });
  }
  const top_payees = [...payees.entries()]
    .map(([payee, v]) => ({ payee, ...v }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  return {
    month,
    label: monthLabel(month),
    income,
    expense,
    net: income - expense,
    prev: { month: prevMonth, income: prevIncome, expense: prevExpense, net: prevIncome - prevExpense },
    out: lines("out"),
    in: lines("in"),
    top_payees,
  };
}

export function mensalMarkdown(r: MensalReport): string {
  const sign = (n: number) => (n >= 0 ? "+" : "−") + formatBRL(Math.abs(n));
  const lines = [
    `# Relatório mensal — ${r.label}`,
    "",
    `| | ${r.label} | ${monthLabel(r.prev.month)} | Δ |`,
    "|---|---:|---:|---:|",
    `| Entradas | ${formatBRL(r.income)} | ${formatBRL(r.prev.income)} | ${sign(r.income - r.prev.income)} |`,
    `| Saídas | ${formatBRL(r.expense)} | ${formatBRL(r.prev.expense)} | ${sign(r.expense - r.prev.expense)} |`,
    `| Saldo | ${sign(r.net)} | ${sign(r.prev.net)} | ${sign(r.net - r.prev.net)} |`,
    "",
    "## Saídas por categoria",
    "",
    "| Categoria | Total | % | Qtd | Mês anterior | Δ |",
    "|---|---:|---:|---:|---:|---:|",
    ...r.out.map(
      (l) => `| ${l.name} | ${formatBRL(l.total)} | ${l.share_pct}% | ${l.count} | ${formatBRL(l.prev_total)} | ${sign(l.delta)} |`,
    ),
    "",
    "## Entradas por categoria",
    "",
    "| Categoria | Total | % | Qtd | Mês anterior | Δ |",
    "|---|---:|---:|---:|---:|---:|",
    ...r.in.map(
      (l) => `| ${l.name} | ${formatBRL(l.total)} | ${l.share_pct}% | ${l.count} | ${formatBRL(l.prev_total)} | ${sign(l.delta)} |`,
    ),
  ];
  if (r.top_payees.length) {
    lines.push("", "## Maiores destinos (saídas)", "", "| Destino | Total | Qtd |", "|---|---:|---:|");
    lines.push(...r.top_payees.map((p) => `| ${p.payee} | ${formatBRL(p.total)} | ${p.count} |`));
  }
  return lines.join("\n") + "\n";
}
