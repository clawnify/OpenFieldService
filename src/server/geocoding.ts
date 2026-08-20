import { get, run } from "./db.js";

/**
 * Phase 10.0 — Location Data Model + Provider Interfaces. See
 * mem:phase10/maps-routing-architecture-audit for the full architecture
 * this implements. NO real geocoding/routing provider exists yet — this
 * file defines the provider-independent contracts plus a `NoopGeocodingProvider`
 * (the only implementation ever wired into real code this phase) and a
 * `MockGeocodingProvider` (test-only, never wired into a route or any
 * production code path).
 *
 * The Job's own `address` column (not the Customer's) is the authoritative
 * service location — already established by src/server/index.ts's
 * createJob() snapshot-at-creation behavior. This module geocodes that
 * address only, never the Customer's current address.
 */

// ── Coordinate validation ──────────────────────────────────────────────

/** Rejects NaN/Infinity and out-of-range values — never trust an
 *  unvalidated coordinate, including one that came back from a
 *  well-behaved provider (defense in depth). */
export function isValidLatitude(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isValidLongitude(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -180 && value <= 180;
}

export function isValidCoordinatePair(latitude: unknown, longitude: unknown): boolean {
  return isValidLatitude(latitude) && isValidLongitude(longitude);
}

// ── Geocoding provider contract ────────────────────────────────────────

export interface GeocodeInput {
  /** The Job's own service address — a single free-text string, matching
   *  the actual `jobs.address` column (no separate city/state/zip fields
   *  exist on Job). Never the Customer's address. */
  address: string;
}

/** Normalized, provider-independent result. Domain code never sees a raw
 *  provider payload — an adapter (Phase 10.1) is responsible for mapping
 *  its own provider's response shape into exactly this type before
 *  anything else touches it. */
export type GeocodeResult =
  | { status: "ok"; latitude: number; longitude: number; formattedAddress?: string; providerReference?: string }
  | { status: "not_found" }
  | { status: "error"; code: string; message: string };

export interface GeocodingProvider {
  geocode(input: GeocodeInput): Promise<GeocodeResult>;
}

// ── Routing provider contract (interface only — no adapter, no call site
//    yet; Phase 10.4's job, defined now so the shape is settled early and
//    doesn't get invented ad hoc later) ─────────────────────────────────

export interface RoutePoint {
  latitude: number;
  longitude: number;
}

export interface RouteInput {
  origin: RoutePoint;
  destination: RoutePoint;
  waypoints?: RoutePoint[];
}

export interface RouteResult {
  distanceMeters: number;
  durationSeconds: number;
  /** Provider-specific path representation (e.g. an encoded polyline) —
   *  deliberately untyped here; only the eventual map-rendering component
   *  needs to understand it, domain code never inspects it. */
  geometry?: unknown;
}

export interface RoutingProvider {
  route(input: RouteInput): Promise<RouteResult>;
}

// ── No-op / mock implementations ───────────────────────────────────────

/** Never makes a network call. Always reports `not_found` — the honest,
 *  safe default for an environment with no real provider configured. This
 *  is the ONLY provider wired into real application code in Phase 10.0;
 *  it can never fabricate a coordinate. */
export class NoopGeocodingProvider implements GeocodingProvider {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept named to match GeocodingProvider's signature exactly (see MockGeocodingProvider below)
  async geocode(_input: GeocodeInput): Promise<GeocodeResult> {
    return { status: "not_found" };
  }
}

/** Deterministic, network-free — for automated tests only. Never imported
 *  by any production code path; only test files inject it directly into
 *  `geocodeJob()`. Defaults to a real Vancouver-area coordinate pair
 *  purely so a default-constructed instance is still a valid, in-range
 *  point — callers that care about a specific value should pass one. */
export class MockGeocodingProvider implements GeocodingProvider {
  constructor(private readonly result: GeocodeResult = { status: "ok", latitude: 49.2827, longitude: -123.1207 }) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept named to match GeocodingProvider's signature exactly
  async geocode(_input: GeocodeInput): Promise<GeocodeResult> {
    return this.result;
  }
}

/** No routing provider exists yet (Phase 10.4). Throwing here — rather
 *  than returning a fabricated zero-distance result — means any future
 *  caller that forgets routing isn't implemented yet fails loudly instead
 *  of silently displaying a nonsense route. */
export class NoopRoutingProvider implements RoutingProvider {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept named to match RoutingProvider's signature exactly
  async route(_input: RouteInput): Promise<RouteResult> {
    throw new GeocodingError("PROVIDER_UNAVAILABLE", "No routing provider is configured.");
  }
}

// ── Domain service ──────────────────────────────────────────────────────

/** Sanitized, business/operational-safe error — never wraps or exposes a
 *  raw provider message, stack trace, header, or token. `code` is a small,
 *  closed vocabulary (`NOT_FOUND`, `PROVIDER_UNAVAILABLE`, `INVALID_RESULT`),
 *  not a passthrough of whatever the provider happened to say. */
export class GeocodingError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type GeocodeStatus = "pending" | "geocoded" | "failed";

/** Provider-reported failures that reflect a transient problem with the
 *  PROVIDER ITSELF (network, quota, auth/config, malformed response,
 *  timeout) rather than a verified fact about the address — these leave a
 *  job's `geocode_status` at `pending` (worth retrying later, e.g. once a
 *  quota resets or a misconfigured key is fixed) instead of `failed` (a
 *  real address that genuinely didn't resolve). Only `NOT_FOUND` (zero
 *  results) and an `ok` result whose coordinates fail validation are
 *  genuine `failed` verdicts ABOUT THE ADDRESS. A plain thrown `Error` that
 *  isn't a `GeocodingError`, or a `GeocodeResult.error` whose `code` isn't
 *  in this set, is still treated as `failed` — this set only ADDS a
 *  `pending` outcome for the specific codes a real provider adapter (Phase
 *  10.1's `GoogleGeocodingProvider`) can report; it changes nothing about
 *  what `NoopGeocodingProvider`/`MockGeocodingProvider`/an unrecognized
 *  error already did in Phase 10.0. */
export const TRANSIENT_GEOCODE_CODES: ReadonlySet<string> = new Set([
  "PROVIDER_UNAVAILABLE", "PROVIDER_AUTH_ERROR", "RATE_LIMITED", "INVALID_RESPONSE", "TIMEOUT",
]);

interface JobAddressRow {
  id: number;
  address: string;
}

/** Geocodes exactly one Job's own service address and persists a
 *  validated result. Never throws for an ordinary "couldn't geocode this"
 *  outcome (empty address, provider `not_found`, provider error, or an
 *  invalid/out-of-range coordinate pair) — all of those resolve to
 *  `geocode_status = 'failed'`, matching the requirement that Job
 *  viewing/scheduling/workflow/invoicing/notifications/Calendar sync must
 *  never be blocked by a geocoding problem. Only throws `GeocodingError`
 *  for a genuinely exceptional caller error (the Job itself doesn't
 *  exist) — a condition no legitimate caller should ever hit in practice,
 *  since callers resolve a real Job id before invoking this.
 *
 *  Does not call any provider, Calendar, or Notification code beyond the
 *  one `jobs` row it reads and writes — geocoding a job never triggers
 *  Google Calendar sync or a notification event (see the architecture
 *  audit's explicit "no cross-domain side effects" requirement). */
export async function geocodeJob(jobId: number, provider: GeocodingProvider): Promise<GeocodeStatus> {
  const job = await get<JobAddressRow>("SELECT id, address FROM jobs WHERE id = ?", [jobId]);
  if (!job) throw new GeocodingError("NOT_FOUND", "Job not found");

  const address = (job.address || "").trim();
  if (!address) {
    // Nothing to geocode — never call the provider with a blank address.
    await persistGeocodeResult(jobId, "failed");
    return "failed";
  }

  let result: GeocodeResult;
  try {
    result = await provider.geocode({ address });
  } catch (err) {
    // A throwing provider adapter is caught here — never re-thrown, never
    // logged with its original message (adapters sanitize their own errors
    // at the boundary; see GoogleGeocodingProvider). A GeocodingError whose
    // code is TRANSIENT leaves the job pending/retryable; anything else
    // (including a plain, unrecognized Error) is a terminal failed verdict,
    // matching Phase 10.0's original behavior exactly.
    const code = err instanceof GeocodingError ? err.code : null;
    if (code && TRANSIENT_GEOCODE_CODES.has(code)) {
      console.error(`[geocoding] job_id=${jobId} outcome=pending code=${code}`);
      await persistGeocodeResult(jobId, "pending");
      return "pending";
    }
    await persistGeocodeResult(jobId, "failed");
    return "failed";
  }

  if (result.status === "ok" && isValidCoordinatePair(result.latitude, result.longitude)) {
    await persistGeocodeResult(jobId, "geocoded", result.latitude, result.longitude);
    return "geocoded";
  }
  if (result.status === "error" && TRANSIENT_GEOCODE_CODES.has(result.code)) {
    console.error(`[geocoding] job_id=${jobId} outcome=pending code=${result.code}`);
    await persistGeocodeResult(jobId, "pending");
    return "pending";
  }
  // Covers "not_found", a non-transient "error" result, and — defense in
  // depth — an "ok" result whose coordinates somehow fail validation (a
  // misbehaving provider must never get to write bad data to this table).
  await persistGeocodeResult(jobId, "failed");
  return "failed";
}

async function persistGeocodeResult(
  jobId: number, status: GeocodeStatus, latitude: number | null = null, longitude: number | null = null
): Promise<void> {
  const geocodedAt = status === "geocoded" ? new Date().toISOString() : null;
  await run(
    "UPDATE jobs SET latitude = ?, longitude = ?, geocoded_at = ?, geocode_status = ? WHERE id = ?",
    [latitude, longitude, geocodedAt, status, jobId]
  );
}

/** Clears a Job's coordinates back to `pending` — call this whenever the
 *  Job's own `address` field changes, so coordinates resolved for the OLD
 *  address are never silently trusted as still describing the new one.
 *  Never calls a provider itself; re-geocoding after an address change is
 *  a separate, explicit, later action (Phase 10.1+), not automatic. */
export async function clearJobGeocode(jobId: number): Promise<void> {
  await run(
    "UPDATE jobs SET latitude = NULL, longitude = NULL, geocoded_at = NULL, geocode_status = 'pending' WHERE id = ?",
    [jobId]
  );
}
