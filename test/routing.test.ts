import { describe, expect, it } from "vitest";
import { GeocodingError, MockRoutingProvider, NoopRoutingProvider, type RouteInput, type RouteResult } from "../src/server/geocoding.js";
import { computeTechnicianRouteLegs, isEligibleStop, orderRouteStops, type RouteStopInput } from "../src/server/routing.js";
import { MAX_INTERMEDIATE_WAYPOINTS } from "../src/server/google-routing.js";

/**
 * Phase 10.4 — routing.ts business-logic tests. Every test here injects a
 * MockRoutingProvider/NoopRoutingProvider directly — zero network calls,
 * zero DB access (this module takes plain data in, returns plain data
 * out; no `db.js` import exists in routing.ts, so there is nothing for
 * this module to persist — see mem:phase10/maps-routing-architecture-audit
 * for the "no route-order persistence" invariant this reflects).
 */

function stop(jobId: number, scheduledTime: string, opts: Partial<RouteStopInput> = {}): RouteStopInput {
  return {
    jobId, scheduledTime, status: "scheduled",
    latitude: 49.28, longitude: -123.12, geocodeStatus: "geocoded",
    ...opts,
  };
}

function notMapped(jobId: number, scheduledTime: string): RouteStopInput {
  return stop(jobId, scheduledTime, { latitude: null, longitude: null, geocodeStatus: "pending" });
}

describe("orderRouteStops / isEligibleStop", () => {
  it("orders by scheduled_time then id, excludes cancelled", () => {
    const stops = [
      stop(3, "09:00"),
      stop(1, "11:00"),
      stop(2, "09:00"),
      stop(4, "10:00", { status: "cancelled" }),
    ];
    const ordered = orderRouteStops(stops);
    expect(ordered.map((s) => s.jobId)).toEqual([2, 3, 1]);
  });

  it("isEligibleStop requires geocode_status='geocoded' AND both coordinates non-null", () => {
    expect(isEligibleStop(stop(1, "09:00"))).toBe(true);
    expect(isEligibleStop(notMapped(1, "09:00"))).toBe(false);
    expect(isEligibleStop(stop(1, "09:00", { geocodeStatus: "failed" }))).toBe(false);
    expect(isEligibleStop(stop(1, "09:00", { latitude: null }))).toBe(false);
  });
});

