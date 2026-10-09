import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv, Device } from "../env";
import { randomToken, sha256Hex, timingSafeEqualHex } from "./crypto";

export const DEVICE_COOKIE = "fin_device";
const DEVICE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year
const ENROLL_CODE_TTL_MIN = 10;

export async function findDevice(db: D1Database, token: string | undefined): Promise<Device | null> {
  if (!token) return null;
  const row = await db
    .prepare("SELECT id, name, user_agent, created_at, last_seen_at, revoked_at FROM devices WHERE token_hash = ?")
    .bind(await sha256Hex(token))
    .first<Device>();
  if (!row || row.revoked_at) return null;
  return row;
}

export async function touchDevice(db: D1Database, id: number): Promise<void> {
  await db.prepare("UPDATE devices SET last_seen_at = datetime('now') WHERE id = ?").bind(id).run();
}

/** Creates a device row and sets its cookie. Returns the new device id. */
export async function enrollDevice(c: Context<AppEnv>, name: string): Promise<number> {
  const token = randomToken(32);
  const res = await c.env.DB.prepare("INSERT INTO devices (token_hash, name, user_agent) VALUES (?, ?, ?)")
    .bind(await sha256Hex(token), name, c.req.header("user-agent") ?? "")
    .run();
  setCookie(c, DEVICE_COOKIE, token, {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: "Lax",
    path: "/",
    maxAge: DEVICE_MAX_AGE,
  });
  return Number(res.meta.last_row_id);
}

export async function revokeDevice(db: D1Database, id: number): Promise<void> {
  await db.batch([
    db.prepare("UPDATE devices SET revoked_at = datetime('now') WHERE id = ?").bind(id),
    db.prepare("DELETE FROM sessions WHERE device_id = ?").bind(id),
  ]);
}

export function clearDeviceCookie(c: Context<AppEnv>): void {
  deleteCookie(c, DEVICE_COOKIE, { path: "/" });
}

export function deviceTokenFromRequest(c: Context<AppEnv>): string | undefined {
  return getCookie(c, DEVICE_COOKIE);
}

/** 8-char code, single use, 10 min. Returned in clear once; only the hash is stored. */
export async function createEnrollCode(db: D1Database, createdByDevice: number): Promise<string> {
  const code = randomToken(4).toUpperCase(); // 8 hex chars
  await db
    .prepare(
      "INSERT INTO enroll_codes (code_hash, created_by_device, expires_at) VALUES (?, ?, datetime('now', ?))",
    )
    .bind(await sha256Hex(code), createdByDevice, `+${ENROLL_CODE_TTL_MIN} minutes`)
    .run();
  return code;
}

/**
 * Accepts either a live enroll code or the ENROLL_SECRET bootstrap secret
 * (only while no device exists yet). Consumes the code on success.
 */
export async function redeemEnrollCode(
  db: D1Database,
  input: string,
  enrollSecret: string | undefined,
): Promise<boolean> {
  const normalized = input.trim().toUpperCase();
  const hash = await sha256Hex(normalized);
  const row = await db
    .prepare("SELECT code_hash FROM enroll_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > datetime('now')")
    .bind(hash)
    .first<{ code_hash: string }>();
  if (row) {
    await db.prepare("UPDATE enroll_codes SET used_at = datetime('now') WHERE code_hash = ?").bind(hash).run();
    return true;
  }
  if (enrollSecret) {
    const count = await db.prepare("SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL").first<{ n: number }>();
    if (count && count.n === 0 && timingSafeEqualHex(input.trim(), enrollSecret)) return true;
  }
  return false;
}

export function isSecure(c: Context<AppEnv>): boolean {
  return new URL(c.req.url).protocol === "https:";
}
