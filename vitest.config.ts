import { readdir, readFile } from "node:fs/promises";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/** Concatenates every migrations/*.sql file in order — same source of truth
 *  `wrangler d1 migrations apply` uses for real dev/prod databases, so tests
 *  can never drift from what actually gets applied. */
async function buildSchemaStatements(): Promise<string[]> {
  const files = (await readdir("./migrations")).filter((f) => f.endsWith(".sql")).sort();
  const statements: string[] = [];
  for (const file of files) {
    const contents = await readFile(`./migrations/${file}`, "utf8");
    statements.push(
      ...contents
        .replace(/^\s*--.*$/gm, "")
        .split(";")
        .map((statement) => statement.trim())
        .filter(Boolean)
    );
  }
  return statements;
}

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const schemaStatements = await buildSchemaStatements();
      return {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_SCHEMA_STATEMENTS: JSON.stringify(schemaStatements),
            // Fixed test-only values — Google API calls are mocked in tests (see
            // test/helpers.ts mockGoogleFetch), so these never reach real Google.
            GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
            GOOGLE_CLIENT_SECRET: "test-client-secret",
            GOOGLE_REDIRECT_URI: "http://example.test/api/integrations/google-calendar/callback",
            TOKEN_ENCRYPTION_KEY: "hW9UKowF8eF7Yn1z0u68I5uKCKwqcPMlokJDsy8gTDk=",
            // Phase 9.2 — fixed test-only values. Resend/Twilio calls are
            // mocked in tests (see test/helpers.ts mockNotificationProviders),
            // so these never reach a real provider.
            RESEND_API_KEY: "test-resend-key",
            RESEND_FROM_ADDRESS: "notifications@example.test",
            TWILIO_ACCOUNT_SID: "test-twilio-sid",
            TWILIO_AUTH_TOKEN: "test-twilio-token",
            TWILIO_FROM_NUMBER: "+15550100000",
          },
        },
      };
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    // PBKDF2 password hashing (100k iterations) runs on nearly every test via
    // authHeaders()/loginAs(); give it headroom beyond Vitest's 5s default.
    testTimeout: 20000,
  },
});
