import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { applySchema, queryDb } from "./helpers.js";
import { getBusinessTimezone } from "../src/server/business-timezone.js";
import { initDB } from "../src/server/db.js";

// Section 23's mandatory Fresh-Database Test: proves a brand-new database,
// immediately after migrations run and BEFORE anything else touches it, has
// BUSINESS_TIMEZONE = America/Vancouver with zero manual SQL. This is
// deliberately its own file with NO resetDatabase()/beforeEach — every
// other test file's beforeEach wipes `global_settings` between tests (by
// design, so settings tests get a clean slate), which would destroy the
// exact state this test exists to observe. applySchema() is documented as
// "safe to call exactly once per test-file DB" (test/helpers.ts) — this
// file honors that by calling it once, in beforeAll, and never resetting
// afterward; both tests below read state, neither mutates it, so sharing
// the one post-migration DB between them is safe and still proves the real
// question: does a migration alone — with no admin ever opening Global
// Settings — already produce a safe, non-UTC value?
beforeAll(async () => {
  await applySchema();
  // This file never makes an HTTP request (which would normally trigger
  // @clawnify/app's own initDB(c.env) middleware) before calling
  // getBusinessTimezone() directly — same reason src/server/index.ts's
  // scheduled() entry point calls this explicitly (see its own comment).
  initDB(env);
});

describe("fresh-database migration — BUSINESS_TIMEZONE is safe with zero manual SQL", () => {
  it("a freshly migrated database already has BUSINESS_TIMEZONE = America/Vancouver, with no operator action required", async () => {
    const rows = await queryDb<{ value: string; data_type: string; category: string }>(
      "SELECT value, data_type, category FROM global_settings WHERE key = 'BUSINESS_TIMEZONE' AND effective_until IS NULL"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ value: "America/Vancouver", data_type: "string", category: "business_operations" });

    // And the shared resolver agrees, with zero configuration beyond what
    // migrations/0012 itself seeded.
    expect(await getBusinessTimezone()).toBe("America/Vancouver");
  });

  it("re-applying migrations is idempotent — exactly one BUSINESS_TIMEZONE row total, never a duplicate", async () => {
    const rows = await queryDb<{ id: number }>("SELECT id FROM global_settings WHERE key = 'BUSINESS_TIMEZONE'");
    expect(rows).toHaveLength(1);
  });
});
