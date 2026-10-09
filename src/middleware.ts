import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./env";
import { autoEnroll, deviceTokenFromRequest, findDevice, touchDevice } from "./auth/device";
import { findSession, sessionTokenFromRequest } from "./auth/session";

// Static assets (manifest, sw, css, icons) must load on the gate pages too.
const PUBLIC_PREFIXES = ["/manifest.webmanifest", "/sw.js", "/app.css", "/app.js", "/icons/", "/offline.html"];
const isPublicAsset = (path: string) => PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(p));

/** Layer 1: when REQUIRE_ACCESS=1, reject anything Cloudflare Access did not authenticate. */
export const requireAccess: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.env.REQUIRE_ACCESS === "1") {
    // Access injects this header on every authenticated request. We don't verify the JWT
    // ourselves: the workers.dev hostname is only reachable through Access, and the
    // device + session layers below do not trust this header for identity.
    if (!c.req.header("cf-access-jwt-assertion")) return c.text("Acesso negado", 403);
  }
  await next();
};

/** Layer 2: enrolled device. */
export const requireDevice: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (isPublicAsset(path)) return c.env.ASSETS.fetch(c.req.raw);
  let device = await findDevice(c.env.DB, deviceTokenFromRequest(c));
  if (!device && c.env.LIBERADO === "true") {
    // Gate disabled: enroll this browser on the spot so the rest of the app works unchanged.
    device = await autoEnroll(c);
    if (path === "/enroll") return c.redirect("/");
  }
  if (!device) {
    if (path === "/enroll") return next();
    return c.redirect("/enroll");
  }
  c.set("device", device);
  // Cheap write, but still only once per day per device.
  if (device.last_seen_at.slice(0, 10) !== new Date().toISOString().slice(0, 10)) {
    await touchDevice(c.env.DB, device.id);
  }
  await next();
};

/** Layer 3: login session bound to this device. */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const device = c.get("device");
  const s = await findSession(c.env.DB, sessionTokenFromRequest(c), device.id);
  if (!s) {
    const path = new URL(c.req.url).pathname;
    if (path.startsWith("/api/")) return c.text("Não autenticado", 401);
    return c.redirect("/login");
  }
  c.set("user", s.user);
  c.set("sessionId", s.sessionId);
  await next();
};
