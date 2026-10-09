import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./env";
import { allowedCidrs, autoApprove, deviceTokenFromRequest, findDevice, touchDevice } from "./auth/device";
import { findSession, sessionTokenFromRequest } from "./auth/session";
import { clientIp, ipAllowed } from "./lib/ip";
import { logAccess, type Outcome } from "./lib/accesslog";

// Static assets must load on the gate pages too; they are not logged.
const PUBLIC_PREFIXES = ["/manifest.webmanifest", "/sw.js", "/app.css", "/app.js", "/icons/", "/offline.html"];
const isPublicAsset = (path: string) => PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(p));

/** Layer 0: serve assets, resolve the client IP, and log every other request after it completes. */
export const accessLog: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (isPublicAsset(path)) return c.env.ASSETS.fetch(c.req.raw);
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
 * Layer 2: IP allowlist (mandatory once non-empty) + approved device.
 * Anything that fails lands on /acesso, which is the only page reachable without both.
 */
export const requireIpAndDevice: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = new URL(c.req.url).pathname;
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

  if (ipOk && deviceOk) {
    if (path === "/acesso") return c.redirect("/");
    if (device!.last_seen_at.slice(0, 10) !== new Date().toISOString().slice(0, 10)) await touchDevice(c.env.DB, device!.id);
    return next();
  }

  c.set("outcome", !ipOk ? "ip_denied" : !device ? "device_unknown" : device.status === "pending" ? "device_pending" : "device_denied");
  if (path === "/acesso") return next();
  return c.redirect("/acesso");
};

/** Layer 3: login session bound to this device; banned users are logged out on the spot. */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const device = c.get("device");
  const s = await findSession(c, sessionTokenFromRequest(c), device.id);
  if (!s || s.banned) {
    c.set("outcome", s?.banned ? "banned" : "unauthenticated");
    const path = new URL(c.req.url).pathname;
    if (path.startsWith("/api/")) return c.text("Não autenticado", 401);
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
