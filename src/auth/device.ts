import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AppEnv, Device } from "../env";
import { randomToken, sha256Hex } from "./crypto";
import { adminEmails, emailAdmins } from "../lib/email";
import { ipBucket } from "../lib/ip";

export const DEVICE_COOKIE = "fin_device";
const DEVICE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year
const CODE_TTL_MIN = 30;
const CODE_MAX_ATTEMPTS = 5;
const REQUESTS_PER_IP_PER_HOUR = 3; // IPv6 counted per /64
const REQUESTS_GLOBAL_PER_HOUR = 20; // caps e-mail + D1 write amplification from anyone

const DEVICE_COLS = "id, name, user_agent, status, requested_email, requested_ip, created_at, last_seen_at, approved_by, approved_at, revoked_at, join_nucleo_id";

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

/** Cookies are always Secure except on localhost (wrangler dev over plain http). */
export function isSecure(c: Context<AppEnv>): boolean {
  const u = new URL(c.req.url);
  return !(u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname.endsWith(".local"));
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

/**
 * Bootstrap: the very first admin gets in with no code. Requires an admin e-mail AND an empty
 * system: zero approved devices AND zero users. (Zero devices alone could be reached again by
 * revoking the last device, which would re-open the door to anyone knowing an admin e-mail.)
 */
export async function isBootstrap(c: Context<AppEnv>, email: string): Promise<boolean> {
  if (!adminEmails(c.env).includes(email)) return false;
  const r = await c.env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM devices WHERE status = 'approved') AS d, (SELECT COUNT(*) FROM users) AS u",
  ).first<{ d: number; u: number }>();
  return !!r && r.d === 0 && r.u === 0;
}

/** `joinNucleoId`: the account registered on this device joins that núcleo as a member right away. */
export async function approveDevice(db: D1Database, deviceId: number, byUserId: number | null, allowIp: boolean, joinNucleoId: number | null = null): Promise<void> {
  const d = await getDevice(db, deviceId);
  if (!d || d.status !== "pending") return; // only pending requests can be approved
  const stmts = [
    db.prepare("UPDATE devices SET status = 'approved', approved_by = ?, approved_at = datetime('now'), revoked_at = NULL, join_nucleo_id = ? WHERE id = ?").bind(byUserId, joinNucleoId, deviceId),
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
    db.prepare("UPDATE access_codes SET used_at = datetime('now') WHERE device_id = ? AND used_at IS NULL").bind(id),
  ]);
}

/** Auto-approval used only when LIBERADO=true. */
export async function autoApprove(c: Context<AppEnv>, ip: string): Promise<Device> {
  return createDevice(c, "liberado (sem código)", "", ip, "approved");
}

export type RequestResult = { kind: "approved"; device: Device } | { kind: "pending"; device: Device } | { kind: "rate_limited" };

function randomCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 100_000_000;
  return String(n).padStart(8, "0");
}

