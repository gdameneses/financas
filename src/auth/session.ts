import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv, User } from "../env";
import { randomToken, sha256Hex } from "./crypto";
import { isSecure } from "./device";
import { adminEmails } from "../lib/email";

export const SESSION_COOKIE = "fin_session";
const SESSION_DAYS = 90;
const SESSION_MAX_AGE = 60 * 60 * 24 * SESSION_DAYS;
// Sliding expiry: only rewrite the row when less than this many days remain,
// so a normal page view costs zero D1 writes.
const REFRESH_WHEN_UNDER_DAYS = 60;

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MIN = 15;

type SessionRow = { id: number; user_id: number; email: string; banned_at: string | null; expires_at: string };

export async function findSession(
  c: Context<AppEnv>,
  token: string | undefined,
  deviceId: number,
): Promise<{ sessionId: number; user: User; banned: boolean } | null> {
  if (!token) return null;
  const db = c.env.DB;
  const row = await db
    .prepare(
      `SELECT s.id, s.user_id, u.email, u.banned_at, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.device_id = ? AND s.expires_at > datetime('now')`,
    )
    .bind(await sha256Hex(token), deviceId)
    .first<SessionRow>();
  if (!row) return null;
  if (row.banned_at) {
    await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(row.user_id).run();
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return { sessionId: row.id, user: toUser(c, row), banned: true };
  }
  const remainingMs = Date.parse(row.expires_at + "Z") - Date.now();
  if (remainingMs < REFRESH_WHEN_UNDER_DAYS * 86_400_000) {
    await db.prepare("UPDATE sessions SET expires_at = datetime('now', ?) WHERE id = ?").bind(`+${SESSION_DAYS} days`, row.id).run();
  }
  return { sessionId: row.id, user: toUser(c, row), banned: false };
}

function toUser(c: Context<AppEnv>, row: { user_id: number; email: string }): User {
  return { id: row.user_id, email: row.email, admin: adminEmails(c.env).includes(row.email) };
}

export async function createSession(c: Context<AppEnv>, userId: number, deviceId: number): Promise<void> {
  const token = randomToken(32);
  await c.env.DB.prepare("INSERT INTO sessions (token_hash, device_id, user_id, expires_at) VALUES (?, ?, ?, datetime('now', ?))")
    .bind(await sha256Hex(token), deviceId, userId, `+${SESSION_DAYS} days`)
    .run();
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: isSecure(c), sameSite: "Lax", path: "/", maxAge: SESSION_MAX_AGE });
}

export async function destroySession(c: Context<AppEnv>, sessionId: number): Promise<void> {
  await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export function sessionTokenFromRequest(c: Context<AppEnv>): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

export async function loginRateLimited(db: D1Database, deviceId: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE device_id = ? AND at > datetime('now', ?)")
    .bind(deviceId, `-${LOGIN_WINDOW_MIN} minutes`)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= LOGIN_MAX_ATTEMPTS;
}

export async function recordLoginAttempt(db: D1Database, deviceId: number): Promise<void> {
  await db.prepare("INSERT INTO login_attempts (device_id) VALUES (?)").bind(deviceId).run();
}

export async function clearLoginAttempts(db: D1Database, deviceId: number): Promise<void> {
  await db.prepare("DELETE FROM login_attempts WHERE device_id = ?").bind(deviceId).run();
}

/** Ban: sessions die now, devices approved for that e-mail are revoked. */
export async function banUser(db: D1Database, userId: number, email: string): Promise<void> {
  await db.batch([
    db.prepare("UPDATE users SET banned_at = datetime('now') WHERE id = ?").bind(userId),
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    db.prepare("UPDATE devices SET status = 'revoked', revoked_at = datetime('now') WHERE requested_email = ? AND status = 'approved'").bind(email),
  ]);
}

export async function unbanUser(db: D1Database, userId: number): Promise<void> {
  await db.prepare("UPDATE users SET banned_at = NULL WHERE id = ?").bind(userId).run();
}
