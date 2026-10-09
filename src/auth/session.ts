import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv, User } from "../env";
import { randomToken, sha256Hex } from "./crypto";
import { isSecure } from "./device";

export const SESSION_COOKIE = "fin_session";
const SESSION_DAYS = 90;
const SESSION_MAX_AGE = 60 * 60 * 24 * SESSION_DAYS;
// Sliding expiry: only rewrite the row when less than this many days remain,
// so a normal page view costs zero D1 writes.
const REFRESH_WHEN_UNDER_DAYS = 60;

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MIN = 15;

type SessionRow = { id: number; user_id: number; email: string; expires_at: string };

export async function findSession(
  db: D1Database,
  token: string | undefined,
  deviceId: number,
): Promise<{ sessionId: number; user: User } | null> {
  if (!token) return null;
  const row = await db
    .prepare(
      `SELECT s.id, s.user_id, u.email, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.device_id = ? AND s.expires_at > datetime('now')`,
    )
    .bind(await sha256Hex(token), deviceId)
    .first<SessionRow>();
  if (!row) return null;
  const remainingMs = Date.parse(row.expires_at + "Z") - Date.now();
  if (remainingMs < REFRESH_WHEN_UNDER_DAYS * 86_400_000) {
    await db
      .prepare("UPDATE sessions SET expires_at = datetime('now', ?) WHERE id = ?")
      .bind(`+${SESSION_DAYS} days`, row.id)
      .run();
  }
  return { sessionId: row.id, user: { id: row.user_id, email: row.email } };
}

export async function createSession(c: Context<AppEnv>, userId: number, deviceId: number): Promise<void> {
  const token = randomToken(32);
  await c.env.DB.prepare(
    "INSERT INTO sessions (token_hash, device_id, user_id, expires_at) VALUES (?, ?, ?, datetime('now', ?))",
  )
    .bind(await sha256Hex(token), deviceId, userId, `+${SESSION_DAYS} days`)
    .run();
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
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
