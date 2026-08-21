import { Fragment } from "preact";
import { useState, useEffect, useRef } from "preact/hooks";
import { api } from "../api";
import { ConfirmDialog } from "./confirm-dialog";
import { STATUS_COLORS, STATUS_LABELS, STATUS_ABBR } from "./status-badge";
import { loadGoogleMaps } from "../google-maps-loader";
import { partitionMapJobs, computeMapView, nonGeocodedSummary, legBetween, formatTravelLeg, formatTravelTotal, type RouteLegView } from "../schedule-map-helpers";
import { MapPin, AlertTriangle, LocateFixed, Route as RouteIcon } from "lucide-preact";
import type { Job } from "../types";

/**
 * Phase 10.2 — Dispatcher Map view. Read-only: no marker drag, no job
 * drag, no scheduling mutation of any kind reaches the server from this
 * component except the one explicit, confirmed, opt-in "Geocode Location"
 * action (POST /api/jobs/{id}/geocode — the exact same Phase 10.1
 * endpoint, no new mutation path). Renders stored coordinates only —
 * never geocodes on render/pan/zoom/filter/date-navigation (see
 * mem:phase10/maps-routing-architecture-audit's Section 27/10/19).
 */

type ConfigState = "loading" | "unconfigured" | "ready" | "error";

interface ScheduleMapProps {
  jobs: Job[];
  canSchedule: boolean;
  navigate: (to: string) => void;
  onGeocoded: () => Promise<void>;
  /** Phase 10.4 — non-null only when the List filter has been narrowed to
   *  exactly one technician and a single-day range (see schedule-view.tsx's
   *  `mapRouteContext`). Null hides the "Show Travel Times" action
   *  entirely — routing a mixed multi-technician/multi-day job set has no
   *  single well-defined route to compute. */
  routeContext: { technicianId: number; date: string } | null;
}

function buildInfoWindowContent(job: Job, onNavigate: (to: string) => void): HTMLElement {
  // DOM construction via textContent only — never innerHTML/string
  // interpolation. address/customer/technician are admin/dispatcher-
  // entered free text; building via textContent makes any XSS-shaped
  // content inert regardless of what it contains.
  const container = document.createElement("div");
  container.className = "schedule-map-infowindow";

  const title = document.createElement("div");
  title.className = "schedule-map-infowindow-title";
  title.textContent = job.identifier;
  container.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "schedule-map-infowindow-meta";
  meta.textContent = `${job.scheduled_date} ${job.scheduled_time} (${job.duration} min)`;
  container.appendChild(meta);

  const status = document.createElement("div");
  status.textContent = `Status: ${STATUS_LABELS[job.status] || job.status}`;
  container.appendChild(status);

  const tech = document.createElement("div");
  tech.textContent = `Technician: ${job.technician_name || "Unassigned"}`;
  container.appendChild(tech);

  if (job.address) {
    const address = document.createElement("div");
    address.className = "schedule-map-infowindow-address";
    address.textContent = job.address;
    container.appendChild(address);
  }

  const link = document.createElement("button");
  link.type = "button";
  link.className = "btn btn-sm";
  link.textContent = "View Job";
  link.addEventListener("click", () => onNavigate(`/jobs/${job.id}`));
  container.appendChild(link);

  return container;
}

