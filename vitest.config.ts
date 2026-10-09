import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import path from "node:path";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Explicit so a developer's .dev.vars (e.g. LIBERADO=true) can't change test behaviour.
          bindings: { TEST_MIGRATIONS: migrations, ENROLL_SECRET: "test-enroll-secret", LIBERADO: "false", REQUIRE_ACCESS: "0" },
        },
      }),
    ],
    test: {
      globals: true,
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
