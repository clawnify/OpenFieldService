import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema, createCustomer, createJob, queryDb, resetDatabase } from "./helpers.js";
import {
  GeocodingError, MockGeocodingProvider, NoopGeocodingProvider, NoopRoutingProvider,
  clearJobGeocode, geocodeJob, isValidCoordinatePair, isValidLatitude, isValidLongitude,
  type GeocodeResult,
} from "../src/server/geocoding.js";

// Phase 10.0 — Location Data Model + Provider Interfaces. See
// mem:phase10/maps-routing-architecture-audit for the full architecture.
// No real geocoding/routing provider exists yet — every test here uses
// either NoopGeocodingProvider (the only implementation ever wired into
// real code) or MockGeocodingProvider (test-only, deterministic, never
// makes a network call).

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

describe("migration 0013 — job_geocoding", () => {
  it("existing jobs survive the migration with correct default geocode state and all prior columns intact", async () => {
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-25", { scheduled_time: "14:00", duration: 45 });
    const rows = await queryDb<{
      identifier: string; address: string; scheduled_time: string; duration: number;
      latitude: number | null; longitude: number | null; geocoded_at: string | null; geocode_status: string;
    }>("SELECT identifier, address, scheduled_time, duration, latitude, longitude, geocoded_at, geocode_status FROM jobs WHERE id = ?", [job.id]);
    // Every pre-existing column is untouched by this additive migration...
    expect(rows[0]).toMatchObject({ scheduled_time: "14:00", duration: 45 });
    expect(rows[0].address).toBeTruthy();
    expect(rows[0].identifier).toMatch(/^JOB-\d+$/);
    // ...and the 4 new columns exist with the correct safe defaults.
    expect(rows[0]).toMatchObject({ latitude: null, longitude: null, geocoded_at: null, geocode_status: "pending" });
  });

  it("the geocode_status index exists", async () => {
    const rows = await queryDb<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_jobs_geocode_status'"
    );
    expect(rows).toHaveLength(1);
  });

  it("the coordinate-pair CHECK constraint rejects a partial (latitude-only) write at the database level", async () => {
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-25");
    await expect(
      queryDb("UPDATE jobs SET latitude = 49.28 WHERE id = ?", [job.id])
    ).rejects.toThrow();
  });
});

describe("coordinate validation", () => {
  it("accepts valid latitude/longitude values", () => {
    expect(isValidLatitude(49.2827)).toBe(true);
    expect(isValidLatitude(-90)).toBe(true);
    expect(isValidLatitude(90)).toBe(true);
    expect(isValidLongitude(-123.1207)).toBe(true);
    expect(isValidLongitude(-180)).toBe(true);
    expect(isValidLongitude(180)).toBe(true);
  });

  it("rejects out-of-range latitude/longitude", () => {
    expect(isValidLatitude(90.0001)).toBe(false);
    expect(isValidLatitude(-90.0001)).toBe(false);
    expect(isValidLongitude(180.0001)).toBe(false);
    expect(isValidLongitude(-180.0001)).toBe(false);
  });

  it("rejects NaN and Infinity", () => {
    expect(isValidLatitude(NaN)).toBe(false);
    expect(isValidLatitude(Infinity)).toBe(false);
    expect(isValidLatitude(-Infinity)).toBe(false);
    expect(isValidLongitude(NaN)).toBe(false);
    expect(isValidLongitude(Infinity)).toBe(false);
  });

  it("rejects non-numeric values (invalid strings, null, undefined)", () => {
    expect(isValidLatitude("49.28" as unknown as number)).toBe(false);
    expect(isValidLatitude(null as unknown as number)).toBe(false);
    expect(isValidLatitude(undefined as unknown as number)).toBe(false);
    expect(isValidLongitude("not a number" as unknown as number)).toBe(false);
  });

  it("a valid pair requires BOTH values valid", () => {
    expect(isValidCoordinatePair(49.28, -123.12)).toBe(true);
    expect(isValidCoordinatePair(49.28, NaN)).toBe(false);
    expect(isValidCoordinatePair(NaN, -123.12)).toBe(false);
    expect(isValidCoordinatePair(null, null)).toBe(false);
  });
});

