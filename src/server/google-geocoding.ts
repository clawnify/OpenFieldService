import {
  GeocodingError, NoopGeocodingProvider, isValidCoordinatePair,
  type GeocodeInput, type GeocodeResult, type GeocodingProvider,
} from "./geocoding.js";

/**
 * Phase 10.1 — the first real GeocodingProvider adapter. Everything
 * Google-specific (the REST endpoint, its request shape, its response
 * shape, its own status vocabulary) lives ONLY in this file — geocodeJob()
 * (geocoding.ts) and every route handler (index.ts) only ever see the
 * provider-independent GeocodeResult contract Phase 10.0 already defined.
 * Uses plain `fetch`, matching this codebase's existing google-calendar.ts
 * precedent (no Node-targeted `googleapis` SDK in a Workers runtime).
 *
 * Reference: https://developers.google.com/maps/documentation/geocoding/requests-geocoding
 */

const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

/** 8s: generous enough for a real Google API round trip (typically well
 *  under 1s) while staying well inside a Worker request's own CPU/wall-time
 *  budget — bounded per Section 9's explicit requirement, not left to the
 *  runtime's own (much longer) default. Configurable per-instance so tests
 *  can use a short timeout against a deliberately slow mock instead of
 *  waiting out a real 8 seconds. */
export const DEFAULT_GEOCODE_TIMEOUT_MS = 8000;

export type GoogleGeocodingBindings = {
  /** Secret — Worker secret only (`.dev.vars` locally, `wrangler secret
   *  put` in production). Never `wrangler.toml [vars]`, never D1, never
   *  Global Settings, never sent to the client, never logged. */
  GOOGLE_MAPS_API_KEY?: string;
  /** Non-secret mode selector — lives in wrangler.toml's [vars], same tier
   *  as RESEND_FROM_ADDRESS. "none" (default if unset) or "google". */
  GEOCODING_PROVIDER?: string;
};

interface GoogleGeocodeApiResponse {
  status: string;
  results?: Array<{
    formatted_address?: string;
    place_id?: string;
    geometry?: { location?: { lat?: number; lng?: number } };
  }>;
}

/** Maps a non-2xx HTTP response (a transport/gateway-level failure — Google
 *  itself signals almost everything, including "no results" and "bad key",
 *  via a 200 response with a JSON `status` field, not an HTTP status code)
 *  to a safe internal code. Never includes the response body. */
function httpStatusToGeocodeCode(status: number): string {
  if (status === 401 || status === 403) return "PROVIDER_AUTH_ERROR";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "PROVIDER_UNAVAILABLE";
  return "INVALID_RESPONSE";
}

/** Maps Google's own `status` field (present even on a 200 response) to a
 *  safe internal code. Only `OK` (with a usable result) and `ZERO_RESULTS`
 *  are genuine verdicts about the address; every other value is treated as
 *  a provider/config problem — see TRANSIENT_GEOCODE_CODES in geocoding.ts
 *  for why that distinction matters to how the job's status ends up
 *  persisted. `INVALID_REQUEST` (per Google's own docs: the address param
 *  is missing) should never happen here since geocodeJob() already skips
 *  blank addresses before calling any provider — if it ever does, that
 *  means something is broken on OUR side, not the address, hence
 *  INVALID_RESPONSE rather than a false "this address doesn't exist". */
function googleStatusToGeocodeCode(status: string): string {
  switch (status) {
    case "OVER_QUERY_LIMIT": return "RATE_LIMITED";
    case "REQUEST_DENIED": return "PROVIDER_AUTH_ERROR";
    case "INVALID_REQUEST":
    case "UNKNOWN_ERROR":
    default: return "INVALID_RESPONSE";
  }
}

export class GoogleGeocodingProvider implements GeocodingProvider {
  constructor(
    private readonly apiKey: string,
    private readonly timeoutMs: number = DEFAULT_GEOCODE_TIMEOUT_MS,
  ) {}