/**
 * Unknown IP/device asks for access: creates (or reuses) the device, issues an 8-digit code,
 * sends it to the admins by e-mail and leaves it visible in-app. Bootstrap short-circuits to approved.
 * An already-approved device asking from a new IP keeps its status: the code only adds the IP.
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
    let device: Device;
    if (existing) {
      await db.prepare("UPDATE devices SET status = 'approved', requested_email = ?, name = ?, requested_ip = ?, approved_at = datetime('now') WHERE id = ?")
        .bind(email, name, ip, existing.id)
        .run();
      device = (await getDevice(db, existing.id))!;
    } else {
      device = await createDevice(c, name, email, ip, "approved");
    }
    await db.prepare("INSERT OR IGNORE INTO allowed_ips (cidr, label) VALUES (?, ?)").bind(ip, `${name} (${email}) · primeiro acesso`).run();
    return { kind: "approved", device };
  }

  const limits = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM access_codes WHERE ip_bucket = ? AND created_at > datetime('now', '-1 hour')) AS per_ip,
              (SELECT COUNT(*) FROM access_codes WHERE created_at > datetime('now', '-1 hour')) AS global`,
    )
    .bind(ipBucket(ip))
    .first<{ per_ip: number; global: number }>();
  if ((limits?.per_ip ?? 0) >= REQUESTS_PER_IP_PER_HOUR || (limits?.global ?? 0) >= REQUESTS_GLOBAL_PER_HOUR) return { kind: "rate_limited" };

  let device = existing;
  if (device && device.status === "approved") {
    // Keep approved; only remember the IP being asked for. The e-mail stays what it was approved
    // for (v1-migrated devices had none: the first request fills it, but it never becomes an admin
    // address that way — registration for admins is gated separately).
    await db.prepare("UPDATE devices SET requested_ip = ?, requested_email = CASE WHEN requested_email = '' THEN ? ELSE requested_email END, name = CASE WHEN requested_email = '' THEN ? ELSE name END WHERE id = ?")
      .bind(ip, email, name, device.id)
      .run();
    device = (await getDevice(db, device.id))!;
  } else if (device && device.status === "pending") {
    await db.prepare("UPDATE devices SET requested_email = ?, name = ?, requested_ip = ? WHERE id = ?").bind(email, name, ip, device.id).run();
    device = (await getDevice(db, device.id))!;
  } else {
    // No device, or a denied/revoked one: a fresh row, so an admin decision is needed again.
    device = await createDevice(c, name, email, ip, "pending");
  }

  const code = randomCode();
  await db.batch([
    db.prepare("UPDATE access_codes SET used_at = datetime('now') WHERE device_id = ? AND used_at IS NULL").bind(device.id),
    db
      .prepare("INSERT INTO access_codes (code, device_id, ip, ip_bucket, email, name, expires_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))")
      .bind(code, device.id, ip, ipBucket(ip), device.requested_email || email, name, `+${CODE_TTL_MIN} minutes`),
  ]);

  // Also in the Worker logs (Cloudflare dashboard → Workers → finance → Logs, or `wrangler tail`),
  // so an admin can read it without the app or e-mail. Only account members see those logs.
  console.log(`[acesso] código ${code} para ${name} <${email}> do IP ${ip} (vale ${CODE_TTL_MIN} min)`);
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

/**
 * The person types the code the admin gave them. A pending device becomes approved; an
 * approved device (new network) only gets its IP allowed. Denied/revoked devices cannot redeem.
 */
export async function redeemAccessCode(db: D1Database, device: Device, input: string): Promise<RedeemResult> {
  if (device.status !== "pending" && device.status !== "approved") return "expired";
  const row = await db
    .prepare("SELECT id, code, attempts, ip, expires_at > datetime('now') AS live FROM access_codes WHERE device_id = ? AND used_at IS NULL ORDER BY id DESC LIMIT 1")
    .bind(device.id)
    .first<{ id: number; code: string; attempts: number; ip: string; live: number }>();
  if (!row || !row.live) return "expired";
  if (row.attempts >= CODE_MAX_ATTEMPTS) return "locked";
  // Count the attempt before comparing, so parallel guesses cannot exceed the cap.
  const bump = await db.prepare("UPDATE access_codes SET attempts = attempts + 1 WHERE id = ? AND attempts < ?").bind(row.id, CODE_MAX_ATTEMPTS).run();
  if (!bump.meta.changes) return "locked";
  if (input.replace(/\D/g, "") !== row.code) return row.attempts + 1 >= CODE_MAX_ATTEMPTS ? "locked" : "wrong";
  if (device.status === "pending") {
    await approveDevice(db, device.id, null, true);
  } else {
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO allowed_ips (cidr, label) VALUES (?, ?)").bind(row.ip, `${device.name} (${device.requested_email}) · rede nova`),
      db.prepare("UPDATE access_codes SET used_at = datetime('now') WHERE id = ?").bind(row.id),
    ]);
  }
  return "ok";
}

export async function allowedCidrs(db: D1Database): Promise<string[]> {
  const r = await db.prepare("SELECT cidr FROM allowed_ips").all<{ cidr: string }>();
  return r.results.map((x) => x.cidr);
}
