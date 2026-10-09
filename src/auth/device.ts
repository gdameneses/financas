import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AppEnv, Device } from "../env";
import { randomToken, sha256Hex } from "./crypto";
import { adminEmails, emailAdmins } from "../lib/email";

export const DEVICE_COOKIE = "fin_device";
const DEVICE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year
const CODE_TTL_MIN = 30;
const CODE_MAX_ATTEMPTS = 5;
const REQUESTS_PER_IP_PER_HOUR = 3;

const DEVICE_COLS = "id, name, user_agent, status, requested_email, requested_ip, created_at, last_seen_at, approved_at, revoked_at";

export async function findDevice(db: D1Database, token: string | undefined): Promise<Device | null> {
  if (!token) return null;
  return db.prepare(`SELECT ${DEVICE_COLS} FROM devices WHERE token_hash = ?`).bind(await sha256Hex(token)).first<Device>();
}

export async function getDevice(db: D1Database, id: number): Promise<Device | null> {
  return db.prepare(`SELECT ${DEVICE_COLS} FROM devices WHERE id = ?`).bind(id).first<Device>();
}

export async function touchDevice(db: D1Database, id: number): Promise<void> {
  await db.prepare("UPDATE devices SET last_seen_at = datetime('now') WHERE id = ?").bind(id).run();
}

export function deviceTokenFromRequest(c: Context<AppEnv>): string | undefined {
  return getCookie(c, DEVICE_COOKIE);
}

export function isSecure(c: Context<AppEnv>): boolean {
  return new URL(c.req.url).protocol === "https:";
}

/** Creates the device row (status given) and sets its cookie. */
async function createDevice(c: Context<AppEnv>, name: string, email: string, ip: string, status: Device["status"]): Promise<Device> {
  const token = randomToken(32);
  const r = await c.env.DB.prepare(
    `INSERT INTO devices (token_hash, name, user_agent, status, requested_email, requested_ip, approved_at)
     VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ? = 'approved' THEN datetime('now') END)`,
  )
    .bind(await sha256Hex(token), name, c.req.header("user-agent") ?? "", status, email, ip, status)
    .run();
  setCookie(c, DEVICE_COOKIE, token, { httpOnly: true, secure: isSecure(c), sameSite: "Lax", path: "/", maxAge: DEVICE_MAX_AGE });
  return (await getDevice(c.env.DB, Number(r.meta.last_row_id)))!;
}

/** No approved device exists yet and the e-mail is an admin: the first device bootstraps itself. */
export async function isBootstrap(c: Context<AppEnv>, email: string): Promise<boolean> {
  if (!adminEmails(c.env).includes(email)) return false;
  const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE status = 'approved'").first<{ n: number }>();
  return (n?.n ?? 0) === 0;
}

export async function approveDevice(db: D1Database, deviceId: number, byUserId: number | null, allowIp: boolean): Promise<void> {
  const d = await getDevice(db, deviceId);
  if (!d) return;
  const stmts = [
    db.prepare("UPDATE devices SET status = 'approved', approved_by = ?, approved_at = datetime('now'), revoked_at = NULL WHERE id = ?").bind(byUserId, deviceId),
    db.prepare("UPDATE access_codes SET used_at = datetime('now') WHERE device_id = ? AND used_at IS NULL").bind(deviceId),
  ];
  if (allowIp && d.requested_ip) {
    stmts.push(
      db.prepare("INSERT OR IGNORE INTO allowed_ips (cidr, label, created_by) VALUES (?, ?, ?)").bind(d.requested_ip, `${d.name} (${d.requested_email})`, byUserId),
    );
  }
  await db.batch(stmts);
}

export async function denyDevice(db: D1Database, deviceId: number): Promise<void> {
  await db.batch([
    db.prepare("UPDATE devices SET status = 'denied' WHERE id = ?").bind(deviceId),
    db.prepare("UPDATE access_codes SET used_at = datetime('now') WHERE device_id = ? AND used_at IS NULL").bind(deviceId),
  ]);
}

export async function revokeDevice(db: D1Database, id: number): Promise<void> {
  await db.batch([
    db.prepare("UPDATE devices SET status = 'revoked', revoked_at = datetime('now') WHERE id = ?").bind(id),
    db.prepare("DELETE FROM sessions WHERE device_id = ?").bind(id),
  ]);
}

