// Typed D1 queries. Keep SQL here so pages and reports stay thin.
// Every ledger query is scoped to one núcleo (`nucleoId`, always the first argument after `db`):
// a row from another núcleo is "not found", never a 403 that confirms it exists.
import { monthRange } from "./lib/dates";
import type { Aprendido, Contexto, Existente } from "./lib/importacao";

export type Kind = "in" | "out";
/** How spend accrues inside a month; drives which budget alerts make sense. */
export type Pace = "continuo" | "fixo" | "livre";

export type Category = {
  id: number;
  nucleo_id: number;
  name: string;
  kind: Kind;
  icon: string;
  color: string;
  is_preset: number;
  sort: number;
  pace: Pace;
  /** 1 = balance adjustment: counts in the balances, stays out of charts, planning, alerts and reports. */
  ajuste: number;
};

/** Inclusive date range, YYYY-MM-DD. */
export type Range = { from: string; to: string };
const toRange = (p: string | Range): Range => (typeof p === "string" ? monthRange(p) : p);

// Rows whose category is a balance adjustment are left out of every total below.
const NOT_AJUSTE = "(t.category_id IS NULL OR t.category_id NOT IN (SELECT id FROM categories WHERE ajuste = 1))";

export type Transaction = {
  id: number;
  nucleo_id: number;
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
  user_id: number | null;
  category_name: string | null;
  category_icon: string | null;
  category_color: string | null;
  category_ajuste: number | null;
  /** e-mail of who added it (shared ledger); null for rows older than v2 */
  user_email: string | null;
};

export type Budget = { category_id: number; month: string; cap_cents: number };

const TX_VIEW = `SELECT t.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color, c.ajuste AS category_ajuste, u.email AS user_email
  FROM transactions t LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN users u ON u.id = t.user_id`;

export async function listCategories(db: D1Database, nucleoId: number): Promise<Category[]> {
  const r = await db.prepare("SELECT * FROM categories WHERE nucleo_id = ? ORDER BY kind DESC, sort, name").bind(nucleoId).all<Category>();
  return r.results;
}

export async function getCategory(db: D1Database, nucleoId: number, id: number): Promise<Category | null> {
  return db.prepare("SELECT * FROM categories WHERE id = ? AND nucleo_id = ?").bind(id, nucleoId).first<Category>();
}

export async function createCategory(db: D1Database, nucleoId: number, c: { name: string; kind: Kind; icon: string; color: string; pace: Pace }) {
  const sort = await db
    .prepare("SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM categories WHERE nucleo_id = ? AND kind = ?")
    .bind(nucleoId, c.kind)
    .first<{ s: number }>();
  const r = await db
    .prepare("INSERT INTO categories (nucleo_id, name, kind, icon, color, is_preset, sort, pace) VALUES (?, ?, ?, ?, ?, 0, ?, ?)")
    .bind(nucleoId, c.name, c.kind, c.icon, c.color, sort?.s ?? 1, c.pace)
    .run();
  return Number(r.meta.last_row_id);
}

export async function renameCategory(db: D1Database, nucleoId: number, id: number, name: string, icon: string, color: string, pace: Pace) {
  await db
    .prepare("UPDATE categories SET name = ?, icon = ?, color = ?, pace = ? WHERE id = ? AND nucleo_id = ?")
    .bind(name, icon, color, pace, id, nucleoId)
    .run();
}

