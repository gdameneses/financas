import { totalsByMonth } from "../db";
import { addMonths, monthLabel } from "../lib/dates";
import { formatBRL } from "../lib/money";

export type TendenciaRow = {
  month: string;
  label: string;
  income: number;
  expense: number;
  net: number;
  net_ma3: number | null; // 3-month moving average of net
};

export type TendenciaReport = {
  from: string;
  to: string;
  rows: TendenciaRow[];
  avg_income: number;
  avg_expense: number;
  avg_net: number;
};

export async function buildTendencia(db: D1Database, nucleoId: number, toMonth: string, months = 12): Promise<TendenciaReport> {
  const fromMonth = addMonths(toMonth, -(months - 1));
  const totals = await totalsByMonth(db, nucleoId, fromMonth, toMonth);
  const byMonth = new Map(totals.map((t) => [t.month, t]));

  const rows: TendenciaRow[] = [];
  for (let i = 0; i < months; i++) {
    const month = addMonths(fromMonth, i);
    const t = byMonth.get(month);
    const income = t?.income ?? 0;
    const expense = t?.expense ?? 0;
    rows.push({ month, label: monthLabel(month), income, expense, net: income - expense, net_ma3: null });
  }
  for (let i = 2; i < rows.length; i++) {
    rows[i].net_ma3 = Math.round((rows[i].net + rows[i - 1].net + rows[i - 2].net) / 3);
  }
  // Averages only over months that have any data, so a fresh account isn't dragged to zero.
  const active = rows.filter((r) => r.income || r.expense);
  const avg = (f: (r: TendenciaRow) => number) =>
    active.length ? Math.round(active.reduce((a, r) => a + f(r), 0) / active.length) : 0;

  return {
    from: fromMonth,
    to: toMonth,
    rows,
    avg_income: avg((r) => r.income),
    avg_expense: avg((r) => r.expense),
    avg_net: avg((r) => r.net),
  };
}

export function tendenciaMarkdown(r: TendenciaReport): string {
  const sign = (n: number) => (n >= 0 ? "+" : "−") + formatBRL(Math.abs(n));
  return (
    [
      `# Tendência — ${monthLabel(r.from)} a ${monthLabel(r.to)}`,
      "",
      `Média mensal: entradas ${formatBRL(r.avg_income)} · saídas ${formatBRL(r.avg_expense)} · saldo ${sign(r.avg_net)}`,
      "",
      "| Mês | Entradas | Saídas | Saldo | Saldo (média 3m) |",
      "|---|---:|---:|---:|---:|",
      ...r.rows.map(
        (x) =>
          `| ${x.label} | ${formatBRL(x.income)} | ${formatBRL(x.expense)} | ${sign(x.net)} | ${x.net_ma3 === null ? "—" : sign(x.net_ma3)} |`,
      ),
    ].join("\n") + "\n"
  );
}