export function ScheduleMap({ jobs, canSchedule, navigate, onGeocoded, routeContext }: ScheduleMapProps) {
  const [configState, setConfigState] = useState<ConfigState>("loading");
  const [browserApiKey, setBrowserApiKey] = useState<string | null>(null);
  const [mapsReady, setMapsReady] = useState(false);
  const [mapsLoadFailed, setMapsLoadFailed] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);
  const [mobileShowMap, setMobileShowMap] = useState(false);

  const [geocodeTarget, setGeocodeTarget] = useState<Job | null>(null);
  const [geocodeSubmitting, setGeocodeSubmitting] = useState(false);
  const [geocodeResult, setGeocodeResult] = useState<{ jobId: number; ok: boolean; text: string } | null>(null);

  // Phase 10.4 — never fetched automatically (cost control): only the
  // explicit "Show Travel Times" button below calls GET
  // /api/technician/route. Resets whenever the routed technician/day
  // changes, since a fetched route always belongs to exactly one of them.
  const [routeLegs, setRouteLegs] = useState<RouteLegView[] | null>(null);
  const [routeTotals, setRouteTotals] = useState<{ distance: number | null; duration: number | null } | null>(null);
  const [legsLoading, setLegsLoading] = useState(false);
  const [legsError, setLegsError] = useState<string | null>(null);

  useEffect(() => {
    setRouteLegs(null);
    setRouteTotals(null);
    setLegsError(null);
  }, [routeContext?.technicianId, routeContext?.date]);

  const loadTravelTimes = async () => {
    if (!routeContext) return;
    setLegsLoading(true);
    setLegsError(null);
    try {
      const res = await api<{ legs: RouteLegView[]; total_distance_meters: number | null; total_duration_seconds: number | null }>(
        "GET", `/api/technician/route?date=${routeContext.date}&technician_id=${routeContext.technicianId}`
      );
      setRouteLegs(res.legs);
      setRouteTotals({ distance: res.total_distance_meters, duration: res.total_duration_seconds });
    } catch {
      setLegsError("Couldn't load travel times right now.");
    } finally {
      setLegsLoading(false);
    }
  };

  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<Map<number, google.maps.Marker>>(new Map());
  const infoWindowRef = useRef<google.maps.InfoWindow | null>(null);

  const { markers, nonGeocoded } = partitionMapJobs(jobs);
  const summary = nonGeocodedSummary(nonGeocoded.length);

  // Config + script load — once per mount, never re-triggered by job/date/
  // filter changes (Section 27: zero server geocoding calls from render;
  // this is a one-time config read + a one-time script load, not a
  // geocoding call at all).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await api<{ enabled: boolean; browserApiKey: string | null }>("GET", "/api/config/maps");
        if (cancelled) return;
        if (!cfg.enabled || !cfg.browserApiKey) {
          setConfigState("unconfigured");
          return;
        }
        setBrowserApiKey(cfg.browserApiKey);
        setConfigState("ready");
      } catch {
        if (!cancelled) setConfigState("error");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (configState !== "ready" || !browserApiKey) return;
    let cancelled = false;
    loadGoogleMaps(browserApiKey)
      .then(() => { if (!cancelled) setMapsReady(true); })
      .catch(() => { if (!cancelled) setMapsLoadFailed(true); });
    return () => { cancelled = true; };
  }, [configState, browserApiKey]);

  // Create the Map instance once, when the script is ready and the
  // container is mounted.
  useEffect(() => {
    if (!mapsReady || !mapContainerRef.current || mapRef.current) return;
    mapRef.current = new google.maps.Map(mapContainerRef.current, {
      center: { lat: 0, lng: 0 },
      zoom: 2,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      gestureHandling: "greedy",
    });
    infoWindowRef.current = new google.maps.InfoWindow();
  }, [mapsReady]);

  // Rebuild markers whenever the visible job set changes. Small ranges
  // (a Scheduler date window, never a company-wide load — Section 8) make
  // a full clear+recreate simpler and safer than incremental diffing, with
  // no meaningful performance cost at this scale.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    for (const marker of markersRef.current.values()) marker.setMap(null);
    markersRef.current.clear();

    for (const m of markers) {
      const marker = new google.maps.Marker({
        position: { lat: m.lat, lng: m.lng },
        map,
        title: `${m.job.identifier} — ${STATUS_LABELS[m.job.status] || m.job.status}`,
      });
      marker.addListener("click", () => setSelectedJobId(m.job.id));
      markersRef.current.set(m.job.id, marker);
    }

    const view = computeMapView(markers);
    if (view.kind === "point") {
      map.setCenter({ lat: view.lat, lng: view.lng });
      map.setZoom(14);
    } else if (view.kind === "bounds") {
      map.fitBounds({ north: view.north, south: view.south, east: view.east, west: view.west }, 48);
    }
    // "empty" (0 markers): deliberately leave the camera as-is — no
    // hardcoded fallback city (Section 16's explicit requirement); the
    // empty-state overlay below communicates the "no mapped jobs" state.
  }, [markers, mapsReady]);

  // Selection sync — the single source of truth for both directions
  // (Section 14): marker click and list-row click/keyboard-select both
  // only ever call setSelectedJobId(); this effect does the rest (pan the
  // map, open the correct InfoWindow, scroll the matching list row into
  // view).
  useEffect(() => {
    if (selectedJobId === null) return;
    const map = mapRef.current;
    const marker = markersRef.current.get(selectedJobId);
    const job = markers.find((m) => m.job.id === selectedJobId)?.job;
    if (map && marker && job && infoWindowRef.current) {
      map.setCenter(marker.getPosition() || { lat: 0, lng: 0 });
      infoWindowRef.current.close();
      infoWindowRef.current = new google.maps.InfoWindow({ content: buildInfoWindowContent(job, navigate) });
      infoWindowRef.current.open({ map, anchor: marker });
    }
    document.getElementById(`schedule-map-row-${selectedJobId}`)?.scrollIntoView({ block: "nearest" });
  }, [selectedJobId]); // eslint-disable-line react-hooks/exhaustive-deps

  const submitGeocode = async () => {
    if (!geocodeTarget) return;
    setGeocodeSubmitting(true);
    const job = geocodeTarget;
    try {
      const res = await api<{ ok: boolean; geocode_status: string }>("POST", `/api/jobs/${job.id}/geocode`, {});
      await onGeocoded();
      setGeocodeResult({
        jobId: job.id,
        ok: res.geocode_status === "geocoded",
        text: res.geocode_status === "geocoded"
          ? `${job.identifier} was mapped successfully.`
          : res.geocode_status === "pending"
            ? `${job.identifier} couldn't be mapped right now — it will be retried later.`
            : `${job.identifier}'s address couldn't be found on the map.`,
      });
    } catch {
      setGeocodeResult({ jobId: job.id, ok: false, text: `${job.identifier} couldn't be mapped right now.` });
    } finally {
      setGeocodeSubmitting(false);
      setGeocodeTarget(null);
    }
  };

  return (
    <div class="schedule-map-view">
      {summary && (
        <div class="schedule-map-banner">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{summary}</span>
        </div>
      )}
      {geocodeResult && (
        <div class={`schedule-map-banner ${geocodeResult.ok ? "success" : ""}`}>
          <span>{geocodeResult.text}</span>
          <button type="button" class="btn-icon" aria-label="Dismiss" onClick={() => setGeocodeResult(null)}>×</button>
        </div>
      )}

      {routeContext ? (
        <div class="tech-route-travel-control">
          <button type="button" class="btn btn-sm" onClick={loadTravelTimes} disabled={legsLoading || jobs.length < 2}>
            <RouteIcon size={13} aria-hidden="true" /> {legsLoading ? "Loading travel times…" : routeLegs ? "Refresh Travel Times" : "Show Travel Times"}
          </button>
          {legsError && <span class="text-muted">{legsError}</span>}
          {routeTotals && (() => {
            const totalText = formatTravelTotal(routeTotals.distance, routeTotals.duration);
            return <span class="text-muted">{totalText ?? "Travel time unavailable for this route."}</span>;
          })()}
        </div>
      ) : (
        <div class="tech-route-travel-control">
          <span class="text-muted"><RouteIcon size={13} aria-hidden="true" /> Select a single technician and a single-day range in the filters above to see travel times.</span>
        </div>
      )}

      <div class="schedule-map-mobile-toggle">
        <button type="button" class="btn" onClick={() => setMobileShowMap((v) => !v)}>
          {mobileShowMap ? "Show List" : "Show Map"}
        </button>
      </div>

      <div class="schedule-map-split">
        <div class={`schedule-map-pane schedule-map-pane-map ${mobileShowMap ? "" : "mobile-hidden"}`}>
          {configState === "loading" && (
            <div class="schedule-map-status">Loading map…</div>
          )}
          {configState === "unconfigured" && (
            <div class="schedule-map-status">
              <MapPin size={20} aria-hidden="true" />
              <p>Map display isn't configured for this server yet. Jobs are still available in the list.</p>
            </div>
          )}
          {configState === "error" && (
            <div class="schedule-map-status">
              <p>Couldn't load map settings. Jobs are still available in the list.</p>
            </div>
          )}
          {configState === "ready" && mapsLoadFailed && (
            <div class="schedule-map-status">
              <p>The map couldn't be loaded. Jobs are still available in the list.</p>
            </div>
          )}
          {configState === "ready" && !mapsLoadFailed && (
            <>
              <div ref={mapContainerRef} class="schedule-map-canvas" role="img" aria-label="Map of scheduled jobs in the current range" />
              {mapsReady && markers.length === 0 && (
                <div class="schedule-map-empty-overlay">
                  <LocateFixed size={20} aria-hidden="true" />
                  <p>No mapped jobs in this range.</p>
                </div>
              )}
            </>
          )}
        </div>

        <div class={`schedule-map-pane schedule-map-list ${mobileShowMap ? "mobile-hidden" : ""}`}>
          {jobs.length === 0 ? (
            <div class="tech-empty-state"><p>No jobs in this range.</p></div>
          ) : (
            <ul class="schedule-map-job-list">
              {jobs.map((job, idx) => {
                const isGeocoded = job.geocode_status === "geocoded" && job.latitude != null && job.longitude != null;
                // Adjacent-pair only (matches routing.ts's own scheduled-
                // order adjacency) — a cancelled job on either side of a
                // pair means no leg is shown for that pair, since the
                // server never computed one for a cancelled stop either
                // (disclosed P3: if a cancelled job sits directly BETWEEN
                // two routed stops in this rendered list, the real leg
                // connecting those two stops isn't shown here; filter
                // Status to exclude Cancelled to see it).
                const nextJob = idx < jobs.length - 1 ? jobs[idx + 1] : null;
                const showLeg = Boolean(
                  routeContext && routeLegs !== null && nextJob && job.status !== "cancelled" && nextJob.status !== "cancelled"
                );
                const leg = showLeg && nextJob ? legBetween(routeLegs ?? [], job.id, nextJob.id) : undefined;
                return (
                  <Fragment key={job.id}>
                  <li
                    id={`schedule-map-row-${job.id}`}
                    class={`schedule-map-job-row ${selectedJobId === job.id ? "selected" : ""}`}
                    role="button"
                    tabIndex={0}
                    aria-current={selectedJobId === job.id}
                    onClick={() => isGeocoded && setSelectedJobId(job.id)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && isGeocoded && (e.preventDefault(), setSelectedJobId(job.id))}
                  >
                    <div class="schedule-row-top">
                      <span class="identifier">{job.identifier}</span>
                      <span
                        class="schedule-job-status-badge"
                        style={{ background: `${STATUS_COLORS[job.status] || "#6b7280"}22`, color: STATUS_COLORS[job.status] || "#6b7280" }}
                      >
                        {STATUS_ABBR[job.status] || "?"}
                      </span>
                      {!isGeocoded && <span class="text-muted schedule-map-nogeo-tag">Not mapped</span>}
                    </div>
                    <div class="text-bold">{job.scheduled_time} <span class="text-muted">({job.duration} min)</span></div>
                    <div>{job.customer_name || "—"}</div>
                    {job.address && <div class="text-muted schedule-row-address"><MapPin size={12} /> {job.address}</div>}
                    <div class="text-muted">{job.technician_name || "Unassigned"}</div>
                    <div class="schedule-map-row-actions">
                      <button type="button" class="btn btn-sm" onClick={(e) => { e.stopPropagation(); navigate(`/jobs/${job.id}`); }}>
                        View Job
                      </button>
                      {canSchedule && !isGeocoded && (
                        <button
                          type="button" class="btn btn-sm"
                          onClick={(e) => { e.stopPropagation(); setGeocodeTarget(job); }}
                        >
                          Geocode Location
                        </button>
                      )}
                    </div>
                  </li>
                  {showLeg && (
                    <li class="tech-route-leg" aria-hidden="true">
                      <RouteIcon size={12} /> {formatTravelLeg(leg)}
                    </li>
                  )}
                  </Fragment>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {geocodeTarget && (
        <ConfirmDialog
          title="Geocode Location?"
          message={`Look up map coordinates for ${geocodeTarget.identifier}'s service address (${geocodeTarget.address})? This uses your server's configured mapping provider.`}
          confirmLabel="Geocode"
          submitting={geocodeSubmitting}
          onConfirm={submitGeocode}
          onClose={() => setGeocodeTarget(null)}
        />
      )}
    </div>
  );
}
