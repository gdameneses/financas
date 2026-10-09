import { listBudgets, listCategories, totalsByCategory } from "../db";
import { currentMonth, daysInMonth, monthLabel, todayISO } from "../lib/dates";
import { formatBRL, pct } from "../lib/money";

export type OrcamentoLine = {
  category_id: number;
  name: string;
  icon: string;
  color: string;
  cap: number;
  spent: number;
  remaining: number;
  used_pct: number;
  projected: number; // spent / days_elapsed × days_in_month (past months: = spent)
  over: boolean;
};

export type OrcamentoReport = {
  month: string;
  label: string;
  days_elapsed: number;
  days_in_month: number;
  total_cap: number;
  total_spent: number;
  total_projected: number;
  lines: OrcamentoLine[];
  unbudgeted: { name: string; icon: string; spent: number }[];
};

export async function buildOrcamento(db: D1Database, month: string, now = new Date()): Promise<OrcamentoReport> {
  const [budgets, cats, totals] = await Promise.all([listBudgets(db, month), listCategories(db), totalsByCategory(db, month)]);
  const dim = daysInMonth(month);
  const cur = currentMonth(now);
  const elapsed = month < cur ? dim : month > cur ? 0 : Number(todayISO(now).slice(8, 10));
  const factor = elapsed === 0 ? 0 : dim / elapsed;

  const spentBy = new Map<number, number>();
  for (const t of totals) if (t.kind === "out" && t.category_id !== null) spentBy.set(t.category_id, t.total);

  const lines: OrcamentoLine[] = [];
  for (const b of budgets) {
    const c = cats.find((x) => x.id === b.category_id);
    if (!c) continue;
    const spent = spentBy.get(b.category_id) ?? 0;
    const projected = month < cur ? spent : Math.round(spent * factor);
    lines.push({
      category_id: c.id,
      name: c.name,
      icon: c.icon,
      color: c.color,
      cap: b.cap_cents,
      spent,
      remaining: b.cap_cents - spent,
      used_pct: pct(spent, b.cap_cents),
      projected,
      over: spent > b.cap_cents,
    });
  }
  lines.sort((a, b) => b.used_pct - a.used_pct);

  const budgeted = new Set(budgets.map((b) => b.category_id));
  const unbudgeted = cats
    .filter((c) => c.kind === "out" && !budgeted.has(c.id) && (spentBy.get(c.id) ?? 0) > 0)
    .map((c) => ({ name: c.name, icon: c.icon, spent: spentBy.get(c.id)! }))
    .sort((a, b) => b.spent - a.spent);

  return {
    month,
    label: monthLabel(month),
    days_elapsed: elapsed,
    days_in_month: dim,
    total_cap: lines.reduce((a, l) => a + l.cap, 0),
    total_spent: lines.reduce((a, l) => a + l.spent, 0),
    total_projected: lines.reduce((a, l) => a + l.projected, 0),
    lines,
    unbudgeted,
  };
}

export function orcamentoMarkdown(r: OrcamentoReport): string {
  const out = [
    `# Orçamento — ${r.label} (dia ${r.days_elapsed}/${r.days_in_month})`,
    "",
    `Teto total ${formatBRL(r.total_cap)} · gasto ${formatBRL(r.total_spent)} · projeção ${formatBRL(r.total_projected)}`,
    "",
    "| Categoria | Teto | Gasto | % | Restante | Projeção |",
    "|---|---:|---:|---:|---:|---:|",
    ...r.lines.map(
      (l) =>
        `| ${l.name}${l.over ? " ⚠️" : ""} | ${formatBRL(l.cap)} | ${formatBRL(l.spent)} | ${l.used_pct}% | ${formatBRL(l.remaining)} | ${formatBRL(l.projected)} |`,
    ),
  ];
  if (r.unbudgeted.length) {
    out.push("", "## Sem teto definido", "", "| Categoria | Gasto |", "|---|---:|");
    out.push(...r.unbudgeted.map((u) => `| ${u.name} | ${formatBRL(u.spent)} |`));
  }
  return out.join("\n") + "\n";
}
