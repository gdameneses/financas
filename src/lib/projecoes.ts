// Projections for the dashboard. Pure functions over numbers the pages already load, so they are
// easy to test and cost no extra queries. Money is integer centavos throughout.
import type { Category, CategoryTotal, Debt, MonthTotal } from "../db";
import { addMonths, currentMonth, daysInMonth, todayISO } from "./dates";

const MAX_MONTHS = 600; // 50 years: past this a debt "never" ends for any practical purpose

export type Payoff =
  | { status: "quitada" }
  | { status: "nunca"; reason: "sem parcela" | "parcela não cobre os juros" }
  | { status: "termina"; months: number; end_month: string; interest: number };

/**
 * When a debt ends if the current installment keeps being paid. Interest is compounded monthly on
 * the balance (`interest_bp` per month, none when unknown), then the installment is paid; the last
 * payment is whatever is left.
 */
export function debtPayoff(d: Pick<Debt, "balance_cents" | "installment_cents" | "interest_bp">, now = new Date()): Payoff {
  let balance = d.balance_cents;
  if (balance <= 0) return { status: "quitada" };
  if (d.installment_cents <= 0) return { status: "nunca", reason: "sem parcela" };
  const rate = (d.interest_bp ?? 0) / 10_000;
  let interest = 0;
  for (let m = 1; m <= MAX_MONTHS; m++) {
    const accrued = Math.round(balance * rate);
    if (d.installment_cents <= accrued) return { status: "nunca", reason: "parcela não cobre os juros" };
    interest += accrued;
    balance += accrued - d.installment_cents;
    if (balance <= 0) return { status: "termina", months: m, end_month: addMonths(currentMonth(now), m), interest };
  }
  return { status: "nunca", reason: "parcela não cobre os juros" };
}

export type FimDoMes = {
  month: string;
  days_elapsed: number;
  days_in_month: number;
  income: number;
  expense: number;
  expense_projected: number;
  ajustes: number;
  balance: number;
  balance_projected: number;
};

/**
 * Where the current month ends at today's pace. Continuous and free categories are extrapolated
 * (spent ÷ days elapsed × days in month), fixed ones stay as spent (rent is paid once), and
 * income counts only what already came in: an expected salary is not money yet.
 */
export function fimDoMes(totals: CategoryTotal[], cats: Pick<Category, "id" | "pace">[], ajustes: { in: number; out: number }, now = new Date()): FimDoMes {
  const month = currentMonth(now);
  const dim = daysInMonth(month);
  const elapsed = Number(todayISO(now).slice(8, 10));
  const factor = dim / elapsed;
  let income = 0, expense = 0, projected = 0;
  for (const t of totals) {
    if (t.kind === "in") {
      income += t.total;
      continue;
    }
    expense += t.total;
    const pace = cats.find((c) => c.id === t.category_id)?.pace ?? "continuo";
    projected += pace === "fixo" ? t.total : Math.round(t.total * factor);
  }
  const net = ajustes.in - ajustes.out;
  return {
    month,
    days_elapsed: elapsed,
    days_in_month: dim,
    income,
    expense,
    expense_projected: projected,
    ajustes: net,
    balance: income - expense + net,
    balance_projected: income - projected + net,
  };
}

export type ProximosMeses = {
  /** average monthly result (income − expense, adjustments excluded) of the months used */
  avg_net: number;
  months_used: string[];
  points: { month: string; balance: number; freed: number }[];
};

/**
 * Cash on hand at the end of the current month and the next `n` months. Each future month adds
 * the average result of the last three complete months that have data. Debt installments are
 * already inside that average (they are paid as ordinary expenses), so a debt shows up the other
 * way round: from the month after it ends, its installment is money freed up.
 */
export function proximosMeses(
  cashNow: number,
  fim: Pick<FimDoMes, "balance" | "balance_projected">,
  history: MonthTotal[],
  debts: Pick<Debt, "balance_cents" | "installment_cents" | "interest_bp">[],
  n = 6,
  now = new Date(),
): ProximosMeses {
  const cur = currentMonth(now);
  const used = history.filter((h) => h.month < cur && (h.income || h.expense)).sort((a, b) => a.month.localeCompare(b.month)).slice(-3);
  const avg = used.length ? Math.round(used.reduce((a, h) => a + h.income - h.expense, 0) / used.length) : 0;
  const ends = debts.map((d) => ({ payoff: debtPayoff(d, now), installment: d.installment_cents }));
  let balance = cashNow + (fim.balance_projected - fim.balance);
  const points = [{ month: cur, balance, freed: 0 }];
  for (let k = 1; k <= n; k++) {
    const freed = ends.reduce((a, e) => a + (e.payoff.status === "termina" && e.payoff.months < k ? e.installment : 0), 0);
    balance += avg + freed;
    points.push({ month: addMonths(cur, k), balance, freed });
  }
  return { avg_net: avg, months_used: used.map((h) => h.month), points };
}
