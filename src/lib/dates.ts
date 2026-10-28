// Dates are strings: YYYY-MM-DD for transactions, YYYY-MM for months.
// "Today" is evaluated in São Paulo time so late-night entries land on the right day.

const TZ = "America/Sao_Paulo";

export function todayISO(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function currentMonth(now = new Date()): string {
  return todayISO(now).slice(0, 7);
}

export function isISODate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

export function isMonth(s: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function monthRange(month: string): { from: string; to: string } {
  return { from: `${month}-01`, to: `${month}-${String(daysInMonth(month)).padStart(2, "0")}` };
}

const MONTHS_PT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

export function monthLabel(month: string): string {
  const [y, m] = month.split("-");
  return `${MONTHS_PT[Number(m) - 1]}/${y}`;
}

export function dateLabel(date: string): string {
  const [, m, d] = date.split("-");
  return `${d}/${m}`;
}

export function addDays(date: string, delta: number): string {
  const d = new Date(Date.parse(date) + delta * 86_400_000);
  return d.toISOString().slice(0, 10);
}

const WEEKDAYS_PT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
export function weekdayLabel(date: string): string {
  return WEEKDAYS_PT[new Date(Date.parse(date)).getUTCDay()];
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

/** What a page shows: a calendar month (the default) or a period picked by hand. */
export type Period = { kind: "mes"; month: string; from: string; to: string } | { kind: "periodo"; from: string; to: string };

const MAX_PERIOD_DAYS = 366 * 5;

/** `?de=&ate=` (both valid, de ≤ ate, at most five years) wins; otherwise `?mes=`, otherwise this month. */
export function parsePeriod(q: { mes?: string; de?: string; ate?: string }, now = new Date()): Period {
  const { de, ate } = q;
  if (de && ate && isISODate(de) && isISODate(ate) && de <= ate && daysBetween(de, ate) <= MAX_PERIOD_DAYS) {
    return { kind: "periodo", from: de, to: ate };
  }
  const month = q.mes && isMonth(q.mes) ? q.mes : currentMonth(now);
  return { kind: "mes", month, ...monthRange(month) };
}

/** Query string that reproduces a period, for links that must keep it. */
export function periodQuery(p: Period): string {
  return p.kind === "mes" ? `mes=${p.month}` : `de=${p.from}&ate=${p.to}`;
}

/** "out/2026" for a month, "01/10/2026 – 15/10/2026" for a period. */
export function periodLabel(p: Period): string {
  if (p.kind === "mes") return monthLabel(p.month);
  const full = (d: string) => `${dateLabel(d)}/${d.slice(0, 4)}`;
  return `${full(p.from)} – ${full(p.to)}`;
}
