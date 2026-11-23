// Browser-side hardening for every response the Worker produces. Static files served straight from
// ./public (without running the Worker) get the same headers from public/_headers.
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";

// Conservative on purpose: the pages still use inline <script> blocks and inline on* handlers, so
// there is no script-src here. What it does stop: being framed (clickjacking), <base> hijacking,
// plugins, and forms posting anywhere but this app.
export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=(), midi=(), display-capture=(), interest-cohort=()",
  "cross-origin-opener-policy": "same-origin",
};

/** Adds SECURITY_HEADERS to whatever the rest of the app (or the assets binding) returned. */
export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  // Responses from env.ASSETS.fetch have immutable headers: copy before touching them.
  const res = new Response(c.res.body, c.res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  c.res = res;
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF backstop on top of the SameSite=Lax cookies: a state-changing request must come from this
 * app's own pages. Browsers send Origin on every POST; when it is missing (old browsers, curl) we
 * fall back to Sec-Fetch-Site and let the request through only if that is not "cross-site".
 */
export function crossSiteWrite(req: Request): boolean {
  if (SAFE_METHODS.has(req.method)) return false;
  const origin = req.headers.get("origin");
  if (origin) return origin !== new URL(req.url).origin;
  const site = req.headers.get("sec-fetch-site");
  return site === "cross-site";
}