describe("NoopGeocodingProvider / NoopRoutingProvider — never fabricate data", () => {
  it("Noop geocoding always reports not_found, never a network call", async () => {
    const provider = new NoopGeocodingProvider();
    const result = await provider.geocode({ address: "1 Main St, Vancouver, BC" });
    expect(result).toEqual({ status: "not_found" });
  });

  it("Noop routing throws PROVIDER_UNAVAILABLE rather than fabricating a route", async () => {
    const provider = new NoopRoutingProvider();
    await expect(provider.route({
      origin: { latitude: 49.28, longitude: -123.12 },
      destination: { latitude: 49.3, longitude: -123.1 },
    })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});

describe("geocodeJob() — domain service (mock provider, real local D1, never a real network call)", () => {
  it("throws NOT_FOUND for a job that doesn't exist", async () => {
    const provider = new MockGeocodingProvider();
    await expect(geocodeJob(999999, provider)).rejects.toThrow(GeocodingError);
    await expect(geocodeJob(999999, provider)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a job starts pending with null coordinates immediately after creation", async () => {
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-25");
    const rows = await queryDb<{ latitude: number | null; longitude: number | null; geocoded_at: string | null; geocode_status: string }>(
      "SELECT latitude, longitude, geocoded_at, geocode_status FROM jobs WHERE id = ?", [job.id]
    );
    expect(rows[0]).toMatchObject({ latitude: null, longitude: null, geocoded_at: null, geocode_status: "pending" });
  });

  it("a successful mock geocode persists the exact returned coordinates and sets geocoded_at", async () => {
    const customer = await createCustomer(); // real, non-empty address (see createCustomer() in helpers.ts)
    const job = await createJob(customer.id, "2026-08-25");
    const provider = new MockGeocodingProvider({ status: "ok", latitude: 49.2827, longitude: -123.1207, formattedAddress: "100 Main St, Burnaby, BC" });

    const status = await geocodeJob(job.id, provider);

    expect(status).toBe("geocoded");
    const rows = await queryDb<{ latitude: number; longitude: number; geocoded_at: string | null; geocode_status: string }>(
      "SELECT latitude, longitude, geocoded_at, geocode_status FROM jobs WHERE id = ?", [job.id]
    );
    expect(rows[0].latitude).toBeCloseTo(49.2827);
    expect(rows[0].longitude).toBeCloseTo(-123.1207);
    expect(rows[0].geocode_status).toBe("geocoded");
    expect(rows[0].geocoded_at).toBeTruthy();
  });

  it("a not_found provider result leaves coordinates null and marks the job failed", async () => {
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-25");
    const provider = new NoopGeocodingProvider();

    const status = await geocodeJob(job.id, provider);

    expect(status).toBe("failed");
    const rows = await queryDb<{ latitude: number | null; longitude: number | null; geocode_status: string }>(
      "SELECT latitude, longitude, geocode_status FROM jobs WHERE id = ?", [job.id]
    );
    expect(rows[0]).toMatchObject({ latitude: null, longitude: null, geocode_status: "failed" });
  });

  it("an error-status provider result is treated the same as not_found — job marked failed, no exception propagates", async () => {
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-25");
    const provider = new MockGeocodingProvider({ status: "error", code: "PROVIDER_TIMEOUT", message: "upstream timed out" });

    const status = await geocodeJob(job.id, provider);

    expect(status).toBe("failed");
  });

  it("a throwing provider adapter is caught — never propagates, never persists the raw error", async () => {
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-25");
    const throwingProvider = { geocode: async () => { throw new Error("some raw provider/network failure with a stack trace"); } };

    const status = await geocodeJob(job.id, throwingProvider);

    expect(status).toBe("failed");
    const rows = await queryDb<{ geocode_status: string }>("SELECT geocode_status FROM jobs WHERE id = ?", [job.id]);
    expect(rows[0].geocode_status).toBe("failed");
    // The raw error message must never end up in the jobs row — there's no
    // column that could even hold it (no geocode_error column exists, by
    // design — see migrations/0013's own rationale).
    const columns = await queryDb<Record<string, unknown>>("SELECT * FROM jobs WHERE id = ?", [job.id]);
    expect(JSON.stringify(columns[0])).not.toContain("stack trace");
  });

  it("a provider returning an out-of-range coordinate is rejected (defense in depth) and the job is marked failed, never persisting bad data", async () => {
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-25");
    const misbehavingProvider = new MockGeocodingProvider({ status: "ok", latitude: 999, longitude: -123.12 });

    const status = await geocodeJob(job.id, misbehavingProvider);

    expect(status).toBe("failed");
    const rows = await queryDb<{ latitude: number | null; longitude: number | null }>(
      "SELECT latitude, longitude FROM jobs WHERE id = ?", [job.id]
    );
    expect(rows[0]).toMatchObject({ latitude: null, longitude: null });
  });

  it("a job with a blank address never calls the provider and is immediately marked failed", async () => {
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-25");
    // createJob() always derives a non-empty address from the customer's own
    // (non-empty) address when none is explicitly supplied — see
    // src/server/index.ts's createJob(), so a truly blank job address can't
    // be produced through the normal create flow with this fixture. Force
    // the precondition directly, matching this codebase's established
    // pattern of setting up specific DB states via direct SQL for a
    // targeted edge-case test.
    await queryDb("UPDATE jobs SET address = '' WHERE id = ?", [job.id]);
    let providerCalled = false;
    const spyProvider = { geocode: async (): Promise<GeocodeResult> => { providerCalled = true; return { status: "ok", latitude: 1, longitude: 1 }; } };

    const status = await geocodeJob(job.id, spyProvider);

    expect(providerCalled).toBe(false);
    expect(status).toBe("failed");
  });
});

describe("clearJobGeocode()", () => {
  it("resets a geocoded job back to pending with null coordinates", async () => {
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-25");
    await geocodeJob(job.id, new MockGeocodingProvider());
    const before = await queryDb<{ geocode_status: string }>("SELECT geocode_status FROM jobs WHERE id = ?", [job.id]);
    expect(before[0].geocode_status).toBe("geocoded");

    await clearJobGeocode(job.id);

    const after = await queryDb<{ latitude: number | null; longitude: number | null; geocoded_at: string | null; geocode_status: string }>(
      "SELECT latitude, longitude, geocoded_at, geocode_status FROM jobs WHERE id = ?", [job.id]
    );
    expect(after[0]).toMatchObject({ latitude: null, longitude: null, geocoded_at: null, geocode_status: "pending" });
  });
});

describe("repeated geocoding is deterministic (idempotency semantics for future callers)", () => {
  it("re-geocoding an already-geocoded job with the same successful result produces the same stored coordinates", async () => {
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-25");
    const provider = new MockGeocodingProvider({ status: "ok", latitude: 49.28, longitude: -123.12 });

    await geocodeJob(job.id, provider);
    await geocodeJob(job.id, provider);

    const rows = await queryDb<{ latitude: number; longitude: number; geocode_status: string }>(
      "SELECT latitude, longitude, geocode_status FROM jobs WHERE id = ?", [job.id]
    );
    expect(rows[0]).toMatchObject({ latitude: 49.28, longitude: -123.12, geocode_status: "geocoded" });
  });
});
