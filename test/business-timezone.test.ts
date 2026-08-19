import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applySchema, authHeaders, createUser, del, loginAs, post, queryDb, request, requestRaw, resetDatabase,
} from "./helpers.js";
import {
  DEFAULT_BUSINESS_TIMEZONE, getBusinessTimezone, isValidIanaTimezone,
} from "../src/server/business-timezone.js";

// Global Business Timezone setting — promotes the previously-hidden
// `_meta.timezone` into the existing versioned Global Settings architecture
// (migrations/0012). See mem:risks/google-calendar-timezone-default for the
// incident this closes and test/calendar-sync.test.ts /
// test/notification-dispatcher.test.ts for the Calendar/Notification
// integration side of this same resolver. The mandatory fresh-database
// migration test lives in its own file
// (test/business-timezone-fresh-db.test.ts) since it must observe state
// immediately after migrations run, before this file's own
// resetDatabase()-per-test hook would wipe it.

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

describe("isValidIanaTimezone (server-side validation, no client trusted)", () => {
  it("accepts real IANA Area/Location zone ids", () => {
    for (const tz of ["America/Vancouver", "America/Los_Angeles", "America/Denver", "America/Toronto", "America/New_York"]) {
      expect(isValidIanaTimezone(tz)).toBe(true);
    }
  });

  it("accepts the literal 'UTC' (a real, legitimate zone id, just not in the canonical Area/Location enumeration)", () => {
    expect(isValidIanaTimezone("UTC")).toBe(true);
  });

  it("rejects fixed offsets — not DST-safe", () => {
    expect(isValidIanaTimezone("-07:00")).toBe(false);
    expect(isValidIanaTimezone("UTC-7")).toBe(false);
    expect(isValidIanaTimezone("UTC-8")).toBe(false);
  });

  it("rejects legacy abbreviations — not DST-safe (ICU accepts 'PST' as a zone name but it never becomes 'PDT' in summer)", () => {
    expect(isValidIanaTimezone("PST")).toBe(false);
  });

  it("rejects a bare city name (not a real IANA id)", () => {
    expect(isValidIanaTimezone("Vancouver")).toBe(false);
  });

  it("rejects a made-up zone id", () => {
    expect(isValidIanaTimezone("America/FakeCity")).toBe(false);
  });
});

