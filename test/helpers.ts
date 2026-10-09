import { env } from "cloudflare:test";

/**
 * Deterministic clean slate: wipe every mutable table and re-run the migration's
 * own preset-category INSERT so tests don't depend on the plugin's storage isolation.
 */
export async function resetDb(): Promise<void> {
  const seed = env.TEST_MIGRATIONS.flatMap((m) => m.queries).find((q) => q.includes("INSERT INTO categories"));
  if (!seed) throw new Error("preset seed not found in migrations");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM login_attempts"),
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM enroll_codes"),
    env.DB.prepare("DELETE FROM devices"),
    env.DB.prepare("DELETE FROM users"),
    env.DB.prepare("DELETE FROM budgets"),
    env.DB.prepare("DELETE FROM transactions"),
    env.DB.prepare("DELETE FROM categories"),
    env.DB.prepare(seed),
  ]);
}
