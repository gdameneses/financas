// Budget alerts: pure rules + a sync that materialises them in D1 once per category/month/level.
import type { Pace } from "./db";
import { buildOrcamento, type OrcamentoLine } from "./reports/orcamento";
import { currentMonth } from "./lib/dates";

export type Level = "ritmo" | "80" | "100";
const RANK: Record<Level, number> = { ritmo: 1, "80": 2, "100": 3 };

// Pace rule: spent share must exceed the elapsed share by this many points, and be past
// a floor so that a single early purchase (day 2, 30% of a small cap) does not shout.
export const PACE_MARGIN_PTS = 15;
export const PACE_FLOOR_PCT = 25;

/**
 * Which level (if any) a budget line is at right now. Returns the highest applicable one.
 * "100" means the cap is used up (continuo/livre) or exceeded (fixo: paying exactly the rent
 * is the plan working, not an alert).
 */
export function levelFor(line: Pick<OrcamentoLine, "used_pct" | "pace" | "over">, elapsedPct: number): Level | null {
  const pct = line.used_pct;
  if (line.pace === "fixo") return line.over ? "100" : null;
  if (pct >= 100) return "100";
  if (pct >= 80) return "80";
  if (line.pace === "livre") return null;
  if (pct >= PACE_FLOOR_PCT && pct >= elapsedPct + PACE_MARGIN_PTS) return "ritmo";
  return null;
}

export type AlertRow = {
  id: number;
  category_id: number;
  month: string;
  level: Level;
  spent_pct: number;
  elapsed_pct: number;
  spent_cents: number;
  cap_cents: number;
  projected_cents: number;
  created_at: string;
  dismissed_at: string | null;
  note: string;
  note_by: number | null;
  note_at: string | null;
  // joined
  name: string;
  icon: string;
  color: string;
  pace: Pace;
  note_email: string | null;
};

/**
 * Creates any alert the current numbers call for and has not fired yet this month.
 * A new, higher level dismisses the lower active ones of the same category so the
 * dashboard never shows "80%" and "100%" for the same thing. Idempotent; call on page load.
 */
export async function syncAlerts(db: D1Database, nucleoId: number, now = new Date()): Promise<void> {
  const month = currentMonth(now);
  const rep = await buildOrcamento(db, nucleoId, month, now);
  if (!rep.lines.length) return;
  const elapsedPct = Math.round((rep.days_elapsed / rep.days_in_month) * 100);
  const existing = (
    await db
      .prepare("SELECT a.category_id, a.level FROM alerts a JOIN categories c ON c.id = a.category_id WHERE a.month = ? AND c.nucleo_id = ?")
      .bind(month, nucleoId)
      .all<{ category_id: number; level: Level }>()
  ).results;
  const stmts: D1PreparedStatement[] = [];
  for (const l of rep.lines) {
    const level = levelFor(l, elapsedPct);
    if (!level) continue;
    const fired = existing.filter((e) => e.category_id === l.category_id);
    if (fired.some((e) => e.level === level)) continue;
    if (fired.some((e) => RANK[e.level] > RANK[level])) continue; // already past this level
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO alerts (category_id, month, level, spent_pct, elapsed_pct, spent_cents, cap_cents, projected_cents)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(l.category_id, month, level, l.used_pct, elapsedPct, l.spent, l.cap, l.projected),
      db
        .prepare("UPDATE alerts SET dismissed_at = datetime('now') WHERE category_id = ? AND month = ? AND level <> ? AND dismissed_at IS NULL")
        .bind(l.category_id, month, level),
    );
  }
  if (stmts.length) await db.batch(stmts);
}

export async function activeAlerts(db: D1Database, nucleoId: number, month: string): Promise<AlertRow[]> {
  const r = await db
    .prepare(
      `SELECT a.*, c.name, c.icon, c.color, c.pace, u.email AS note_email
       FROM alerts a JOIN categories c ON c.id = a.category_id LEFT JOIN users u ON u.id = a.note_by
       WHERE a.month = ? AND c.nucleo_id = ? AND a.dismissed_at IS NULL ORDER BY a.created_at DESC`,
    )
    .bind(month, nucleoId)
    .all<AlertRow>();
  return r.results;
}

// Scoped through the category: an alert id from another núcleo is a no-op.
const OWNED = "AND category_id IN (SELECT id FROM categories WHERE nucleo_id = ?)";

export async function dismissAlert(db: D1Database, nucleoId: number, id: number, userId: number): Promise<void> {
  await db.prepare(`UPDATE alerts SET dismissed_at = datetime('now'), dismissed_by = ? WHERE id = ? ${OWNED}`).bind(userId, id, nucleoId).run();
}

export async function noteAlert(db: D1Database, nucleoId: number, id: number, userId: number, note: string): Promise<void> {
  await db.prepare(`UPDATE alerts SET note = ?, note_by = ?, note_at = datetime('now') WHERE id = ? ${OWNED}`).bind(note, userId, id, nucleoId).run();
}

/** The sentence shown on the dashboard, built from the stored numbers. */
export function alertMessage(a: AlertRow, fmt: (cents: number) => string): string {
  const cat = a.name.toLowerCase();
  switch (a.level) {
    case "100":
      return `${a.name}: estourou o planejado. ${fmt(a.spent_cents)} de ${fmt(a.cap_cents)} (${a.spent_pct}%).`;
    case "80":
      return `Você já usou ${a.spent_pct}% do planejado para ${cat} com ${a.elapsed_pct}% do mês passado.`;
    case "ritmo":
      return `Você já gastou ${a.spent_pct}% do seu valor planejado para ${cat}, mas só ${a.elapsed_pct}% do mês passou. Nesse ritmo termina em ${fmt(a.projected_cents)}.`;
  }
}