export async function countCategoryTransactions(db: D1Database, nucleoId: number, id: number): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM transactions WHERE category_id = ? AND nucleo_id = ?")
    .bind(id, nucleoId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/** Deleting a category never deletes money: its transactions become "Sem categoria". */
export async function deleteCategory(db: D1Database, nucleoId: number, id: number): Promise<void> {
  await db.batch([
    db.prepare("UPDATE transactions SET category_id = NULL WHERE category_id = ? AND nucleo_id = ?").bind(id, nucleoId),
    db.prepare("DELETE FROM budgets WHERE category_id IN (SELECT id FROM categories WHERE id = ? AND nucleo_id = ?)").bind(id, nucleoId),
    db.prepare("DELETE FROM categories WHERE id = ? AND nucleo_id = ?").bind(id, nucleoId),
  ]);
}

export async function listTransactions(
  db: D1Database,
  nucleoId: number,
  opts: { month?: string; range?: Range; categoryId?: number | null; limit?: number; semAjuste?: boolean } = {},
): Promise<TransactionView[]> {
  const where: string[] = ["t.nucleo_id = ?"];
  const binds: unknown[] = [nucleoId];
  const range = opts.range ?? (opts.month ? monthRange(opts.month) : null);
  if (range) {
    where.push("t.date BETWEEN ? AND ?");
    binds.push(range.from, range.to);
  }
  if (opts.semAjuste) where.push(NOT_AJUSTE);
  if (opts.categoryId === null) where.push("t.category_id IS NULL");
  else if (opts.categoryId !== undefined) {
    where.push("t.category_id = ?");
    binds.push(opts.categoryId);
  }
  const sql = `${TX_VIEW} WHERE ${where.join(" AND ")}
    ORDER BY t.date DESC, t.id DESC ${opts.limit ? "LIMIT " + Number(opts.limit) : ""}`;
  const r = await db.prepare(sql).bind(...binds).all<TransactionView>();
  return r.results;
}

export async function getTransaction(db: D1Database, nucleoId: number, id: number): Promise<TransactionView | null> {
  return db.prepare(`${TX_VIEW} WHERE t.id = ? AND t.nucleo_id = ?`).bind(id, nucleoId).first<TransactionView>();
}

export type TxInput = { date: string; amount_cents: number; kind: Kind; category_id: number | null; payee: string; note: string };

/** Shared ledger inside a núcleo: every row remembers who added it. */
export async function createTransaction(db: D1Database, nucleoId: number, t: TxInput, userId: number | null = null): Promise<number> {
  const r = await db
    .prepare("INSERT INTO transactions (nucleo_id, date, amount_cents, kind, category_id, payee, note, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(nucleoId, t.date, t.amount_cents, t.kind, t.category_id, t.payee, t.note, userId)
    .run();
  return Number(r.meta.last_row_id);
}

export async function updateTransaction(db: D1Database, nucleoId: number, id: number, t: TxInput): Promise<void> {
  await db
    .prepare(
      `UPDATE transactions SET date = ?, amount_cents = ?, kind = ?, category_id = ?, payee = ?, note = ?,
       updated_at = datetime('now') WHERE id = ? AND nucleo_id = ?`,
    )
    .bind(t.date, t.amount_cents, t.kind, t.category_id, t.payee, t.note, id, nucleoId)
    .run();
}

export async function deleteTransaction(db: D1Database, nucleoId: number, id: number): Promise<void> {
  await db.prepare("DELETE FROM transactions WHERE id = ? AND nucleo_id = ?").bind(id, nucleoId).run();
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

/** Totals per category for a month (YYYY-MM) or a date range. Balance adjustments are left out. */
export async function totalsByCategory(db: D1Database, nucleoId: number, period: string | Range): Promise<CategoryTotal[]> {
  const { from, to } = toRange(period);
  const r = await db
    .prepare(
      `SELECT t.category_id, c.name, c.icon, c.color, t.kind, SUM(t.amount_cents) AS total, COUNT(*) AS count
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.nucleo_id = ? AND t.date BETWEEN ? AND ? AND ${NOT_AJUSTE} GROUP BY t.category_id, t.kind ORDER BY total DESC`,
    )
    .bind(nucleoId, from, to)
    .all<CategoryTotal>();
  return r.results;
}

/** Balance adjustments in a period, each direction on its own. */
export async function ajustesTotal(db: D1Database, nucleoId: number, period: string | Range): Promise<{ in: number; out: number }> {
  const { from, to } = toRange(period);
  const r = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN t.kind = 'in' THEN t.amount_cents END), 0) AS "in",
              COALESCE(SUM(CASE WHEN t.kind = 'out' THEN t.amount_cents END), 0) AS "out"
       FROM transactions t JOIN categories c ON c.id = t.category_id
       WHERE t.nucleo_id = ? AND t.date BETWEEN ? AND ? AND c.ajuste = 1`,
    )
    .bind(nucleoId, from, to)
    .first<{ in: number; out: number }>();
  return { in: r?.in ?? 0, out: r?.out ?? 0 };
}

/** Cash on hand: everything that ever came in minus everything that went out up to `upTo`, adjustments included. */
export async function cashBalance(db: D1Database, nucleoId: number, upTo: string): Promise<number> {
  const r = await db
    .prepare("SELECT COALESCE(SUM(CASE WHEN kind = 'in' THEN amount_cents ELSE -amount_cents END), 0) AS n FROM transactions WHERE nucleo_id = ? AND date <= ?")
    .bind(nucleoId, upTo)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export type DayTotal = { date: string; income: number; expense: number; count: number };

/** Per-day totals in [from, to], inclusive; days without movement are absent. */
export async function totalsByDay(db: D1Database, nucleoId: number, from: string, to: string): Promise<DayTotal[]> {
  const r = await db
    .prepare(
      `SELECT date,
         SUM(CASE WHEN kind = 'in' THEN amount_cents ELSE 0 END) AS income,
         SUM(CASE WHEN kind = 'out' THEN amount_cents ELSE 0 END) AS expense,
         COUNT(*) AS count
       FROM transactions t WHERE t.nucleo_id = ? AND t.date BETWEEN ? AND ? AND ${NOT_AJUSTE} GROUP BY date ORDER BY date`,
    )
    .bind(nucleoId, from, to)
    .all<DayTotal>();
  return r.results;
}

export type MonthTotal = { month: string; income: number; expense: number };

export async function totalsByMonth(db: D1Database, nucleoId: number, fromMonth: string, toMonth: string): Promise<MonthTotal[]> {
  const r = await db
    .prepare(
      `SELECT substr(date, 1, 7) AS month,
         SUM(CASE WHEN kind = 'in' THEN amount_cents ELSE 0 END) AS income,
         SUM(CASE WHEN kind = 'out' THEN amount_cents ELSE 0 END) AS expense
       FROM transactions t WHERE t.nucleo_id = ? AND substr(t.date, 1, 7) BETWEEN ? AND ? AND ${NOT_AJUSTE} GROUP BY month ORDER BY month`,
    )
    .bind(nucleoId, fromMonth, toMonth)
    .all<MonthTotal>();
  return r.results;
}

/** Spending per category per month of a year (planning, annual view). Adjustments left out. */
export async function spentByMonthCategory(db: D1Database, nucleoId: number, year: string): Promise<{ month: string; category_id: number | null; total: number }[]> {
  const r = await db
    .prepare(
      `SELECT substr(t.date, 1, 7) AS month, t.category_id, SUM(t.amount_cents) AS total
       FROM transactions t WHERE t.nucleo_id = ? AND t.kind = 'out' AND substr(t.date, 1, 4) = ? AND ${NOT_AJUSTE}
       GROUP BY month, t.category_id`,
    )
    .bind(nucleoId, year)
    .all<{ month: string; category_id: number | null; total: number }>();
  return r.results;
}

/** Every budget of a year, for the annual view. */
export async function listBudgetsYear(db: D1Database, nucleoId: number, year: string): Promise<Budget[]> {
  const r = await db
    .prepare("SELECT b.* FROM budgets b JOIN categories c ON c.id = b.category_id WHERE c.nucleo_id = ? AND substr(b.month, 1, 4) = ?")
    .bind(nucleoId, year)
    .all<Budget>();
  return r.results;
}

// Budgets hang off categories, so the núcleo scope is a join.
export async function listBudgets(db: D1Database, nucleoId: number, month: string): Promise<Budget[]> {
  const r = await db
    .prepare("SELECT b.* FROM budgets b JOIN categories c ON c.id = b.category_id WHERE c.nucleo_id = ? AND b.month = ?")
    .bind(nucleoId, month)
    .all<Budget>();
  return r.results;
}

/** Callers pass a category they already resolved inside the núcleo (see planejamento). */
export async function setBudget(db: D1Database, nucleoId: number, categoryId: number, month: string, capCents: number): Promise<void> {
  const owned = await db.prepare("SELECT 1 AS ok FROM categories WHERE id = ? AND nucleo_id = ?").bind(categoryId, nucleoId).first();
  if (!owned) return;
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

/** Copies the núcleo's most recent month's budgets into `month` when it has none yet. */
export async function ensureBudgetsFor(db: D1Database, nucleoId: number, month: string): Promise<void> {
  const existing = await db
    .prepare("SELECT COUNT(*) AS n FROM budgets b JOIN categories c ON c.id = b.category_id WHERE c.nucleo_id = ? AND b.month = ?")
    .bind(nucleoId, month)
    .first<{ n: number }>();
  if ((existing?.n ?? 0) > 0) return;
  const prev = await db
    .prepare("SELECT b.month FROM budgets b JOIN categories c ON c.id = b.category_id WHERE c.nucleo_id = ? AND b.month < ? ORDER BY b.month DESC LIMIT 1")
    .bind(nucleoId, month)
    .first<{ month: string }>();
  if (!prev) return;
  await db
    .prepare(
      `INSERT INTO budgets (category_id, month, cap_cents)
       SELECT b.category_id, ?, b.cap_cents FROM budgets b JOIN categories c ON c.id = b.category_id WHERE c.nucleo_id = ? AND b.month = ?`,
    )
    .bind(month, nucleoId, prev.month)
    .run();
}

export async function listPayees(db: D1Database, nucleoId: number, limit = 30): Promise<string[]> {
  const r = await db
    .prepare("SELECT payee FROM transactions WHERE nucleo_id = ? AND payee <> '' GROUP BY payee ORDER BY COUNT(*) DESC, MAX(date) DESC LIMIT ?")
    .bind(nucleoId, limit)
    .all<{ payee: string }>();
  return r.results.map((x) => x.payee);
}

export async function exportAll(db: D1Database, nucleoId: number) {
  const [nucleo, categories, transactions, budgets] = await Promise.all([
    db.prepare("SELECT name FROM nucleos WHERE id = ?").bind(nucleoId).first<{ name: string }>(),
    db.prepare("SELECT * FROM categories WHERE nucleo_id = ? ORDER BY id").bind(nucleoId).all<Category>(),
    db.prepare("SELECT * FROM transactions WHERE nucleo_id = ? ORDER BY date, id").bind(nucleoId).all<Transaction>(),
    db
      .prepare("SELECT b.* FROM budgets b JOIN categories c ON c.id = b.category_id WHERE c.nucleo_id = ? ORDER BY b.month, b.category_id")
      .bind(nucleoId)
      .all<Budget>(),
  ]);
  return {
    exported_at: new Date().toISOString(),
    nucleo: nucleo?.name ?? "",
    currency: "BRL",
    amounts: "integer centavos",
    categories: categories.results,
    transactions: transactions.results,
    budgets: budgets.results,
  };
}

// ---- debts (dívidas): balance updated by hand, nothing deducts it automatically ----

export type Debt = {
  id: number;
  nucleo_id: number;
  name: string;
  creditor: string;
  balance_cents: number;
  installment_cents: number;
  due_day: number | null;
  /** basis points per month: 1,99 % a.m. = 199; null when unknown */
  interest_bp: number | null;
  note: string;
  created_at: string;
  updated_at: string;
};

export type DebtInput = Pick<Debt, "name" | "creditor" | "balance_cents" | "installment_cents" | "due_day" | "interest_bp" | "note">;

export async function listDebts(db: D1Database, nucleoId: number): Promise<Debt[]> {
  const r = await db.prepare("SELECT * FROM debts WHERE nucleo_id = ? ORDER BY balance_cents = 0, balance_cents DESC, id").bind(nucleoId).all<Debt>();
  return r.results;
}

export async function getDebt(db: D1Database, nucleoId: number, id: number): Promise<Debt | null> {
  return db.prepare("SELECT * FROM debts WHERE id = ? AND nucleo_id = ?").bind(id, nucleoId).first<Debt>();
}

export async function createDebt(db: D1Database, nucleoId: number, d: DebtInput): Promise<number> {
  const r = await db
    .prepare("INSERT INTO debts (nucleo_id, name, creditor, balance_cents, installment_cents, due_day, interest_bp, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(nucleoId, d.name, d.creditor, d.balance_cents, d.installment_cents, d.due_day, d.interest_bp, d.note)
    .run();
  return Number(r.meta.last_row_id);
}

export async function updateDebt(db: D1Database, nucleoId: number, id: number, d: DebtInput): Promise<void> {
  await db
    .prepare(
      `UPDATE debts SET name = ?, creditor = ?, balance_cents = ?, installment_cents = ?, due_day = ?, interest_bp = ?, note = ?,
       updated_at = datetime('now') WHERE id = ? AND nucleo_id = ?`,
    )
    .bind(d.name, d.creditor, d.balance_cents, d.installment_cents, d.due_day, d.interest_bp, d.note, id, nucleoId)
    .run();
}

export async function deleteDebt(db: D1Database, nucleoId: number, id: number): Promise<void> {
  await db.prepare("DELETE FROM debts WHERE id = ? AND nucleo_id = ?").bind(id, nucleoId).run();
}

// ---- statement import (src/lib/importacao.ts decides, this reads and writes) ----

/** Everything the analysis needs about the núcleo, for statement rows dated `from`..`to`. */
export async function importContext(db: D1Database, nucleoId: number, from: string, to: string): Promise<Contexto> {
  const [existentes, importados, ignorados, titulares, aprendido, inicio] = await db.batch([
    db
      .prepare(
        `SELECT t.id, t.date, t.kind, t.amount_cents, t.payee, c.name AS category_name, t.import_ref
         FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
         WHERE t.nucleo_id = ? AND t.date BETWEEN ? AND ? ORDER BY t.id`,
      )
      .bind(nucleoId, from, to),
    db.prepare("SELECT import_ref FROM transactions WHERE nucleo_id = ? AND import_ref IS NOT NULL").bind(nucleoId),
    db.prepare("SELECT ref FROM import_ignored WHERE nucleo_id = ?").bind(nucleoId),
    db.prepare("SELECT nome FROM nucleo_titulares WHERE nucleo_id = ?").bind(nucleoId),
    // oldest first, so the newest entry of a counterparty is the one that sticks
    db.prepare("SELECT import_desc, category_id, payee, kind FROM transactions WHERE nucleo_id = ? AND import_desc IS NOT NULL ORDER BY id").bind(nucleoId),
    db.prepare("SELECT MIN(date) AS d FROM transactions WHERE nucleo_id = ?").bind(nucleoId),
  ]);
  const map = new Map<string, Aprendido>();
  for (const r of aprendido.results as (Aprendido & { import_desc: string })[]) {
    map.set(r.import_desc, { category_id: r.category_id, payee: r.payee, kind: r.kind });
  }
  return {
    existentes: existentes.results as Existente[],
    importados: new Set((importados.results as { import_ref: string }[]).map((r) => r.import_ref)),
    ignorados: new Set((ignorados.results as { ref: string }[]).map((r) => r.ref)),
    titulares: new Set((titulares.results as { nome: string }[]).map((r) => r.nome)),
    aprendido: map,
    inicio: (inicio.results[0] as { d: string | null } | undefined)?.d ?? null,
  };
}

export type ImportPlan = {
  /** new entries */
  novos: { date: string; cents: number; kind: Kind; cat: number | null; payee: string; ref: string; desc: string }[];
  /** existing entries that turned out to be a statement row: they only gain its fingerprint */
  vinculos: { id: number; ref: string; desc: string }[];
  /** rows left out on purpose */
  ignorar: string[];
  /** rows left out before and imported now */
  reviver: string[];
  /** holder names to remember, already normalised */
  titulares: string[];
};

/**
 * One atomic batch, one statement per kind of write whatever the number of rows (the rows travel
 * as a JSON array): a statement of 300 rows costs the same five queries as one of 3.
 */
export async function applyImport(db: D1Database, nucleoId: number, userId: number, plan: ImportPlan): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  if (plan.novos.length) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO transactions (nucleo_id, date, amount_cents, kind, category_id, payee, note, user_id, import_ref, import_desc)
           SELECT ?1, json_extract(j.value, '$.date'), json_extract(j.value, '$.cents'), json_extract(j.value, '$.kind'),
                  json_extract(j.value, '$.cat'), json_extract(j.value, '$.payee'), '', ?2,
                  json_extract(j.value, '$.ref'), json_extract(j.value, '$.desc')
           FROM json_each(?3) j
           WHERE json_extract(j.value, '$.ref') NOT IN (SELECT import_ref FROM transactions WHERE nucleo_id = ?1 AND import_ref IS NOT NULL)`,
        )
        .bind(nucleoId, userId, JSON.stringify(plan.novos)),
    );
  }
  if (plan.vinculos.length) {
    stmts.push(
      db
        .prepare(
          `UPDATE transactions SET import_ref = json_extract(j.value, '$.ref'), import_desc = json_extract(j.value, '$.desc')
           FROM json_each(?2) j
           WHERE transactions.id = json_extract(j.value, '$.id') AND transactions.nucleo_id = ?1 AND transactions.import_ref IS NULL`,
        )
        .bind(nucleoId, JSON.stringify(plan.vinculos)),
    );
  }
  if (plan.ignorar.length) {
    stmts.push(db.prepare("INSERT OR IGNORE INTO import_ignored (nucleo_id, ref) SELECT ?1, j.value FROM json_each(?2) j").bind(nucleoId, JSON.stringify(plan.ignorar)));
  }
  if (plan.reviver.length) {
    stmts.push(db.prepare("DELETE FROM import_ignored WHERE nucleo_id = ?1 AND ref IN (SELECT j.value FROM json_each(?2) j)").bind(nucleoId, JSON.stringify(plan.reviver)));
  }
  if (plan.titulares.length) {
    stmts.push(db.prepare("INSERT OR IGNORE INTO nucleo_titulares (nucleo_id, nome) SELECT ?1, j.value FROM json_each(?2) j").bind(nucleoId, JSON.stringify(plan.titulares)));
  }
  if (stmts.length) await db.batch(stmts);
}

export async function listTitulares(db: D1Database, nucleoId: number): Promise<string[]> {
  const r = await db.prepare("SELECT nome FROM nucleo_titulares WHERE nucleo_id = ? ORDER BY nome").bind(nucleoId).all<{ nome: string }>();
  return r.results.map((x) => x.nome);
}

export async function deleteTitular(db: D1Database, nucleoId: number, nome: string): Promise<void> {
  await db.prepare("DELETE FROM nucleo_titulares WHERE nucleo_id = ? AND nome = ?").bind(nucleoId, nome).run();
}
