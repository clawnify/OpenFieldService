import {
  GeocodingError,
  type RouteInput,
  type RouteLeg,
  type RouteResult,
  type RoutingProvider,
} from "./geocoding.js";
import { NoopRoutingProvider } from "./geocoding.js";

/**
 * Phase 10.4 — Google Routes API adapter (Compute Routes:
 * https://developers.google.com/maps/documentation/routes/compute_route_directions).
 * Server-side only — the browser never sees this key or calls this API
 * directly (see mem:phase10/maps-routing-architecture-audit's Section 12).
 * Same "no provider-specific logic outside the adapter" discipline as
 * google-geocoding.ts: everything Google-shaped (request body, headers,
 * field mask, duration-string parsing, error status vocabulary) stays in
 * this file; callers only ever see `RoutingProvider`/`RouteResult`.
 *
 * DRIVE travel mode only, `routingPreference: "TRAFFIC_UNAWARE"` (Traffic:
 * NOT ENABLED per Phase 10.4's scope — Google's own documented default,
 * set explicitly here rather than relied upon implicitly), and
 * `optimizeWaypointOrder: false` HARD-CODED, never a caller-controlled
 * option — this is Section 6's scheduled-order invariant enforced at the
 * one place a real HTTP request is built, not just documented policy.
 */

export type RoutingBindings = {
  /** Secret — Worker secret only (`.dev.vars` locally, `wrangler secret
   *  put` in production). Deliberately a SEPARATE key from
   *  GOOGLE_MAPS_API_KEY (Phase 10.1's geocoding secret) — a Routes API
   *  key restricted to the Routes API should never also be trusted for
   *  Geocoding, and vice versa, even though both could technically be the
   *  same underlying Google Cloud project. Never sent to the client,
   *  never logged. */
  GOOGLE_ROUTES_API_KEY?: string;
  /** Non-secret mode selector — same tier/pattern as GEOCODING_PROVIDER.
   *  "none" (default if unset) or "google". */
  ROUTING_PROVIDER?: string;
};

const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const DEFAULT_ROUTE_TIMEOUT_MS = 8000;
const FIELD_MASK = "routes.distanceMeters,routes.duration,routes.legs.distanceMeters,routes.legs.duration,routes.polyline.encodedPolyline";

/** Google's documented ComputeRoutes limit — at most 25 intermediate
 *  waypoints per request (origin + 25 intermediates + destination = 27
 *  total locations). routing.ts's batching logic uses this to split a
 *  longer contiguous run of geocoded stops into multiple sequential
 *  requests rather than truncating stops or fabricating a shortcut. */
export const MAX_INTERMEDIATE_WAYPOINTS = 25;

interface GoogleRouteApiWaypoint {
  location: { latLng: { latitude: number; longitude: number } };
}

interface GoogleRouteApiLeg {
  distanceMeters?: number;
  duration?: string;
}

interface GoogleRouteApiRoute {
  distanceMeters?: number;
  duration?: string;
  legs?: GoogleRouteApiLeg[];
  polyline?: { encodedPolyline?: string };
}

interface GoogleRouteApiResponse {
  routes?: GoogleRouteApiRoute[];
}

interface GoogleApiErrorBody {
  error?: { code?: number; message?: string; status?: string };
}

function toWaypoint(point: { latitude: number; longitude: number }): GoogleRouteApiWaypoint {
  return { location: { latLng: { latitude: point.latitude, longitude: point.longitude } } };
}

/** Google returns duration as a string like "165s" (seconds + literal "s"
 *  suffix, per the API's `google.protobuf.Duration` JSON encoding) —
 *  never a bare number. Returns null (not a fabricated 0) for anything
 *  that doesn't parse, so the caller can treat it as INVALID_RESPONSE. */
