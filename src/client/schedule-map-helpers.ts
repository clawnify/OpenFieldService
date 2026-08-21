import type { Job } from "./types";

/**
 * Phase 10.2 — pure, dependency-free logic for the Dispatcher Map view,
 * extracted from schedule-map.tsx so it can be unit-tested directly (same
 * "no client-side DOM test infrastructure — extract pure logic into a
 * plain .ts module" precedent as navigation.ts/signature-geometry.ts).
 * Nothing here touches the Google Maps SDK, the DOM, or fetch.
 */

export interface MapMarkerJob {
  job: Job;
  lat: number;
  lng: number;
}

/** Splits the current Scheduler range's jobs into those with a usable,
 *  validated coordinate pair (Section 10: geocode_status === 'geocoded'
 *  AND both coordinates non-null — never trust a 'pending'/'failed' row's
 *  stale/absent lat/lng even if one happens to be non-null) and everything
 *  else. Never fabricates a coordinate. */
export function partitionMapJobs(jobs: Job[]): { markers: MapMarkerJob[]; nonGeocoded: Job[] } {
  const markers: MapMarkerJob[] = [];
  const nonGeocoded: Job[] = [];
  for (const job of jobs) {
    if (job.geocode_status === "geocoded" && typeof job.latitude === "number" && typeof job.longitude === "number") {
      markers.push({ job, lat: job.latitude, lng: job.longitude });
    } else {
      nonGeocoded.push(job);
    }
  }
  return { markers, nonGeocoded };
}

export type MapView =
  | { kind: "empty" }
  | { kind: "point"; lat: number; lng: number }
  | { kind: "bounds"; north: number; south: number; east: number; west: number };

/** Section 16's exact bounds policy, as a pure function so it's testable
 *  without a real google.maps.LatLngBounds instance. 0 markers -> empty
 *  state (never a hardcoded default center). 1 marker -> center on it.
 *  2+ -> a bounding box the caller fits the map to. */
export function computeMapView(markers: MapMarkerJob[]): MapView {
  if (markers.length === 0) return { kind: "empty" };
  if (markers.length === 1) return { kind: "point", lat: markers[0].lat, lng: markers[0].lng };
  let north = markers[0].lat, south = markers[0].lat, east = markers[0].lng, west = markers[0].lng;
  for (const m of markers) {
    if (m.lat > north) north = m.lat;
    if (m.lat < south) south = m.lat;
    if (m.lng > east) east = m.lng;
    if (m.lng < west) west = m.lng;
  }
  return { kind: "bounds", north, south, east, west };
}

/** Business-friendly summary text for the non-geocoded-jobs banner
 *  (Section 11) — never silently drops them, never invents a coordinate,
 *  always says exactly how many and offers no false precision. */
export function nonGeocodedSummary(count: number): string | null {
  if (count === 0) return null;
  return count === 1 ? "1 job has no mapped location" : `${count} jobs have no mapped location`;
}

/**
 * Phase 10.4 — travel-leg presentation helpers, shared by the Dispatcher
 * Map and Technician Route views. Mirrors the server's
 * routing.ts#RouteLegOutcome shape field-for-field (snake_case, matching
 * the wire response from GET /api/technician/route) — no client-side
 * fabrication of distance/duration ever happens here; an `unavailable` leg
 * always renders as exactly that, never a guess.
 */
export interface RouteLegView {
  from_job_id: number;
  to_job_id: number;
  status: "ok" | "unavailable";
  distance_meters?: number;
  duration_seconds?: number;
  error_code?: string;
}

/** Finds the leg connecting two consecutive stops, if the route response
 *  included one. Returns undefined (not a fabricated "unavailable" leg)
 *  when no route data has been fetched at all — callers distinguish "no
 *  data fetched yet" from "fetched, but this leg is unavailable" via the
 *  caller's own loaded-state, not via this helper's return type. */
export function legBetween(legs: RouteLegView[], fromJobId: number, toJobId: number): RouteLegView | undefined {
  return legs.find((l) => l.from_job_id === fromJobId && l.to_job_id === toJobId);
}

/** Business-friendly one-line travel summary — "18 min · 12.4 km" for a
 *  computed leg, "Travel time unavailable" for a missing/unavailable one.
 *  Never shows a raw error_code or seconds/meters figure to the user. */
export function formatTravelLeg(leg: RouteLegView | undefined): string {
  if (!leg || leg.status !== "ok" || leg.distance_meters == null || leg.duration_seconds == null) {
    return "Travel time unavailable";
  }
  const minutes = Math.round(leg.duration_seconds / 60);
  const km = (leg.distance_meters / 1000).toFixed(1);
  return `${minutes} min · ${km} km`;
}

/** Business-friendly total for a full computed route — null (not "0")
 *  propagates straight through to "not available" text, matching
 *  totalDistanceMeters/totalDurationSeconds's own null-means-no-data
 *  contract from routing.ts. */
export function formatTravelTotal(totalDistanceMeters: number | null, totalDurationSeconds: number | null): string | null {
  if (totalDistanceMeters == null || totalDurationSeconds == null) return null;
  const minutes = Math.round(totalDurationSeconds / 60);
  const km = (totalDistanceMeters / 1000).toFixed(1);
  return `${minutes} min · ${km} km total driving`;
}
