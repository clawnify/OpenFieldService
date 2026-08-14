import { readFile } from "node:fs/promises";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const schema = await readFile("./src/server/schema.sql", "utf8");
      const schemaStatements = schema
        .replace(/^\s*--.*$/gm, "")
        .split(";")
        .map((statement) => statement.trim())
        .filter(Boolean);
      return {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_SCHEMA_STATEMENTS: JSON.stringify(schemaStatements),
          },
        },
      };
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
