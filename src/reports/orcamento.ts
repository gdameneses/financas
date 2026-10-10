import { listBudgets, listCategories, totalsByCategory, type Pace } from "../db";
import { currentMonth, daysInMonth, monthLabel, todayISO } from "../lib/dates";
import { formatBRL, pct } from "../lib/money";

export type OrcamentoLine = {
  category_id: number;
  name: string;
  icon: string;
  color: string;
  pace: Pace;
  cap: number;
  spent: number;
  remaining: number;
  used_pct: number;
  expected_pct: number; // where a "continuo" category should be by today
  projected: number; // spent / days_elapsed × days_in_month (past months: = spent)
  over: boolean;
  /** ok | atencao (ahead of pace or ≥80%) | estourou */
  status: "ok" | "atencao" | "estourou";
};

export type OrcamentoReport = {
  month: string;
  label: string;
  days_elapsed: number;
  days_in_month: number;
  elapsed_pct: number;
  total_cap: number;
  total_spent: number;
  total_projected: number;
  lines: OrcamentoLine[];
  unbudgeted: { category_id: number; name: string; icon: string; spent: number }[];
};

export async function buildOrcamento(db: D1Database, month: string, now = new Date()): Promise<OrcamentoReport> {
  const [budgets, cats, totals] = await Promise.all([listBudgets(db, month), listCategories(db), totalsByCategory(db, month)]);
  const dim = daysInMonth(month);
  const cur = currentMonth(now);
  const elapsed = month < cur ? dim : month > cur ? 0 : Number(todayISO(now).slice(8, 10));
  const factor = elapsed === 0 ? 0 : dim / elapsed;
  const elapsedPct = Math.round((elapsed / dim) * 100);

  const spentBy = new Map<number, number>();
  for (const t of totals) if (t.kind === "out" && t.category_id !== null) spentBy.set(t.category_id, t.total);

  const lines: OrcamentoLine[] = [];
  for (const b of budgets) {
    const c = cats.find((x) => x.id === b.category_id);
    if (!c) continue;
    const spent = spentBy.get(b.category_id) ?? 0;
    // Fixed categories are expected to be paid whenever they are paid; projecting them is noise.
    const projected = month < cur || c.pace === "fixo" ? spent : Math.round(spent * factor);
    const used = pct(spent, b.cap_cents);
    const over = spent > b.cap_cents;
    const ahead = c.pace === "continuo" && used >= 25 && used >= elapsedPct + 15;
    lines.push({
      category_id: c.id,
      name: c.name,
      icon: c.icon,
      color: c.color,
      pace: c.pace,
      cap: b.cap_cents,
      spent,
      remaining: b.cap_cents - spent,
      used_pct: used,
      expected_pct: c.pace === "continuo" ? elapsedPct : 100,
      projected,
      over,
      status: over ? "estourou" : ahead || (c.pace !== "fixo" && used >= 80) ? "atencao" : "ok",
    });
  }
  lines.sort((a, b) => b.used_pct - a.used_pct);

  const budgeted = new Set(budgets.map((b) => b.category_id));
  const unbudgeted = cats
    .filter((c) => c.kind === "out" && !budgeted.has(c.id) && (spentBy.get(c.id) ?? 0) > 0)
    .map((c) => ({ category_id: c.id, name: c.name, icon: c.icon, spent: spentBy.get(c.id)! }))
    .sort((a, b) => b.spent - a.spent);

  return {
    month,
    label: monthLabel(month),
    days_elapsed: elapsed,
    days_in_month: dim,
    elapsed_pct: elapsedPct,
    total_cap: lines.reduce((a, l) => a + l.cap, 0),
    total_spent: lines.reduce((a, l) => a + l.spent, 0),
    total_projected: lines.reduce((a, l) => a + l.projected, 0),
    lines,
    unbudgeted,
  };
}

export function orcamentoMarkdown(r: OrcamentoReport): string {
  const tag = { ok: "", atencao: " (atenção)", estourou: " (estourou)" };
  const out = [
    `# Planejamento, ${r.label} (dia ${r.days_elapsed}/${r.days_in_month}, ${r.elapsed_pct}% do mês)`,
    "",
    `Planejado ${formatBRL(r.total_cap)} · gasto ${formatBRL(r.total_spent)} · projeção ${formatBRL(r.total_projected)}`,
    "",
    "| Categoria | Tipo | Planejado | Gasto | % | Restante | Projeção |",
    "|---|---|---:|---:|---:|---:|---:|",
    ...r.lines.map(
      (l) =>
        `| ${l.name}${tag[l.status]} | ${l.pace} | ${formatBRL(l.cap)} | ${formatBRL(l.spent)} | ${l.used_pct}% | ${formatBRL(l.remaining)} | ${formatBRL(l.projected)} |`,
    ),
  ];
  if (r.unbudgeted.length) {
    out.push("", "## Sem valor planejado", "", "| Categoria | Gasto |", "|---|---:|");
    out.push(...r.unbudgeted.map((u) => `| ${u.name} | ${formatBRL(u.spent)} |`));
  }
  return out.join("\n") + "\n";
}
