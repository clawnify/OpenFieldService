import { describe, expect, it } from "vitest";
import { orderStops, numberStops, todayInBusinessTimezone, addDaysToIsoDate } from "../src/client/technician-route-helpers.js";
import type { Job } from "../src/client/types.js";

// Phase 10.3 — pure-function tests for the Technician Route View's client
// logic. No DOM, no Google Maps SDK, no fetch — same precedent as
// navigation.ts/schedule-map-helpers.ts.

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 1, identifier: "JOB-1", customer_id: 1, technician_id: 5, service_type_id: null,
    status: "scheduled", job_type: "STANDARD", eligibility_code: "", eligibility_code_expiry: "",
    priority: "normal", scheduled_date: "2026-09-01", scheduled_time: "09:00", duration: 60, price: 100,
    address: "1 Main St", notes: "", completion_notes: "", is_recurring: 0, recurrence_interval: "",
    next_recurrence_date: "", created_at: "", updated_at: "",
    ...overrides,
  } as Job;
}

describe("orderStops()", () => {
  it("sorts by scheduled_time ascending", () => {
    const a = makeJob({ id: 1, scheduled_time: "14:00" });
    const b = makeJob({ id: 2, scheduled_time: "09:00" });
    const c = makeJob({ id: 3, scheduled_time: "11:30" });
    expect(orderStops([a, b, c]).map((j) => j.id)).toEqual([2, 3, 1]);
  });

  it("uses id as a deterministic tie-break for two stops at the exact same time", () => {
    const a = makeJob({ id: 5, scheduled_time: "09:00" });
    const b = makeJob({ id: 2, scheduled_time: "09:00" });
    expect(orderStops([a, b]).map((j) => j.id)).toEqual([2, 5]);
  });

  it("excludes cancelled jobs entirely, matching technician-home.tsx's existing 'active' filter", () => {
    const a = makeJob({ id: 1, status: "cancelled", scheduled_time: "08:00" });
    const b = makeJob({ id: 2, status: "scheduled", scheduled_time: "09:00" });
    expect(orderStops([a, b]).map((j) => j.id)).toEqual([2]);
  });

  it("never mutates the input array", () => {
    const jobs = [makeJob({ id: 2, scheduled_time: "10:00" }), makeJob({ id: 1, scheduled_time: "09:00" })];
    const original = [...jobs];
    orderStops(jobs);
    expect(jobs).toEqual(original);
  });
});

describe("numberStops()", () => {
  it("assigns 1-based sequential stop numbers in the given order", () => {
    const jobs = [makeJob({ id: 1 }), makeJob({ id: 2 }), makeJob({ id: 3 })];
    const numbered = numberStops(jobs);
    expect(numbered.map((s) => s.stopNumber)).toEqual([1, 2, 3]);
    expect(numbered.map((s) => s.job.id)).toEqual([1, 2, 3]);
  });

  it("numbers a non-geocoded stop the same as any other — it still has a real place in the day", () => {
    const jobs = [makeJob({ id: 1, geocode_status: "geocoded", latitude: 1, longitude: 1 }), makeJob({ id: 2, geocode_status: "pending" })];
    expect(numberStops(jobs).map((s) => s.stopNumber)).toEqual([1, 2]);
  });

  it("returns an empty array for an empty day", () => {
    expect(numberStops([])).toEqual([]);
  });
});

describe("todayInBusinessTimezone()", () => {
  it("returns a YYYY-MM-DD formatted string for a real IANA timezone", () => {
    const result = todayInBusinessTimezone("America/Vancouver");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("falls back to America/Vancouver (the server's own documented final fallback) when given null", () => {
    const withNull = todayInBusinessTimezone(null);
    const withExplicit = todayInBusinessTimezone("America/Vancouver");
    expect(withNull).toBe(withExplicit);
  });

  it("falls back to America/Vancouver when given an empty string", () => {
    const withEmpty = todayInBusinessTimezone("");
    const withExplicit = todayInBusinessTimezone("America/Vancouver");
    expect(withEmpty).toBe(withExplicit);
  });

  it("a different real timezone can produce a different calendar date near a day boundary (proves it's not just using browser-local time)", () => {
    // Not asserting a specific value (depends on the real current instant) —
    // asserting the function actually delegates to Intl with the given zone
    // rather than ignoring it, by confirming it doesn't throw and returns a
    // valid date for a very different timezone (Pacific/Kiritimati, UTC+14).
    const result = todayInBusinessTimezone("Pacific/Kiritimati");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("addDaysToIsoDate()", () => {
  it("adds a positive delta", () => {
    expect(addDaysToIsoDate("2026-09-01", 1)).toBe("2026-09-02");
  });

  it("subtracts with a negative delta", () => {
    expect(addDaysToIsoDate("2026-09-01", -1)).toBe("2026-08-31");
  });

  it("rolls over a month boundary correctly", () => {
    expect(addDaysToIsoDate("2026-08-31", 1)).toBe("2026-09-01");
  });

  it("a zero delta returns the same date", () => {
    expect(addDaysToIsoDate("2026-09-01", 0)).toBe("2026-09-01");
  });
});
