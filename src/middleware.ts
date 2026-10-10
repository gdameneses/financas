import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./env";
import { allowedCidrs, autoApprove, deviceTokenFromRequest, findDevice, isSecure, touchDevice } from "./auth/device";
import { findSession, sessionTokenFromRequest } from "./auth/session";
import { clientIp, ipAllowed } from "./lib/ip";
import { logAccess, type Outcome } from "./lib/accesslog";

// Static assets must load on the gate pages too; they are not logged.
const PUBLIC_FILES = new Set(["/manifest.webmanifest", "/sw.js", "/app.css", "/app.js", "/offline.html"]);
const isPublicAsset = (path: string) => PUBLIC_FILES.has(path) || path.startsWith("/icons/") || path.startsWith("/vendor/");

// NOTE: every path comparison below uses c.req.path, the decoded path Hono routes on
// (so "/%61cesso" and "/acesso" are the same page here and in the router).

/** Layer 0: https only (except localhost), assets, client IP, and one access_log row per request. */
export const accessLog: MiddlewareHandler<AppEnv> = async (c, next) => {
  const url = new URL(c.req.url);
  if (url.protocol === "http:" && isSecure(c)) {
    url.protocol = "https:";
    return c.redirect(url.toString(), 301);
  }
  if (isPublicAsset(c.req.path)) return c.env.ASSETS.fetch(c.req.raw);
  c.set("ip", clientIp(c.req.raw));
  await next();
  const outcome = (c.get("outcome") as Outcome | undefined) ?? (c.res.status >= 400 ? "forbidden" : "ok");
  logAccess(c, c.res.status, outcome);
};

/** Layer 1: when REQUIRE_ACCESS=1, reject anything Cloudflare Access did not authenticate. */
export const requireAccess: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.env.REQUIRE_ACCESS === "1" && !c.req.header("cf-access-jwt-assertion")) {
    c.set("outcome", "forbidden");
    return c.text("Acesso negado", 403);
  }
  await next();
};

/**
 * Layer 2: approved device, or (for anything else) the IP allowlist.
 * Unknown/pending/denied devices only ever see /acesso; an approved device passes from any
 * network and the new network is recorded (allowed_ips + access_log outcome "ip_auto").
 */
export const requireIpAndDevice: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = c.req.path;
  const ip = c.get("ip");
  let device = await findDevice(c.env.DB, deviceTokenFromRequest(c));
  if (device) c.set("device", device);

  if (c.env.LIBERADO === "true") {
    if (!device || device.status !== "approved") {
      device = await autoApprove(c, ip);
      c.set("device", device);
    }
    if (path === "/acesso") return c.redirect("/");
    return next();
  }

  const cidrs = await allowedCidrs(c.env.DB);
  const ipOk = cidrs.length === 0 || ipAllowed(ip, cidrs);
  const deviceOk = device?.status === "approved";

  if (deviceOk) {
    if (!ipOk) {
      // An approved device is trusted on any network: let it through and remember the network,
      // so a phone leaving the house Wi-Fi is never locked out. The list stays mandatory for everyone else.
      await c.env.DB.prepare("INSERT OR IGNORE INTO allowed_ips (cidr, label) VALUES (?, ?)").bind(ip, `automático · ${device!.name}`).run();
      c.set("outcome", "ip_auto");
    }
    if (path === "/acesso") return c.redirect("/");
    if (device!.last_seen_at.slice(0, 10) !== new Date().toISOString().slice(0, 10)) await touchDevice(c.env.DB, device!.id);
    return next();
  }

  c.set("outcome", !ipOk ? "ip_denied" : !device ? "device_unknown" : device.status === "pending" ? "device_pending" : "device_denied");
  if (path === "/acesso" && (c.req.method === "GET" || c.req.method === "POST")) return next();
  return c.redirect("/acesso");
};

/** Layer 3: login session bound to this device; banned users are logged out on the spot. */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const device = c.get("device");
  if (!device) return c.redirect("/acesso"); // unreachable in practice; never dereference undefined
  const s = await findSession(c, sessionTokenFromRequest(c), device.id);
  if (!s || s.banned) {
    c.set("outcome", s?.banned ? "banned" : "unauthenticated");
    if (c.req.path.startsWith("/api/")) return c.text("Não autenticado", 401);
    return c.redirect("/login");
  }
  c.set("user", s.user);
  c.set("sessionId", s.sessionId);
  await next();
};

/** Layer 4: admin-only routes. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get("user").admin) {
    c.set("outcome", "forbidden");
    return c.text("Só para administradores", 403);
  }
  await next();
};

/** Route ids: anything that is not a positive integer is "not found", never NaN bound to SQL. */
export function parseId(raw: string): number | null {
  return /^\d{1,12}$/.test(raw) ? Number(raw) : null;
}
