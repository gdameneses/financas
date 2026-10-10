// Typed D1 queries. Keep SQL here so pages and reports stay thin.
import { monthRange } from "./lib/dates";

export type Kind = "in" | "out";
/** How spend accrues inside a month; drives which budget alerts make sense. */
export type Pace = "continuo" | "fixo" | "livre";

export type Category = {
  id: number;
  name: string;
  kind: Kind;
  icon: string;
  color: string;
  is_preset: number;
  sort: number;
  pace: Pace;
};

export type Transaction = {
  id: number;
  date: string;
  amount_cents: number;
  kind: Kind;
  category_id: number | null;
  payee: string;
  note: string;
  created_at: string;
  updated_at: string;
};

export type TransactionView = Transaction & {
  category_name: string | null;
  category_icon: string | null;
  category_color: string | null;
};

export type Budget = { category_id: number; month: string; cap_cents: number };

const TX_VIEW = `SELECT t.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color
  FROM transactions t LEFT JOIN categories c ON c.id = t.category_id`;

export async function listCategories(db: D1Database): Promise<Category[]> {
  const r = await db.prepare("SELECT * FROM categories ORDER BY kind DESC, sort, name").all<Category>();
  return r.results;
}

export async function getCategory(db: D1Database, id: number): Promise<Category | null> {
  return db.prepare("SELECT * FROM categories WHERE id = ?").bind(id).first<Category>();
}

export async function createCategory(db: D1Database, c: { name: string; kind: Kind; icon: string; color: string; pace: Pace }) {
  const sort = await db
    .prepare("SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM categories WHERE kind = ?")
    .bind(c.kind)
    .first<{ s: number }>();
  const r = await db
    .prepare("INSERT INTO categories (name, kind, icon, color, is_preset, sort, pace) VALUES (?, ?, ?, ?, 0, ?, ?)")
    .bind(c.name, c.kind, c.icon, c.color, sort?.s ?? 1, c.pace)
    .run();
  return Number(r.meta.last_row_id);
}

export async function renameCategory(db: D1Database, id: number, name: string, icon: string, color: string, pace: Pace) {
  await db.prepare("UPDATE categories SET name = ?, icon = ?, color = ?, pace = ? WHERE id = ?").bind(name, icon, color, pace, id).run();
}

export async function countCategoryTransactions(db: D1Database, id: number): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?").bind(id).first<{ n: number }>();
  return r?.n ?? 0;
}

/** Deleting a category never deletes money: its transactions become "Sem categoria". */
export async function deleteCategory(db: D1Database, id: number): Promise<void> {
  await db.batch([
    db.prepare("UPDATE transactions SET category_id = NULL WHERE category_id = ?").bind(id),
    db.prepare("DELETE FROM budgets WHERE category_id = ?").bind(id),
    db.prepare("DELETE FROM categories WHERE id = ?").bind(id),
  ]);
}

export async function listTransactions(
  db: D1Database,
  opts: { month?: string; categoryId?: number | null; limit?: number } = {},
): Promise<TransactionView[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.month) {
    const { from, to } = monthRange(opts.month);
    where.push("t.date BETWEEN ? AND ?");
    binds.push(from, to);
  }
  if (opts.categoryId === null) where.push("t.category_id IS NULL");
  else if (opts.categoryId !== undefined) {
    where.push("t.category_id = ?");
    binds.push(opts.categoryId);
  }
  const sql = `${TX_VIEW} ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY t.date DESC, t.id DESC ${opts.limit ? "LIMIT " + Number(opts.limit) : ""}`;
  const r = await db.prepare(sql).bind(...binds).all<TransactionView>();
  return r.results;
}

export async function getTransaction(db: D1Database, id: number): Promise<TransactionView | null> {
  return db.prepare(`${TX_VIEW} WHERE t.id = ?`).bind(id).first<TransactionView>();
}

export type TxInput = { date: string; amount_cents: number; kind: Kind; category_id: number | null; payee: string; note: string };

