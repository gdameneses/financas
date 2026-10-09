import { env } from "cloudflare:test";

/**
 * Deterministic clean slate: wipe every mutable table and re-run the migration's
 * own preset-category INSERT so tests don't depend on the plugin's storage isolation.
 */
export async function resetDb(): Promise<void> {
  const all = env.TEST_MIGRATIONS.flatMap((m) => m.queries);
  const seed = all.find((q) => q.includes("INSERT INTO categories"));
  const iconMap = all.find((q) => q.includes("UPDATE categories SET icon = CASE"));
  if (!seed || !iconMap) throw new Error("preset seed not found in migrations");
  await env.DB.batch([
    // Children before parents: several tables reference users and devices.
    env.DB.prepare("DELETE FROM access_log"),
    env.DB.prepare("DELETE FROM access_codes"),
    env.DB.prepare("DELETE FROM login_attempts"),
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM allowed_ips"),
    env.DB.prepare("DELETE FROM budgets"),
    env.DB.prepare("DELETE FROM transactions"),
    env.DB.prepare("DELETE FROM devices"),
    env.DB.prepare("DELETE FROM users"),
    env.DB.prepare("DELETE FROM categories"),
    env.DB.prepare(seed),
    env.DB.prepare(iconMap),
  ]);
}
