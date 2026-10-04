import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.example.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
          // Access is not configured in tests (the auth tests set it explicitly), so the
          // dev bypass applies.
          ACCESS_TEAM_DOMAIN: "",
          ACCESS_AUD: "",
          DEV_DISABLE_AUTH: "true",
          // The report and time tests assume Europe/Brussels week boundaries.
          TIME_ZONE: "Europe/Brussels",
          REPORT_HOUR: "8",
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