describe("Global Settings: BUSINESS_TIMEZONE", () => {
  it("accepts a valid IANA timezone from an admin", async () => {
    const auth = await authHeaders();
    const res = await post<{ setting: { key: string; value: string } }>("/api/settings", {
      key: "BUSINESS_TIMEZONE", value: "America/Toronto", data_type: "string", category: "business_operations",
    }, auth);
    expect(res.response.status).toBe(201);
    expect(res.body.setting).toMatchObject({ key: "BUSINESS_TIMEZONE", value: "America/Toronto" });
  });

  it("rejects a fixed offset, an abbreviation, and a made-up zone — server-side, never trusting the client", async () => {
    const auth = await authHeaders();
    for (const bad of ["UTC-7", "PST", "Vancouver", "America/FakeCity"]) {
      const res = await post<{ error: string }>("/api/settings", {
        key: "BUSINESS_TIMEZONE", value: bad, data_type: "string",
      }, auth);
      expect(res.response.status).toBe(400);
    }
  });

  it("an admin can update it; a dispatcher and a technician cannot", async () => {
    const auth = await authHeaders();
    await createUser({ email: "dispatch-tz@example.test", password: "DispatchPass1", role: "dispatcher" });
    await createUser({ email: "tech-tz@example.test", password: "TechPass1", role: "technician" });
    const dispatcher = await loginAs("dispatch-tz@example.test", "DispatchPass1");
    const technician = await loginAs("tech-tz@example.test", "TechPass1");

    const adminRes = await post("/api/settings", { key: "BUSINESS_TIMEZONE", value: "America/Denver", data_type: "string" }, auth);
    expect(adminRes.response.status).toBe(201);

    const dispatcherRes = await post("/api/settings", { key: "BUSINESS_TIMEZONE", value: "America/Chicago", data_type: "string" }, { headers: { cookie: dispatcher.cookie } });
    expect(dispatcherRes.response.status).toBe(403);

    const technicianRes = await post("/api/settings", { key: "BUSINESS_TIMEZONE", value: "America/Chicago", data_type: "string" }, { headers: { cookie: technician.cookie } });
    expect(technicianRes.response.status).toBe(403);
  });

  it("a dispatcher CAN read the current settings list (read-only), matching existing settings RBAC", async () => {
    const auth = await authHeaders();
    await post("/api/settings", { key: "BUSINESS_TIMEZONE", value: "America/Denver", data_type: "string" }, auth);
    await createUser({ email: "dispatch-tz-read@example.test", password: "DispatchPass1", role: "dispatcher" });
    const dispatcher = await loginAs("dispatch-tz-read@example.test", "DispatchPass1");

    const list = await request<{ settings: { key: string; value: string }[] }>("/api/settings", { headers: { cookie: dispatcher.cookie } });
    expect(list.response.status).toBe(200);
    expect(list.body.settings.find((s) => s.key === "BUSINESS_TIMEZONE")?.value).toBe("America/Denver");
  });

  it("rejects an unauthenticated update attempt", async () => {
    const res = await requestRaw("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "BUSINESS_TIMEZONE", value: "America/Denver", data_type: "string" }),
    });
    expect(res.status).toBe(401);
  });

  it("preserves version history exactly like every other Global Setting — publishing a new version closes the old one instead of mutating it", async () => {
    const auth = await authHeaders();
    await post("/api/settings", { key: "BUSINESS_TIMEZONE", value: "America/Vancouver", data_type: "string" }, auth);
    const later = new Date(Date.now() + 60_000).toISOString();
    await post("/api/settings", { key: "BUSINESS_TIMEZONE", value: "America/Toronto", data_type: "string", effective_from: later }, auth);

    const history = await request<{ history: { value: string; effective_until: string | null }[] }>("/api/settings/BUSINESS_TIMEZONE/history", auth);
    expect(history.response.status).toBe(200);
    expect(history.body.history).toHaveLength(2);
    const current = history.body.history.find((h) => h.effective_until === null)!;
    const previous = history.body.history.find((h) => h.effective_until !== null)!;
    expect(current.value).toBe("America/Toronto");
    expect(previous.value).toBe("America/Vancouver");
    // Changing the current setting does NOT retroactively rewrite the old
    // version's own value — it stays "America/Vancouver" forever as a
    // historical record, matching every other Global Setting's guarantee.
  });

  it("PUT/DELETE remain admin-only, matching pre-existing settings RBAC (retire)", async () => {
    const auth = await authHeaders();
    await post("/api/settings", { key: "BUSINESS_TIMEZONE", value: "America/Denver", data_type: "string" }, auth);
    await createUser({ email: "dispatch-tz-del@example.test", password: "DispatchPass1", role: "dispatcher" });
    const dispatcher = await loginAs("dispatch-tz-del@example.test", "DispatchPass1");

    const forbidden = await del("/api/settings/BUSINESS_TIMEZONE", { headers: { cookie: dispatcher.cookie } });
    expect(forbidden.response.status).toBe(403);
  });
});

describe("getBusinessTimezone() resolver — the one shared source Calendar and Notifications both call", () => {
  it("resolves the published BUSINESS_TIMEZONE Global Setting when one exists", async () => {
    const auth = await authHeaders();
    await post("/api/settings", { key: "BUSINESS_TIMEZONE", value: "America/Toronto", data_type: "string" }, auth);
    expect(await getBusinessTimezone()).toBe("America/Toronto");
  });

  it("does NOT consult _meta.timezone when BUSINESS_TIMEZONE is published, even if _meta disagrees (no dual-source ambiguity)", async () => {
    await queryDb("UPDATE _meta SET value = 'America/Chicago' WHERE key = 'timezone'");
    const auth = await authHeaders();
    await post("/api/settings", { key: "BUSINESS_TIMEZONE", value: "America/Toronto", data_type: "string" }, auth);
    expect(await getBusinessTimezone()).toBe("America/Toronto");
  });

  it("falls back to a real (non-UTC) legacy _meta.timezone value when BUSINESS_TIMEZONE hasn't been published (backward compatibility for a pre-migration-0012 database)", async () => {
    await queryDb("UPDATE _meta SET value = 'America/Edmonton' WHERE key = 'timezone'");
    expect(await getBusinessTimezone()).toBe("America/Edmonton");
  });

  it("falls through to the safe default when neither BUSINESS_TIMEZONE nor a real _meta.timezone value exists — never silently UTC (closes the fresh-environment risk)", async () => {
    // resetDatabase() wipes global_settings but deliberately never touches
    // _meta (same as every other test file) — reset it back to the schema
    // default explicitly here so this test is self-contained and doesn't
    // depend on execution order relative to the other tests in this
    // describe block that set _meta.timezone to a real value.
    await queryDb("UPDATE _meta SET value = 'UTC' WHERE key = 'timezone'");
    const legacy = await queryDb<{ value: string }>("SELECT value FROM _meta WHERE key = 'timezone'");
    expect(legacy[0].value).toBe("UTC");
    expect(await getBusinessTimezone()).toBe(DEFAULT_BUSINESS_TIMEZONE);
    expect(DEFAULT_BUSINESS_TIMEZONE).toBe("America/Vancouver");
  });
});
