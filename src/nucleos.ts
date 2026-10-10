// Núcleos: the tenant. A user belongs to one or more núcleos (with a role in each) and works on
// one at a time (`users.current_nucleo_id`). Invites are 8-digit single-use codes typed in-app.
import type { Nucleo, NucleoRole } from "./env";
import { seedPresets } from "./presets";
import { ipBucket } from "./lib/ip";

const INVITE_TTL_DAYS = 7;
const INVITE_WRONG_PER_IP_PER_HOUR = 10;
const INVITE_WRONG_GLOBAL_PER_HOUR = 50;

export type Membership = Nucleo & { members: number };

export type MemberRow = { user_id: number; email: string; role: NucleoRole; joined_at: string };
export type InviteRow = { id: number; code: string; role: NucleoRole; created_at: string; expires_at: string; created_by_email: string | null };

/** Every núcleo this user belongs to, with the role and head-count. */
export async function listMemberships(db: D1Database, userId: number): Promise<Membership[]> {
  const r = await db
    .prepare(
      `SELECT n.id, n.name, m.role, (SELECT COUNT(*) FROM nucleo_members x WHERE x.nucleo_id = n.id) AS members
       FROM nucleo_members m JOIN nucleos n ON n.id = m.nucleo_id WHERE m.user_id = ? ORDER BY m.joined_at, n.id`,
    )
    .bind(userId)
    .all<Membership>();
  return r.results;
}

/**
 * The núcleo this user works on: their current one if they are still a member, otherwise the
 * oldest membership (and the pointer is repaired). Null when they belong to none yet.
 */
export async function currentNucleo(db: D1Database, userId: number): Promise<Nucleo | null> {
  const row = await db
    .prepare(
      `SELECT n.id, n.name, m.role FROM users u
       JOIN nucleo_members m ON m.user_id = u.id AND m.nucleo_id = u.current_nucleo_id
       JOIN nucleos n ON n.id = m.nucleo_id WHERE u.id = ?`,
    )
    .bind(userId)
    .first<Nucleo>();
  if (row) return row;
  const first = (await listMemberships(db, userId))[0];
  if (!first) return null;
  await setCurrentNucleo(db, userId, first.id);
  return { id: first.id, name: first.name, role: first.role };
}

/** Only switches to a núcleo the user belongs to; returns false otherwise. */
export async function setCurrentNucleo(db: D1Database, userId: number, nucleoId: number): Promise<boolean> {
  const r = await db
    .prepare("UPDATE users SET current_nucleo_id = ? WHERE id = ? AND EXISTS (SELECT 1 FROM nucleo_members WHERE nucleo_id = ? AND user_id = ?)")
    .bind(nucleoId, userId, nucleoId, userId)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/** New núcleo with its preset categories; the creator is its admin and switches to it. */
export async function createNucleo(db: D1Database, userId: number, name: string): Promise<number> {
  const r = await db.prepare("INSERT INTO nucleos (name, created_by) VALUES (?, ?)").bind(name, userId).run();
  const id = Number(r.meta.last_row_id);
  await db.batch([
    db.prepare("INSERT INTO nucleo_members (nucleo_id, user_id, role) VALUES (?, ?, 'admin')").bind(id, userId),
    db.prepare("UPDATE users SET current_nucleo_id = ? WHERE id = ?").bind(id, userId),
  ]);
  await seedPresets(db, id);
  return id;
}

export async function renameNucleo(db: D1Database, nucleoId: number, name: string): Promise<void> {
  await db.prepare("UPDATE nucleos SET name = ? WHERE id = ?").bind(name, nucleoId).run();
}

export async function listMembers(db: D1Database, nucleoId: number): Promise<MemberRow[]> {
  const r = await db
    .prepare("SELECT m.user_id, u.email, m.role, m.joined_at FROM nucleo_members m JOIN users u ON u.id = m.user_id WHERE m.nucleo_id = ? ORDER BY m.joined_at, u.id")
    .bind(nucleoId)
    .all<MemberRow>();
  return r.results;
}

export async function countAdmins(db: D1Database, nucleoId: number): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM nucleo_members WHERE nucleo_id = ? AND role = 'admin'").bind(nucleoId).first<{ n: number }>();
  return r?.n ?? 0;
}

/** Adds (or keeps) a membership; an existing member keeps their role. Makes it current when they had none. */
export async function addMember(db: D1Database, nucleoId: number, userId: number, role: NucleoRole): Promise<void> {
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO nucleo_members (nucleo_id, user_id, role) VALUES (?, ?, ?)").bind(nucleoId, userId, role),
    db.prepare("UPDATE users SET current_nucleo_id = ? WHERE id = ? AND current_nucleo_id IS NULL").bind(nucleoId, userId),
  ]);
}

export type MemberChange = "ok" | "last_admin" | "not_member";

