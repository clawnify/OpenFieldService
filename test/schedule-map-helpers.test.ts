import { describe, expect, it } from "vitest";
import { partitionMapJobs, computeMapView, nonGeocodedSummary } from "../src/client/schedule-map-helpers.js";
import type { Job } from "../src/client/types.js";

// Phase 10.2 — pure-function tests for the Dispatcher Map's client logic.
// No DOM, no Google Maps SDK, no fetch — matches this project's standing
// "extract client logic into a plain .ts module, test it directly"
// precedent (mem:project/fsm-upgrade-plan decision 10).

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 1, identifier: "JOB-1", customer_id: 1, technician_id: null, service_type_id: null,
    status: "scheduled", job_type: "STANDARD", eligibility_code: "", eligibility_code_expiry: "",
    priority: "normal", scheduled_date: "2026-09-01", scheduled_time: "09:00", duration: 60, price: 100,
    address: "1 Main St", notes: "", completion_notes: "", is_recurring: 0, recurrence_interval: "",
    next_recurrence_date: "", created_at: "", updated_at: "",
    ...overrides,
  } as Job;
}

describe("partitionMapJobs()", () => {
  it("puts a geocoded job with valid coordinates into markers", () => {
    const job = makeJob({ id: 1, geocode_status: "geocoded", latitude: 49.28, longitude: -123.12 });
    const { markers, nonGeocoded } = partitionMapJobs([job]);
    expect(markers).toEqual([{ job, lat: 49.28, lng: -123.12 }]);
    expect(nonGeocoded).toHaveLength(0);
  });

  it("puts a pending job into nonGeocoded, never fabricating a coordinate", () => {
    const job = makeJob({ id: 2, geocode_status: "pending", latitude: null, longitude: null });
    const { markers, nonGeocoded } = partitionMapJobs([job]);
    expect(markers).toHaveLength(0);
    expect(nonGeocoded).toEqual([job]);
  });

  it("puts a failed job into nonGeocoded", () => {
    const job = makeJob({ id: 3, geocode_status: "failed", latitude: null, longitude: null });
    const { nonGeocoded } = partitionMapJobs([job]);
    expect(nonGeocoded).toEqual([job]);
  });

  it("treats a job with geocode_status='geocoded' but a null coordinate (inconsistent data) as nonGeocoded, defense in depth", () => {
    const job = makeJob({ id: 4, geocode_status: "geocoded", latitude: null, longitude: -123.12 });
    const { markers, nonGeocoded } = partitionMapJobs([job]);
    expect(markers).toHaveLength(0);
    expect(nonGeocoded).toEqual([job]);
  });

  it("treats a job with no geocode_status field at all (older client cache / missing data) as nonGeocoded", () => {
    const job = makeJob({ id: 5 });
    delete (job as { geocode_status?: string }).geocode_status;
    const { nonGeocoded } = partitionMapJobs([job]);
    expect(nonGeocoded).toEqual([job]);
  });

  it("handles a mixed set correctly and preserves order within each bucket", () => {
    const a = makeJob({ id: 1, geocode_status: "geocoded", latitude: 1, longitude: 1 });
    const b = makeJob({ id: 2, geocode_status: "pending" });
    const c = makeJob({ id: 3, geocode_status: "geocoded", latitude: 2, longitude: 2 });
    const d = makeJob({ id: 4, geocode_status: "failed" });
    const { markers, nonGeocoded } = partitionMapJobs([a, b, c, d]);
    expect(markers.map((m) => m.job.id)).toEqual([1, 3]);
    expect(nonGeocoded.map((j) => j.id)).toEqual([2, 4]);
  });
});

describe("computeMapView()", () => {
  it("0 markers -> empty (no hardcoded default center)", () => {
    expect(computeMapView([])).toEqual({ kind: "empty" });
  });

  it("1 marker -> centers on it", () => {
    const job = makeJob();
    expect(computeMapView([{ job, lat: 49.28, lng: -123.12 }])).toEqual({ kind: "point", lat: 49.28, lng: -123.12 });
  });

  it("2+ markers -> a bounding box covering all of them", () => {
    const j1 = makeJob({ id: 1 }), j2 = makeJob({ id: 2 }), j3 = makeJob({ id: 3 });
    const view = computeMapView([
      { job: j1, lat: 49.0, lng: -123.5 },
      { job: j2, lat: 49.5, lng: -123.0 },
      { job: j3, lat: 49.2, lng: -123.8 },
    ]);
    expect(view).toEqual({ kind: "bounds", north: 49.5, south: 49.0, east: -123.0, west: -123.8 });
  });

  it("a bounding box for markers at the exact same coordinate is a degenerate (zero-size) box, not an error", () => {
    const j1 = makeJob({ id: 1 }), j2 = makeJob({ id: 2 });
    const view = computeMapView([{ job: j1, lat: 49.0, lng: -123.0 }, { job: j2, lat: 49.0, lng: -123.0 }]);
    expect(view).toEqual({ kind: "bounds", north: 49.0, south: 49.0, east: -123.0, west: -123.0 });
  });
});

describe("nonGeocodedSummary()", () => {
  it("returns null for zero non-geocoded jobs (no banner)", () => {
    expect(nonGeocodedSummary(0)).toBeNull();
  });

  it("uses singular phrasing for exactly one", () => {
    expect(nonGeocodedSummary(1)).toBe("1 job has no mapped location");
  });

  it("uses plural phrasing for more than one", () => {
    expect(nonGeocodedSummary(3)).toBe("3 jobs have no mapped location");
  });
});