/** Shared ledger: every row remembers who added it. */
export async function createTransaction(db: D1Database, t: TxInput, userId: number | null = null): Promise<number> {
  const r = await db
    .prepare("INSERT INTO transactions (date, amount_cents, kind, category_id, payee, note, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(t.date, t.amount_cents, t.kind, t.category_id, t.payee, t.note, userId)
    .run();
  return Number(r.meta.last_row_id);
}

export async function updateTransaction(db: D1Database, id: number, t: TxInput): Promise<void> {
  await db
    .prepare(
      `UPDATE transactions SET date = ?, amount_cents = ?, kind = ?, category_id = ?, payee = ?, note = ?,
       updated_at = datetime('now') WHERE id = ?`,
    )
    .bind(t.date, t.amount_cents, t.kind, t.category_id, t.payee, t.note, id)
    .run();
}

export async function deleteTransaction(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM transactions WHERE id = ?").bind(id).run();
}

export type CategoryTotal = {
  category_id: number | null;
  name: string | null;
  icon: string | null;
  color: string | null;
  kind: Kind;
  total: number;
  count: number;
};

export async function totalsByCategory(db: D1Database, month: string): Promise<CategoryTotal[]> {
  const { from, to } = monthRange(month);
  const r = await db
    .prepare(
      `SELECT t.category_id, c.name, c.icon, c.color, t.kind, SUM(t.amount_cents) AS total, COUNT(*) AS count
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.date BETWEEN ? AND ? GROUP BY t.category_id, t.kind ORDER BY total DESC`,
    )
    .bind(from, to)
    .all<CategoryTotal>();
  return r.results;
}

export type MonthTotal = { month: string; income: number; expense: number };

export async function totalsByMonth(db: D1Database, fromMonth: string, toMonth: string): Promise<MonthTotal[]> {
  const r = await db
    .prepare(
      `SELECT substr(date, 1, 7) AS month,
         SUM(CASE WHEN kind = 'in' THEN amount_cents ELSE 0 END) AS income,
         SUM(CASE WHEN kind = 'out' THEN amount_cents ELSE 0 END) AS expense
       FROM transactions WHERE substr(date, 1, 7) BETWEEN ? AND ? GROUP BY month ORDER BY month`,
    )
    .bind(fromMonth, toMonth)
    .all<MonthTotal>();
  return r.results;
}

export async function listBudgets(db: D1Database, month: string): Promise<Budget[]> {
  const r = await db.prepare("SELECT * FROM budgets WHERE month = ?").bind(month).all<Budget>();
  return r.results;
}

export async function setBudget(db: D1Database, categoryId: number, month: string, capCents: number): Promise<void> {
  if (capCents <= 0) {
    await db.prepare("DELETE FROM budgets WHERE category_id = ? AND month = ?").bind(categoryId, month).run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO budgets (category_id, month, cap_cents) VALUES (?, ?, ?)
       ON CONFLICT(category_id, month) DO UPDATE SET cap_cents = excluded.cap_cents`,
    )
    .bind(categoryId, month, capCents)
    .run();
}

/** Copies the most recent month's budgets into `month` when it has none yet. */
export async function ensureBudgetsFor(db: D1Database, month: string): Promise<void> {
  const existing = await db.prepare("SELECT COUNT(*) AS n FROM budgets WHERE month = ?").bind(month).first<{ n: number }>();
  if ((existing?.n ?? 0) > 0) return;
  const prev = await db
    .prepare("SELECT month FROM budgets WHERE month < ? ORDER BY month DESC LIMIT 1")
    .bind(month)
    .first<{ month: string }>();
  if (!prev) return;
  await db
    .prepare("INSERT INTO budgets (category_id, month, cap_cents) SELECT category_id, ?, cap_cents FROM budgets WHERE month = ?")
    .bind(month, prev.month)
    .run();
}

export async function listPayees(db: D1Database, limit = 30): Promise<string[]> {
  const r = await db
    .prepare("SELECT payee FROM transactions WHERE payee <> '' GROUP BY payee ORDER BY COUNT(*) DESC, MAX(date) DESC LIMIT ?")
    .bind(limit)
    .all<{ payee: string }>();
  return r.results.map((x) => x.payee);
}

export async function exportAll(db: D1Database) {
  const [categories, transactions, budgets] = await Promise.all([
    db.prepare("SELECT * FROM categories ORDER BY id").all<Category>(),
    db.prepare("SELECT * FROM transactions ORDER BY date, id").all<Transaction>(),
    db.prepare("SELECT * FROM budgets ORDER BY month, category_id").all<Budget>(),
  ]);
  return {
    exported_at: new Date().toISOString(),
    currency: "BRL",
    amounts: "integer centavos",
    categories: categories.results,
    transactions: transactions.results,
    budgets: budgets.results,
  };
}