function parseDurationSeconds(value: unknown): number | null {
  if (typeof value !== "string" || !value.endsWith("s")) return null;
  const seconds = Number(value.slice(0, -1));
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function googleStatusToRouteCode(status: string | undefined): string {
  switch (status) {
    case "RESOURCE_EXHAUSTED": return "RATE_LIMITED";
    case "PERMISSION_DENIED":
    case "UNAUTHENTICATED": return "PROVIDER_AUTH_ERROR";
    case "INVALID_ARGUMENT": return "INVALID_ROUTE_INPUT";
    case "NOT_FOUND": return "NO_ROUTE";
    case "UNAVAILABLE":
    case "DEADLINE_EXCEEDED": return "PROVIDER_UNAVAILABLE";
    default: return "PROVIDER_ERROR";
  }
}

function httpStatusToRouteCode(status: number): string {
  if (status === 401 || status === 403) return "PROVIDER_AUTH_ERROR";
  if (status === 429) return "RATE_LIMITED";
  if (status === 400) return "INVALID_ROUTE_INPUT";
  if (status >= 500) return "PROVIDER_UNAVAILABLE";
  return "PROVIDER_ERROR";
}

export class GoogleRoutingProvider implements RoutingProvider {
  constructor(
    private readonly apiKey: string,
    private readonly timeoutMs: number = DEFAULT_ROUTE_TIMEOUT_MS,
  ) {}

  async route(input: RouteInput): Promise<RouteResult> {
    const waypoints = input.waypoints ?? [];
    if (waypoints.length > MAX_INTERMEDIATE_WAYPOINTS) {
      // Defense in depth — routing.ts's batching is the real bound; this
      // adapter must never silently truncate a caller-supplied list.
      throw new GeocodingError("INVALID_ROUTE_INPUT", `Too many waypoints for a single request (max ${MAX_INTERMEDIATE_WAYPOINTS})`);
    }

    const body = {
      origin: toWaypoint(input.origin),
      destination: toWaypoint(input.destination),
      intermediates: waypoints.map(toWaypoint),
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_UNAWARE",
      // HARD-CODED false — never derived from a caller/request value. The
      // Scheduler is the sole authority on stop order (Section 6).
      optimizeWaypointOrder: false,
      units: "METRIC",
      languageCode: "en-US",
    };

    let res: Response;
    try {
      res = await fetch(ROUTES_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": this.apiKey,
          "X-Goog-FieldMask": FIELD_MASK,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Never leak the underlying fetch error's message — defense in depth
      // even though (unlike geocoding) the key here never rides in a URL.
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        console.error(`[routing:google] outcome=timeout timeout_ms=${this.timeoutMs}`);
        throw new GeocodingError("TIMEOUT", "Google Routes API did not respond in time");
      }
      console.error("[routing:google] outcome=network_error");
      throw new GeocodingError("PROVIDER_UNAVAILABLE", "Failed to reach Google Routes API");
    }

    if (!res.ok) {
      let status: string | undefined;
      try {
        const errBody = (await res.json()) as GoogleApiErrorBody;
        status = errBody.error?.status;
      } catch {
        // malformed/empty error body — fall through to the HTTP-status mapping
      }
      const code = status ? googleStatusToRouteCode(status) : httpStatusToRouteCode(res.status);
      console.error(`[routing:google] http_status=${res.status} google_status=${status ?? "unknown"} code=${code}`);
      throw new GeocodingError(code, `Google Routes API responded with HTTP ${res.status}`);
    }

    let data: GoogleRouteApiResponse;
    try {
      data = await res.json();
    } catch {
      console.error("[routing:google] outcome=malformed_json");
      throw new GeocodingError("INVALID_RESPONSE", "Google Routes API returned a non-JSON response");
    }

    const route = data.routes?.[0];
    if (!route) {
      console.error("[routing:google] outcome=no_route");
      throw new GeocodingError("NO_ROUTE", "Google Routes API found no route between the given stops");
    }

    const expectedLegCount = waypoints.length + 1;
    const rawLegs = route.legs ?? [];
    if (rawLegs.length !== expectedLegCount) {
      console.error(`[routing:google] outcome=invalid_response leg_count=${rawLegs.length} expected=${expectedLegCount}`);
      throw new GeocodingError("INVALID_RESPONSE", "Google Routes API returned an unexpected number of legs");
    }

    const legs: RouteLeg[] = [];
    for (const rawLeg of rawLegs) {
      const distanceMeters = rawLeg.distanceMeters;
      const durationSeconds = parseDurationSeconds(rawLeg.duration);
      if (typeof distanceMeters !== "number" || !Number.isFinite(distanceMeters) || distanceMeters < 0 || durationSeconds === null) {
        console.error("[routing:google] outcome=invalid_response reason=bad_leg_fields");
        throw new GeocodingError("INVALID_RESPONSE", "Google Routes API returned an invalid leg");
      }
      legs.push({ distanceMeters, durationSeconds });
    }

    const totalDistance = route.distanceMeters;
    const totalDuration = parseDurationSeconds(route.duration);
    if (typeof totalDistance !== "number" || !Number.isFinite(totalDistance) || totalDuration === null) {
      console.error("[routing:google] outcome=invalid_response reason=bad_totals");
      throw new GeocodingError("INVALID_RESPONSE", "Google Routes API returned invalid route totals");
    }

    return {
      distanceMeters: totalDistance,
      durationSeconds: totalDuration,
      legs,
      geometry: route.polyline?.encodedPolyline,
    };
  }
}

/** Mirrors UnconfiguredGoogleGeocodingProvider (google-geocoding.ts) —
 *  ROUTING_PROVIDER=google with no key configured is a disclosed
 *  configuration problem, never a crash and never a silent fabricated
 *  route. */
class UnconfiguredGoogleRoutingProvider implements RoutingProvider {
  async route(): Promise<RouteResult> {
    throw new GeocodingError(
      "PROVIDER_AUTH_ERROR",
      "Google Routes API is not configured on this server (missing GOOGLE_ROUTES_API_KEY)",
    );
  }
}

export function buildRoutingProvider(env: RoutingBindings): RoutingProvider {
  const mode = (env.ROUTING_PROVIDER || "none").trim().toLowerCase();
  if (mode !== "google") return new NoopRoutingProvider();
  if (!env.GOOGLE_ROUTES_API_KEY) return new UnconfiguredGoogleRoutingProvider();
  return new GoogleRoutingProvider(env.GOOGLE_ROUTES_API_KEY);
}
