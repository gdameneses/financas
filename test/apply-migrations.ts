import { applyD1Migrations, env } from "cloudflare:test";

// Runs once per test file: fresh D1 with the schema + preset categories applied.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
