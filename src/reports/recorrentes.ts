import type { Transaction } from "../db";
import { addMonths, daysBetween, monthLabel } from "../lib/dates";
import { formatBRL } from "../lib/money";

/**
 * Recurring detection, deterministic:
 *  - group outflows by normalized payee;
 *  - within a payee, cluster amounts within ±5% of the cluster's first amount;
 *  - a cluster is "recurring" with ≥3 occurrences whose median gap is 28–33 days;
 *  - status: "novo" if first seen in the report month, "sumido" if expected this
 *    month (last seen in previous month) but absent, else "ativo".
 */

export const AMOUNT_TOLERANCE = 0.05;
const MIN_OCCURRENCES = 3;
const GAP_MIN = 28;
const GAP_MAX = 33;

export type Recorrente = {
  payee: string;
  category_id: number | null;
  amount: number; // median amount in the cluster
  occurrences: number;
  first: string;
  last: string;
  median_gap_days: number;
  status: "ativo" | "novo" | "sumido";
  dates: string[];
};

export type RecorrentesReport = {
  month: string;
  label: string;
  monthly_total: number; // sum of active+new recurring amounts
  items: Recorrente[];
};

export function normalizePayee(p: string): string {
  return p
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export function detectRecorrentes(txs: Transaction[], month: string): RecorrentesReport {
  const prevMonth = addMonths(month, -1);
  const byPayee = new Map<string, Transaction[]>();
  for (const t of txs) {
    if (t.kind !== "out") continue;
    const key = normalizePayee(t.payee);
    if (!key) continue;
    (byPayee.get(key) ?? byPayee.set(key, []).get(key)!).push(t);
  }

  const items: Recorrente[] = [];
  for (const group of byPayee.values()) {
    group.sort((a, b) => a.date.localeCompare(b.date));
    const clusters: Transaction[][] = [];
    for (const t of group) {
      const c = clusters.find((cl) => Math.abs(t.amount_cents - cl[0].amount_cents) <= cl[0].amount_cents * AMOUNT_TOLERANCE);
      if (c) c.push(t);
      else clusters.push([t]);
    }
    for (const c of clusters) {
      if (c.length < MIN_OCCURRENCES) continue;
      const gaps = c.slice(1).map((t, i) => daysBetween(c[i].date, t.date));
      const gap = median(gaps);
      if (gap < GAP_MIN || gap > GAP_MAX) continue;
      const first = c[0].date;
      const last = c[c.length - 1].date;
      const lastMonth = last.slice(0, 7);
      let status: Recorrente["status"] = "ativo";
      if (first.slice(0, 7) === month) status = "novo";
      else if (lastMonth === prevMonth) status = "sumido";
      else if (lastMonth < prevMonth) continue; // dead for 2+ months: not worth listing
      items.push({
        payee: c[c.length - 1].payee,
        category_id: c[c.length - 1].category_id,
        amount: median(c.map((t) => t.amount_cents)),
        occurrences: c.length,
        first,
        last,
        median_gap_days: gap,
        status,
        dates: c.map((t) => t.date),
      });
    }
  }
  items.sort((a, b) => b.amount - a.amount);
  return {
    month,
    label: monthLabel(month),
    monthly_total: items.filter((i) => i.status !== "sumido").reduce((a, i) => a + i.amount, 0),
    items,
  };
}

export function recorrentesMarkdown(r: RecorrentesReport): string {
  const tag = { ativo: "", novo: " **(novo)**", sumido: " **(sumido)**" };
  return (
    [
      `# Recorrentes — ${r.label}`,
      "",
      `Total mensal estimado: ${formatBRL(r.monthly_total)} (${r.items.filter((i) => i.status !== "sumido").length} itens)`,
      "",
      "| Destino | Valor | Ocorrências | Último | Intervalo |",
      "|---|---:|---:|---|---:|",
      ...r.items.map(
        (i) => `| ${i.payee}${tag[i.status]} | ${formatBRL(i.amount)} | ${i.occurrences} | ${i.last} | ~${i.median_gap_days}d |`,
      ),
    ].join("\n") + "\n"
  );
}