/** Auto-approval used only when LIBERADO=true. */
export async function autoApprove(c: Context<AppEnv>, ip: string): Promise<Device> {
  return createDevice(c, "liberado (sem código)", "", ip, "approved");
}

export type RequestResult = { kind: "approved"; device: Device } | { kind: "pending"; device: Device } | { kind: "rate_limited" };

/**
 * Unknown IP/device asks for access: creates (or reuses) the device, issues an 8-digit code,
 * sends it to the admins by e-mail and leaves it visible in-app. Bootstrap short-circuits to approved.
 */
export async function requestAccess(
  c: Context<AppEnv>,
  existing: Device | null,
  email: string,
  name: string,
  ip: string,
): Promise<RequestResult> {
  const db = c.env.DB;
  if (await isBootstrap(c, email)) {
    const device = existing
      ? ((await db.prepare("UPDATE devices SET status = 'approved', requested_email = ?, name = ?, requested_ip = ?, approved_at = datetime('now') WHERE id = ?").bind(email, name, ip, existing.id).run()), (await getDevice(db, existing.id))!)
      : await createDevice(c, name, email, ip, "approved");
    await db.prepare("INSERT OR IGNORE INTO allowed_ips (cidr, label) VALUES (?, ?)").bind(ip, `${name} (${email}) · primeiro acesso`).run();
    return { kind: "approved", device };
  }

  const recent = await db
    .prepare("SELECT COUNT(*) AS n FROM access_codes WHERE ip = ? AND created_at > datetime('now', '-1 hour')")
    .bind(ip)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= REQUESTS_PER_IP_PER_HOUR) return { kind: "rate_limited" };

  let device = existing;
  if (device && device.status !== "denied" && device.status !== "revoked") {
    await db.prepare("UPDATE devices SET status = 'pending', requested_email = ?, name = ?, requested_ip = ? WHERE id = ?").bind(email, name, ip, device.id).run();
    device = (await getDevice(db, device.id))!;
  } else {
    device = await createDevice(c, name, email, ip, "pending");
  }

  const code = String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  await db.batch([
    db.prepare("UPDATE access_codes SET used_at = datetime('now') WHERE device_id = ? AND used_at IS NULL").bind(device.id),
    db
      .prepare("INSERT INTO access_codes (code, device_id, ip, email, name, expires_at) VALUES (?, ?, ?, ?, ?, datetime('now', ?))")
      .bind(code, device.id, ip, email, name, `+${CODE_TTL_MIN} minutes`),
  ]);

  const text = `${name} (${email}) pediu acesso ao Finanças a partir do IP ${ip}.\n\nCódigo: ${code}\nVale por ${CODE_TTL_MIN} minutos. Você também vê este pedido em Mais → Acessos.`;
  const send = emailAdmins(c.env, `Pedido de acesso: ${name}`, text).then(async (ok) => {
    if (ok) await db.prepare("UPDATE access_codes SET emailed = 1 WHERE device_id = ? AND used_at IS NULL").bind(device!.id).run();
  });
  try {
    c.executionCtx.waitUntil(send);
  } catch {
    await send;
  }
  return { kind: "pending", device };
}

export type RedeemResult = "ok" | "wrong" | "expired" | "locked";

/** The person types the code the admin gave them. Approves the device and allows its IP. */
export async function redeemAccessCode(db: D1Database, device: Device, input: string): Promise<RedeemResult> {
  const row = await db
    .prepare("SELECT id, code, attempts, expires_at > datetime('now') AS live FROM access_codes WHERE device_id = ? AND used_at IS NULL ORDER BY id DESC LIMIT 1")
    .bind(device.id)
    .first<{ id: number; code: string; attempts: number; live: number }>();
  if (!row || !row.live) return "expired";
  if (row.attempts >= CODE_MAX_ATTEMPTS) return "locked";
  if (input.replace(/\D/g, "") !== row.code) {
    await db.prepare("UPDATE access_codes SET attempts = attempts + 1 WHERE id = ?").bind(row.id).run();
    return row.attempts + 1 >= CODE_MAX_ATTEMPTS ? "locked" : "wrong";
  }
  await approveDevice(db, device.id, null, true);
  return "ok";
}

export async function allowedCidrs(db: D1Database): Promise<string[]> {
  const r = await db.prepare("SELECT cidr FROM allowed_ips").all<{ cidr: string }>();
  return r.results.map((x) => x.cidr);
}
