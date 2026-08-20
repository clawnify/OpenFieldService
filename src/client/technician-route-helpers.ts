import type { Job } from "./types";

/**
 * Phase 10.3 — pure, dependency-free logic for the Technician Route View.
 * No DOM, no Google Maps SDK, no fetch — same "extract client logic into
 * a plain .ts module" precedent as navigation.ts/schedule-map-helpers.ts.
 * The input `jobs` array is assumed already server-scoped to the caller's
 * own technician id (GET /api/schedule) — nothing here re-filters by
 * technician identity; that's a server-side guarantee, not a client one.
 */

export interface NumberedStop {
  job: Job;
  stopNumber: number;
}

/** Deterministic day-sequence order: scheduled_time, then id as a stable
 *  tie-break for two jobs at the exact same time (never `route_order`/
 *  `visit_sequence` — no such concept exists; this is purely a display
 *  ordering derived fresh every render from the Scheduler's own
 *  authoritative `scheduled_time`). Cancelled jobs are excluded, matching
 *  technician-home.tsx's existing `active` filter precedent. */
export function orderStops(jobs: Job[]): Job[] {
  return jobs
    .filter((j) => j.status !== "cancelled")
    .slice()
    .sort((a, b) => a.scheduled_time.localeCompare(b.scheduled_time) || a.id - b.id);
}

/** Assigns a 1-based stop number reflecting the technician's day sequence
 *  — applied to EVERY stop (geocoded or not), since a non-geocoded job
 *  still has a real place in the day's order; only map-marker rendering
 *  (a separate concern, see schedule-map-helpers.ts#partitionMapJobs)
 *  filters by geocode status. Never persisted — recomputed fresh from
 *  `orderStops()` every time. */
export function numberStops(orderedJobs: Job[]): NumberedStop[] {
  return orderedJobs.map((job, i) => ({ job, stopNumber: i + 1 }));
}

/** Resolves "today" through the app's shared BUSINESS_TIMEZONE, never the
 *  browser's local timezone and never a hardcoded city — `en-CA`'s default
 *  date format is already `YYYY-MM-DD`, so no manual string assembly is
 *  needed. Falls back to `'America/Vancouver'` only if `timezone` is
 *  empty/unresolved — mirrors `src/server/business-timezone.ts`'s own
 *  documented final-fallback value, not a new invented default. */
export function todayInBusinessTimezone(timezone: string | null | undefined): string {
  const tz = timezone && timezone.trim() ? timezone : "America/Vancouver";
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/** Shifts an ISO `YYYY-MM-DD` date string by `delta` days — pure string/Date
 *  arithmetic, no timezone reinterpretation (the date is treated as a plain
 *  calendar date, matching schedule-view.tsx's own `addDays()` precedent). */
export function addDaysToIsoDate(dateStr: string, delta: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + delta);
  return d.toISOString().split("T")[0];
}