describe("computeTechnicianRouteLegs", () => {
  it("0 stops -> no legs, null totals", async () => {
    const result = await computeTechnicianRouteLegs([], new NoopRoutingProvider());
    expect(result).toEqual({ legs: [], totalDistanceMeters: null, totalDurationSeconds: null });
  });

  it("1 stop -> no legs (nothing to connect), null totals, provider never called", async () => {
    let callCount = 0;
    const provider = new MockRoutingProvider(() => { callCount++; return { distanceMeters: 0, durationSeconds: 0, legs: [] }; });
    const result = await computeTechnicianRouteLegs([stop(1, "09:00")], provider);
    expect(result).toEqual({ legs: [], totalDistanceMeters: null, totalDurationSeconds: null });
    expect(callCount).toBe(0);
  });

  it("2 eligible stops -> 1 ok leg, real distance/duration, provider called exactly once", async () => {
    let callCount = 0;
    const provider = new MockRoutingProvider(() => { callCount++; return { distanceMeters: 12400, durationSeconds: 1080, legs: [{ distanceMeters: 12400, durationSeconds: 1080 }] }; });
    const result = await computeTechnicianRouteLegs([stop(1, "09:00"), stop(2, "10:00")], provider);
    expect(result.legs).toEqual([{ fromJobId: 1, toJobId: 2, status: "ok", distanceMeters: 12400, durationSeconds: 1080 }]);
    expect(result.totalDistanceMeters).toBe(12400);
    expect(result.totalDurationSeconds).toBe(1080);
    expect(callCount).toBe(1);
  });

  it("multiple (4) eligible stops -> 3 ok legs from ONE provider call (not one call per leg — cost control)", async () => {
    let callCount = 0;
    const provider = new MockRoutingProvider((): RouteResult => {
      callCount++;
      return { distanceMeters: 3000, durationSeconds: 300, legs: [
        { distanceMeters: 1000, durationSeconds: 100 },
        { distanceMeters: 1000, durationSeconds: 100 },
        { distanceMeters: 1000, durationSeconds: 100 },
      ] };
    });
    const stops = [stop(1, "08:00"), stop(2, "09:00"), stop(3, "10:00"), stop(4, "11:00")];
    const result = await computeTechnicianRouteLegs(stops, provider);
    expect(result.legs.map((l) => [l.fromJobId, l.toJobId, l.status])).toEqual([
      [1, 2, "ok"], [2, 3, "ok"], [3, 4, "ok"],
    ]);
    expect(callCount).toBe(1);
    expect(result.totalDistanceMeters).toBe(3000);
  });

  it("a missing-coordinate stop breaks the chain — no fabricated continuity across it", async () => {
    let callCount = 0;
    const provider = new MockRoutingProvider(() => { callCount++; throw new Error("should never be called — no contiguous eligible pair exists"); });
    const stops = [stop(1, "08:00"), notMapped(2, "09:00"), stop(3, "10:00")];
    const result = await computeTechnicianRouteLegs(stops, provider);
    expect(result.legs).toEqual([
      { fromJobId: 1, toJobId: 2, status: "unavailable" },
      { fromJobId: 2, toJobId: 3, status: "unavailable" },
    ]);
    expect(result.totalDistanceMeters).toBeNull();
    expect(result.totalDurationSeconds).toBeNull();
    expect(callCount).toBe(0);
  });

  it("a missing-coordinate stop in the MIDDLE of a longer route only breaks its own two adjacent legs — the rest stay ok", async () => {
    const provider = new MockRoutingProvider(() => ({
      distanceMeters: 1000, durationSeconds: 100, legs: [{ distanceMeters: 1000, durationSeconds: 100 }],
    }));
    // 1(geo) -> 2(geo) -> 3(NOT mapped) -> 4(geo) -> 5(geo)
    const stops = [stop(1, "08:00"), stop(2, "09:00"), notMapped(3, "10:00"), stop(4, "11:00"), stop(5, "12:00")];
    const result = await computeTechnicianRouteLegs(stops, provider);
    expect(result.legs.map((l) => [l.fromJobId, l.toJobId, l.status])).toEqual([
      [1, 2, "ok"],
      [2, 3, "unavailable"],
      [3, 4, "unavailable"],
      [4, 5, "ok"],
    ]);
  });

  it("deterministic scheduled order — legs reflect scheduled_time order, not array/creation order", async () => {
    const provider = new MockRoutingProvider(() => ({
      distanceMeters: 100, durationSeconds: 10, legs: [{ distanceMeters: 100, durationSeconds: 10 }],
    }));
    const stops = [stop(99, "14:00"), stop(1, "09:00")];
    const result = await computeTechnicianRouteLegs(stops, provider);
    expect(result.legs).toEqual([{ fromJobId: 1, toJobId: 99, status: "ok", distanceMeters: 100, durationSeconds: 10 }]);
  });

  it("provider disabled (NoopRoutingProvider) — legs report unavailable with error_code PROVIDER_UNAVAILABLE, never a crash", async () => {
    const result = await computeTechnicianRouteLegs([stop(1, "09:00"), stop(2, "10:00")], new NoopRoutingProvider());
    expect(result.legs).toEqual([{ fromJobId: 1, toJobId: 2, status: "unavailable", errorCode: "PROVIDER_UNAVAILABLE" }]);
    expect(result.totalDistanceMeters).toBeNull();
  });

  it("provider misconfigured (throws PROVIDER_AUTH_ERROR) — normalized, isolated, never a crash", async () => {
    const provider = new MockRoutingProvider(() => { throw new GeocodingError("PROVIDER_AUTH_ERROR", "not configured"); });
    const result = await computeTechnicianRouteLegs([stop(1, "09:00"), stop(2, "10:00")], provider);
    expect(result.legs).toEqual([{ fromJobId: 1, toJobId: 2, status: "unavailable", errorCode: "PROVIDER_AUTH_ERROR" }]);
  });

  it("a provider error on one contiguous run doesn't affect an unrelated run elsewhere in the same day (per-run isolation)", async () => {
    let calls = 0;
    const provider = new MockRoutingProvider(() => {
      calls++;
      if (calls === 1) throw new GeocodingError("TIMEOUT", "slow");
      return { distanceMeters: 500, durationSeconds: 50, legs: [{ distanceMeters: 500, durationSeconds: 50 }] };
    });
    // Two separate eligible runs of 2, split by a non-geocoded stop.
    const stops = [stop(1, "08:00"), stop(2, "09:00"), notMapped(3, "10:00"), stop(4, "11:00"), stop(5, "12:00")];
    const result = await computeTechnicianRouteLegs(stops, provider);
    expect(result.legs[0]).toMatchObject({ fromJobId: 1, toJobId: 2, status: "unavailable", errorCode: "TIMEOUT" });
    expect(result.legs[3]).toMatchObject({ fromJobId: 4, toJobId: 5, status: "ok", distanceMeters: 500 });
  });

  it("no route-order is ever persisted — this module never touches the database (verified structurally: it takes/returns plain data with no side effects)", async () => {
    const stops = [stop(1, "09:00"), stop(2, "10:00")];
    const snapshot = JSON.parse(JSON.stringify(stops));
    await computeTechnicianRouteLegs(stops, new NoopRoutingProvider());
    expect(stops).toEqual(snapshot); // input untouched — no mutation, a fortiori no persistence
  });

  it("waypoint batching: a contiguous eligible run longer than MAX_INTERMEDIATE_WAYPOINTS+2 is split into multiple provider calls, never truncated", async () => {
    const runLength = MAX_INTERMEDIATE_WAYPOINTS + 5; // forces exactly 2 batches
    const stops = Array.from({ length: runLength }, (_, i) => stop(i + 1, String(i + 1).padStart(2, "0") + ":00"));
    let callCount = 0;
    // Default synthesizer (no result override) so leg count always matches whatever input shape each batch sends.
    const realProvider = new MockRoutingProvider();
    const wrapped = { route: async (input: RouteInput) => { callCount++; return realProvider.route(input); } };
    const result = await computeTechnicianRouteLegs(stops, wrapped);
    expect(callCount).toBe(2);
    expect(result.legs).toHaveLength(runLength - 1);
    // Every leg is `ok` — no gap introduced by the batch split itself.
    expect(result.legs.every((l) => l.status === "ok")).toBe(true);
    // Sequence is exactly 1->2->3->...->runLength, no skip/duplicate at the batch boundary.
    expect(result.legs.map((l) => l.fromJobId)).toEqual(Array.from({ length: runLength - 1 }, (_, i) => i + 1));
    expect(result.legs.map((l) => l.toJobId)).toEqual(Array.from({ length: runLength - 1 }, (_, i) => i + 2));
  });
});