/** Demoting or removing the last admin would orphan the núcleo, so it is refused. */
export async function setRole(db: D1Database, nucleoId: number, userId: number, role: NucleoRole): Promise<MemberChange> {
  const cur = await db.prepare("SELECT role FROM nucleo_members WHERE nucleo_id = ? AND user_id = ?").bind(nucleoId, userId).first<{ role: NucleoRole }>();
  if (!cur) return "not_member";
  if (cur.role === "admin" && role !== "admin" && (await countAdmins(db, nucleoId)) <= 1) return "last_admin";
  await db.prepare("UPDATE nucleo_members SET role = ? WHERE nucleo_id = ? AND user_id = ?").bind(role, nucleoId, userId).run();
  return "ok";
}

export async function removeMember(db: D1Database, nucleoId: number, userId: number): Promise<MemberChange> {
  const cur = await db.prepare("SELECT role FROM nucleo_members WHERE nucleo_id = ? AND user_id = ?").bind(nucleoId, userId).first<{ role: NucleoRole }>();
  if (!cur) return "not_member";
  if (cur.role === "admin" && (await countAdmins(db, nucleoId)) <= 1) return "last_admin";
  await db.batch([
    db.prepare("DELETE FROM nucleo_members WHERE nucleo_id = ? AND user_id = ?").bind(nucleoId, userId),
    // Their pointer moves to whatever núcleo they still belong to (or none); currentNucleo() repairs it on next request.
    db.prepare("UPDATE users SET current_nucleo_id = NULL WHERE id = ? AND current_nucleo_id = ?").bind(userId, nucleoId),
  ]);
  return "ok";
}

function randomCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 100_000_000;
  return String(n).padStart(8, "0");
}

export async function createInvite(db: D1Database, nucleoId: number, byUserId: number, role: NucleoRole): Promise<string> {
  const code = randomCode();
  await db
    .prepare("INSERT INTO nucleo_invites (nucleo_id, code, role, created_by, expires_at) VALUES (?, ?, ?, ?, datetime('now', ?))")
    .bind(nucleoId, code, role, byUserId, `+${INVITE_TTL_DAYS} days`)
    .run();
  return code;
}

export async function listInvites(db: D1Database, nucleoId: number): Promise<InviteRow[]> {
  const r = await db
    .prepare(
      `SELECT i.id, i.code, i.role, i.created_at, i.expires_at, u.email AS created_by_email FROM nucleo_invites i
       LEFT JOIN users u ON u.id = i.created_by
       WHERE i.nucleo_id = ? AND i.used_at IS NULL AND i.expires_at > datetime('now') ORDER BY i.id DESC`,
    )
    .bind(nucleoId)
    .all<InviteRow>();
  return r.results;
}

export async function revokeInvite(db: D1Database, nucleoId: number, id: number): Promise<void> {
  await db.prepare("UPDATE nucleo_invites SET used_at = datetime('now') WHERE id = ? AND nucleo_id = ? AND used_at IS NULL").bind(id, nucleoId).run();
}

export type JoinResult = { kind: "ok"; nucleoId: number; name: string } | { kind: "wrong" } | { kind: "rate_limited" };

/**
 * Redeems an invite for a logged-in user: membership with the invite's role, núcleo becomes current.
 * Codes are not device-bound, so wrong guesses are rate-limited per IP bucket and globally.
 */
export async function joinWithInvite(db: D1Database, userId: number, ip: string, input: string): Promise<JoinResult> {
  const bucket = ipBucket(ip);
  const limits = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM invite_attempts WHERE ip_bucket = ? AND at > datetime('now', '-1 hour')) AS per_ip,
              (SELECT COUNT(*) FROM invite_attempts WHERE at > datetime('now', '-1 hour')) AS global`,
    )
    .bind(bucket)
    .first<{ per_ip: number; global: number }>();
  if ((limits?.per_ip ?? 0) >= INVITE_WRONG_PER_IP_PER_HOUR || (limits?.global ?? 0) >= INVITE_WRONG_GLOBAL_PER_HOUR) return { kind: "rate_limited" };

  const code = input.replace(/\D/g, "");
  const inv = code.length === 8
    ? await db
        .prepare(
          `SELECT i.id, i.nucleo_id, i.role, n.name FROM nucleo_invites i JOIN nucleos n ON n.id = i.nucleo_id
           WHERE i.code = ? AND i.used_at IS NULL AND i.expires_at > datetime('now') LIMIT 1`,
        )
        .bind(code)
        .first<{ id: number; nucleo_id: number; role: NucleoRole; name: string }>()
    : null;
  if (!inv) {
    await db.prepare("INSERT INTO invite_attempts (ip_bucket) VALUES (?)").bind(bucket).run();
    return { kind: "wrong" };
  }
  // Single use, race-safe: only the first redeemer flips used_at.
  const used = await db.prepare("UPDATE nucleo_invites SET used_at = datetime('now'), used_by = ? WHERE id = ? AND used_at IS NULL").bind(userId, inv.id).run();
  if (!used.meta.changes) return { kind: "wrong" };
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO nucleo_members (nucleo_id, user_id, role) VALUES (?, ?, ?)").bind(inv.nucleo_id, userId, inv.role),
    db.prepare("UPDATE users SET current_nucleo_id = ? WHERE id = ?").bind(inv.nucleo_id, userId),
  ]);
  return { kind: "ok", nucleoId: inv.nucleo_id, name: inv.name };
}