  async geocode(input: GeocodeInput): Promise<GeocodeResult> {
    // URLSearchParams handles address encoding (spaces, &, #, unicode, etc)
    // — never hand-build the query string. `region=ca`: a soft bias
    // (Google may still return a better match elsewhere), not a hard
    // filter via `components=country:CA` — this business operates in BC
    // (see mem:architecture/google-calendar-integration's BUSINESS_TIMEZONE
    // default of America/Vancouver) and a soft bias reduces cross-border
    // ambiguity (e.g. a "Vancouver" address resolving to Washington State)
    // without ever hard-rejecting a legitimate non-Canadian address.
    const params = new URLSearchParams({ address: input.address, region: "ca", key: this.apiKey });

    let res: Response;
    try {
      res = await fetch(`${GEOCODE_URL}?${params.toString()}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Never leak the underlying fetch error's message — it can include
      // the full request URL, which carries the API key.
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        console.error(`[geocoding:google] outcome=timeout timeout_ms=${this.timeoutMs}`);
        throw new GeocodingError("TIMEOUT", "Google Maps Platform did not respond in time");
      }
      console.error("[geocoding:google] outcome=network_error");
      throw new GeocodingError("PROVIDER_UNAVAILABLE", "Failed to reach Google Maps Platform");
    }

    if (!res.ok) {
      const code = httpStatusToGeocodeCode(res.status);
      console.error(`[geocoding:google] http_status=${res.status} code=${code}`);
      throw new GeocodingError(code, `Google Maps Platform responded with HTTP ${res.status}`);
    }

    let data: GoogleGeocodeApiResponse;
    try {
      data = await res.json();
    } catch {
      console.error("[geocoding:google] outcome=malformed_json");
      throw new GeocodingError("INVALID_RESPONSE", "Google Maps Platform returned a non-JSON response");
    }

    if (data.status === "ZERO_RESULTS") {
      return { status: "not_found" };
    }

    if (data.status !== "OK") {
      const code = googleStatusToGeocodeCode(data.status);
      console.error(`[geocoding:google] google_status=${data.status} code=${code}`);
      throw new GeocodingError(code, `Google Maps Platform returned status ${data.status}`);
    }

    // Result selection policy: the FIRST result of an "OK" response only.
    // Google orders results by relevance; a Job's service address is a
    // single real-world location, not a set of candidates for the caller
    // to disambiguate. `partial_match`/`location_type` (ROOFTOP vs
    // APPROXIMATE etc) are deliberately NOT used to reject an otherwise-OK
    // result — Phase 10's map-marker/dispatch use case doesn't need
    // rooftop-level precision, and rejecting partial matches would
    // silently turn a great many legitimately-resolvable addresses into
    // permanent `failed` verdicts. Coordinates are still independently
    // validated below (defense in depth) regardless of what Google claims.
    const first = data.results?.[0];
    const lat = first?.geometry?.location?.lat;
    const lng = first?.geometry?.location?.lng;
    if (!first || !isValidCoordinatePair(lat, lng)) {
      console.error("[geocoding:google] outcome=invalid_coordinate google_status=OK");
      throw new GeocodingError("INVALID_RESPONSE", "Google Maps Platform returned an OK status with no usable coordinate");
    }

    return {
      status: "ok",
      latitude: lat as number,
      longitude: lng as number,
      formattedAddress: first.formatted_address,
      providerReference: first.place_id,
    };
  }
}

/** Zero network calls, always fails the same safe way — the correct
 *  behavior for `GEOCODING_PROVIDER=google` with no `GOOGLE_MAPS_API_KEY`
 *  configured. Deliberately NOT a silent fallback to NoopGeocodingProvider:
 *  Noop's `not_found` would persist as `failed`, wrongly implying the
 *  ADDRESS is bad, when the real problem is the SERVER's config —
 *  PROVIDER_AUTH_ERROR is a TRANSIENT code (geocoding.ts), so this persists
 *  as `pending` (retry once actually configured) instead. */
class UnconfiguredGoogleGeocodingProvider implements GeocodingProvider {
  async geocode(): Promise<GeocodeResult> {
    throw new GeocodingError(
      "PROVIDER_AUTH_ERROR",
      "Google Maps Platform is not configured on this server (missing GOOGLE_MAPS_API_KEY)",
    );
  }
}

/** Selects which GeocodingProvider real application code uses, based on
 *  Worker config — mirrors notification-dispatcher.ts's buildProviders()
 *  factory pattern exactly (env in, provider out, zero provider-specific
 *  logic anywhere else, including index.ts). The ONLY call site for this
 *  function is the geocode route handler in index.ts. */
export function buildGeocodingProvider(env: GoogleGeocodingBindings): GeocodingProvider {
  const mode = (env.GEOCODING_PROVIDER || "none").trim().toLowerCase();
  if (mode !== "google") return new NoopGeocodingProvider();
  if (!env.GOOGLE_MAPS_API_KEY) return new UnconfiguredGoogleGeocodingProvider();
  return new GoogleGeocodingProvider(env.GOOGLE_MAPS_API_KEY);
}
