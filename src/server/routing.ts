import { GeocodingError, type RoutePoint, type RoutingProvider } from "./geocoding.js";
import { MAX_INTERMEDIATE_WAYPOINTS } from "./google-routing.js";

/**
 * Phase 10.4 — Routing/Travel-Time domain service. Orchestrates
 * RoutingProvider calls across a technician's already-scheduled day; the
 * Scheduler (scheduled_time) remains the sole authority on stop order —
 * this module never reorders, optimizes, or persists an order (see
 * mem:phase10/maps-routing-architecture-audit's Section 6 invariant).
 *
 * Core policy (Section 10 — no fabricated continuity): a leg between two
 * consecutive scheduled stops is only ever computed when BOTH stops have
 * a real, current geocoded coordinate. A non-geocoded stop breaks the
 * chain — the legs immediately before and after it are reported
 * `unavailable`, never silently skipped so the route looks continuous.
 */

export interface RouteStopInput {
  jobId: number;
  scheduledTime: string;
  status: string;
  latitude: number | null;
  longitude: number | null;
  geocodeStatus: string | null;
}

export interface RouteLegOutcome {
  fromJobId: number;
  toJobId: number;
  status: "ok" | "unavailable";
  distanceMeters?: number;
  durationSeconds?: number;
  errorCode?: string;
}

export interface TechnicianRouteResult {
  legs: RouteLegOutcome[];
  /** Sum of every `ok` leg only — never a fabricated whole-day total when
   *  part of the route is unavailable. `null` (not `0`) when zero legs
   *  are `ok`, so a genuine "0m route" can never be confused with "no
   *  data". */
  totalDistanceMeters: number | null;
  totalDurationSeconds: number | null;
}

/** Same deterministic ordering as the client's technician-route-helpers.ts
 *  `orderStops()` — scheduled_time then id as a stable tie-break, cancelled
 *  jobs excluded. Duplicated deliberately (not imported) — this is a
 *  server-side module with no client dependency, matching this codebase's
 *  existing server/client separation. */
export function orderRouteStops(stops: RouteStopInput[]): RouteStopInput[] {
  return stops
    .filter((s) => s.status !== "cancelled")
    .slice()
    .sort((a, b) => a.scheduledTime.localeCompare(b.scheduledTime) || a.jobId - b.jobId);
}

export function isEligibleStop(stop: RouteStopInput): boolean {
  return stop.geocodeStatus === "geocoded" && stop.latitude != null && stop.longitude != null;
}

function toPoint(stop: RouteStopInput): RoutePoint {
  return { latitude: stop.latitude as number, longitude: stop.longitude as number };
}

/** Splits a contiguous run of eligible stops into request-sized batches,
 *  each within the provider's MAX_INTERMEDIATE_WAYPOINTS bound (+2 for
 *  origin/destination). Consecutive batches overlap by exactly one stop
 *  (the previous batch's destination becomes the next batch's origin) so
 *  every real leg in the run gets computed exactly once, never dropped or
 *  double-counted, and the run's scheduled order is preserved verbatim
 *  across the split. */
function batchRun<T>(run: T[], maxIntermediates: number): T[][] {
  const maxPerBatch = maxIntermediates + 2;
  if (run.length <= maxPerBatch) return [run];
  const batches: T[][] = [];
  let start = 0;
  while (start < run.length - 1) {
    const end = Math.min(start + maxPerBatch - 1, run.length - 1);
    batches.push(run.slice(start, end + 1));
    if (end === run.length - 1) break;
    start = end;
  }
  return batches;
}

/** Computes travel legs between a technician's already-ordered scheduled
 *  stops for one day. Never throws for an ordinary provider problem (a
 *  timeout/rate-limit/config error on one batch marks only that batch's
 *  legs `unavailable`, isolated the same way notification-dispatcher.ts's
 *  per-row isolation keeps one bad row from starving the rest of a cycle)
 *  — the caller always gets a complete, renderable result. */
export async function computeTechnicianRouteLegs(
  stops: RouteStopInput[],
  provider: RoutingProvider,
): Promise<TechnicianRouteResult> {
  const ordered = orderRouteStops(stops);
  const legs: RouteLegOutcome[] = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    legs.push({ fromJobId: ordered[i].jobId, toJobId: ordered[i + 1].jobId, status: "unavailable" });
  }

  let i = 0;
  while (i < ordered.length) {
    if (!isEligibleStop(ordered[i])) { i++; continue; }
    let j = i;
    while (j + 1 < ordered.length && isEligibleStop(ordered[j + 1])) j++;

    if (j > i) {
      const run = ordered.slice(i, j + 1);
      const batches = batchRun(run, MAX_INTERMEDIATE_WAYPOINTS);
      let legIndex = i;
      for (const batch of batches) {
        const origin = batch[0];
        const destination = batch[batch.length - 1];
        const waypoints = batch.slice(1, -1);
        try {
          const result = await provider.route({
            origin: toPoint(origin),
            destination: toPoint(destination),
            waypoints: waypoints.map(toPoint),
          });
          result.legs.forEach((leg, k) => {
            legs[legIndex + k] = {
              fromJobId: batch[k].jobId,
              toJobId: batch[k + 1].jobId,
              status: "ok",
              distanceMeters: leg.distanceMeters,
              durationSeconds: leg.durationSeconds,
            };
          });
        } catch (err) {
          const code = err instanceof GeocodingError ? err.code : "PROVIDER_ERROR";
          for (let k = 0; k < batch.length - 1; k++) {
            legs[legIndex + k] = { fromJobId: batch[k].jobId, toJobId: batch[k + 1].jobId, status: "unavailable", errorCode: code };
          }
        }
        legIndex += batch.length - 1;
      }
    }
    i = j + 1;
  }

  const okLegs = legs.filter((l) => l.status === "ok");
  return {
    legs,
    totalDistanceMeters: okLegs.length ? okLegs.reduce((sum, l) => sum + (l.distanceMeters ?? 0), 0) : null,
    totalDurationSeconds: okLegs.length ? okLegs.reduce((sum, l) => sum + (l.durationSeconds ?? 0), 0) : null,
  };
}
