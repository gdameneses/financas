// Every request to the app (not static assets) writes one access_log row, after the
// response is sent, so logging never adds latency to the page.
import type { Context } from "hono";
import type { AppEnv } from "../env";

export type Outcome =
  | "ok"
  | "ip_denied"
  | "device_unknown"
  | "device_pending"
  | "device_denied"
  | "unauthenticated"
  | "banned"
  | "forbidden";

export function logAccess(c: Context<AppEnv>, status: number, outcome: Outcome): void {
  const req = c.req.raw;
  const cf = (req as Request & { cf?: { country?: string } }).cf;
  const stmt = c.env.DB.prepare(
    "INSERT INTO access_log (ip, country, user_agent, device_id, user_id, method, path, status, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    c.get("ip") ?? "",
    cf?.country ?? "",
    (req.headers.get("user-agent") ?? "").slice(0, 200),
    c.get("device")?.id ?? null,
    c.get("user")?.id ?? null,
    req.method,
    new URL(req.url).pathname.slice(0, 200),
    status,
    outcome,
  );
  const run = stmt.run().catch((e) => console.error("access_log", e));
  try {
    c.executionCtx.waitUntil(run);
  } catch {
    // No execution context (unit tests): the promise still runs.
  }
}
