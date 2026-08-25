import { Fragment } from "preact";
import { useState, useEffect, useRef, useMemo } from "preact/hooks";
import { useApp } from "../context";
import { api } from "../api";
import { ConfirmDialog } from "./confirm-dialog";
import { STATUS_COLORS, STATUS_LABELS, STATUS_ABBR } from "./status-badge";
import { loadGoogleMaps } from "../google-maps-loader";
import { partitionMapJobs, computeMapView, nonGeocodedSummary } from "../schedule-map-helpers";
import { orderStops, numberStops, todayInBusinessTimezone, addDaysToIsoDate } from "../technician-route-helpers";
import { buildNavigationUrl } from "../navigation";
import { legBetween, formatTravelLeg, formatTravelTotal, type RouteLegView } from "../schedule-map-helpers";
import { ChevronLeft, ChevronRight, MapPin, Navigation2, Truck, Route as RouteIcon } from "lucide-preact";
import type { Job } from "../types";

/**
 * Phase 10.3 — Technician Route View. Read-only with respect to
 * scheduling (no drag, no reassignment, no route-order persistence) —
 * the ONE mutation path is the existing Phase 9.1 On-The-Way endpoint,
 * reused verbatim, confirm-gated. Zero new API endpoints: the dataset is
 * GET /api/schedule (already technician-scoped server-side, already
 * carries latitude/longitude/geocode_status since Phase 10.2) narrowed to
 * a single selected day. Technician cannot trigger geocoding — no
 * "Geocode Location" action exists here (unlike the Dispatcher Map).
 */

type ConfigState = "loading" | "unconfigured" | "ready" | "error";

export function TechnicianRoute() {
  const { scheduleJobs, setScheduleRange, navigate } = useApp();

  const [businessTimezone, setBusinessTimezone] = useState<string | null>(null);
  const [routeDate, setRouteDate] = useState<string | null>(null);

  const [configState, setConfigState] = useState<ConfigState>("loading");
  const [browserApiKey, setBrowserApiKey] = useState<string | null>(null);
  const [mapsReady, setMapsReady] = useState(false);
  const [mapsLoadFailed, setMapsLoadFailed] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);
  const [mobileShowMap, setMobileShowMap] = useState(false);

  const [onTheWayTarget, setOnTheWayTarget] = useState<Job | null>(null);
  const [onTheWaySubmitting, setOnTheWaySubmitting] = useState(false);
  const [onTheWayResult, setOnTheWayResult] = useState<{ jobId: number; text: string } | null>(null);

  // Phase 10.4 — travel legs are NEVER fetched automatically (date
  // navigation/mount/pan/zoom must never cost a paid Routes call, see
  // mem:phase10/maps-routing-architecture-audit's cost-control table) —
  // only the explicit "Show Travel Times" button below triggers
  // GET /api/technician/route. Resets whenever the selected day changes,
  // since a fetched route always belongs to exactly one day.
  const [routeLegs, setRouteLegs] = useState<RouteLegView[] | null>(null);
  const [routeTotals, setRouteTotals] = useState<{ distance: number | null; duration: number | null } | null>(null);
  const [legsLoading, setLegsLoading] = useState(false);
  const [legsError, setLegsError] = useState<string | null>(null);

  useEffect(() => {
    setRouteLegs(null);
    setRouteTotals(null);
    setLegsError(null);
  }, [routeDate]);

  const loadTravelTimes = async () => {
    if (!routeDate) return;
    setLegsLoading(true);
    setLegsError(null);
    try {
      const res = await api<{ legs: RouteLegView[]; total_distance_meters: number | null; total_duration_seconds: number | null }>(
        "GET", `/api/technician/route?date=${routeDate}`
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

  // Resolve BUSINESS_TIMEZONE once via the narrow, non-sensitive config read
  // (Phase 13C — GET /api/settings is now admin-only, since it's the actual
  // Settings management surface) — then default routeDate to "today" in
  // that zone, never the browser's local zone and never a hardcoded city.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api<{ timezone: string }>("GET", "/api/config/business-timezone");
        if (cancelled) return;
        setBusinessTimezone(res.timezone);
        setRouteDate(todayInBusinessTimezone(res.timezone));
      } catch {
        if (!cancelled) setRouteDate(todayInBusinessTimezone(null));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Every day-navigation change drives the same GET /api/schedule fetch
  // the rest of the app already uses — a single-day range, no new endpoint.
  useEffect(() => {
    if (routeDate) setScheduleRange(routeDate, routeDate);
  }, [routeDate]); // eslint-disable-line react-hooks/exhaustive-deps

  const orderedStops = useMemo(() => numberStops(orderStops(scheduleJobs)), [scheduleJobs]);
  const stopJobs = useMemo(() => orderedStops.map((s) => s.job), [orderedStops]);
  const { markers, nonGeocoded } = useMemo(() => partitionMapJobs(stopJobs), [stopJobs]);
  const summary = nonGeocodedSummary(nonGeocoded.length);
  const stopNumberByJobId = useMemo(() => {
    const m = new Map<number, number>();
    for (const s of orderedStops) m.set(s.job.id, s.stopNumber);
    return m;
  }, [orderedStops]);

  // ── Maps config + script load (mirrors schedule-map.tsx exactly) ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await api<{ enabled: boolean; browserApiKey: string | null }>("GET", "/api/config/maps");
        if (cancelled) return;
        if (!cfg.enabled || !cfg.browserApiKey) { setConfigState("unconfigured"); return; }
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

  useEffect(() => {
    if (!mapsReady || !mapContainerRef.current || mapRef.current) return;
    mapRef.current = new google.maps.Map(mapContainerRef.current, {
      center: { lat: 0, lng: 0 }, zoom: 2, mapTypeControl: false, streetViewControl: false,
      fullscreenControl: false, gestureHandling: "greedy",
    });
    infoWindowRef.current = new google.maps.InfoWindow();
  }, [mapsReady]);

  // Numbered markers — the stop number (not a generic pin) is the whole
  // point of a route view; NOT an optimized/travel-path line (Section 11
  // — no Routes API, no drawn path, deliberately just ordered markers).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const marker of markersRef.current.values()) marker.setMap(null);
    markersRef.current.clear();
    for (const m of markers) {
      const stopNumber = stopNumberByJobId.get(m.job.id);
      const marker = new google.maps.Marker({
        position: { lat: m.lat, lng: m.lng }, map,
        label: stopNumber ? String(stopNumber) : undefined,
        title: `Stop ${stopNumber ?? "?"} — ${m.job.identifier} (${STATUS_LABELS[m.job.status] || m.job.status})`,
      });
      marker.addListener("click", () => setSelectedJobId(m.job.id));
      markersRef.current.set(m.job.id, marker);
    }
    const view = computeMapView(markers);
    if (view.kind === "point") { map.setCenter({ lat: view.lat, lng: view.lng }); map.setZoom(14); }
    else if (view.kind === "bounds") map.fitBounds({ north: view.north, south: view.south, east: view.east, west: view.west }, 48);
  }, [markers, mapsReady]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (selectedJobId === null) return;
    const map = mapRef.current;
    const marker = markersRef.current.get(selectedJobId);
    const job = markers.find((m) => m.job.id === selectedJobId)?.job;
    if (map && marker && job && infoWindowRef.current) {
      map.setCenter(marker.getPosition() || { lat: 0, lng: 0 });
      infoWindowRef.current.close();
      infoWindowRef.current = new google.maps.InfoWindow({ content: buildStopInfoWindow(job, stopNumberByJobId.get(job.id), navigate) });
      infoWindowRef.current.open({ map, anchor: marker });
    }
    document.getElementById(`tech-route-stop-${selectedJobId}`)?.scrollIntoView({ block: "nearest" });
  }, [selectedJobId]); // eslint-disable-line react-hooks/exhaustive-deps

  const submitOnTheWay = async () => {
    if (!onTheWayTarget) return;
    setOnTheWaySubmitting(true);
    const job = onTheWayTarget;
    try {
      await api("POST", `/api/jobs/${job.id}/on-the-way`, {});
      setOnTheWayResult({ jobId: job.id, text: `Customer notified you're on the way to ${job.identifier}.` });
    } catch {
      setOnTheWayResult({ jobId: job.id, text: `Couldn't send the on-the-way notification for ${job.identifier}.` });
    } finally {
      setOnTheWaySubmitting(false);
      setOnTheWayTarget(null);
    }
  };

  if (!routeDate) return <div class="loading-text">Loading route…</div>;

  return (
    <div class="tech-route-view">
      <div class="tech-route-day-nav">
        <button type="button" class="btn btn-icon" onClick={() => setRouteDate((d) => addDaysToIsoDate(d!, -1))} aria-label="Previous day">
          <ChevronLeft size={16} />
        </button>
        <span class="tech-route-day-label">
          {new Date(routeDate + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}
        </span>
        <button type="button" class="btn btn-icon" onClick={() => setRouteDate((d) => addDaysToIsoDate(d!, 1))} aria-label="Next day">
          <ChevronRight size={16} />
        </button>
        <button type="button" class="btn btn-sm" onClick={() => setRouteDate(todayInBusinessTimezone(businessTimezone))}>Today</button>
      </div>

      <div class="tech-route-travel-control">
        <button type="button" class="btn btn-sm" onClick={loadTravelTimes} disabled={legsLoading || orderedStops.length < 2}>
          <RouteIcon size={13} aria-hidden="true" /> {legsLoading ? "Loading travel times…" : routeLegs ? "Refresh Travel Times" : "Show Travel Times"}
        </button>
        {legsError && <span class="text-muted">{legsError}</span>}
        {routeTotals && (() => {
          const totalText = formatTravelTotal(routeTotals.distance, routeTotals.duration);
          return totalText ? <span class="text-muted">{totalText}</span> : <span class="text-muted">Travel time unavailable for this route.</span>;
        })()}
      </div>

      {summary && <div class="schedule-map-banner"><MapPin size={14} aria-hidden="true" /><span>{summary}</span></div>}
      {onTheWayResult && (
        <div class="schedule-map-banner success">
          <span>{onTheWayResult.text}</span>
          <button type="button" class="btn-icon" aria-label="Dismiss" onClick={() => setOnTheWayResult(null)}>×</button>
        </div>
      )}

      <div class="schedule-map-mobile-toggle">
        <button type="button" class="btn" onClick={() => setMobileShowMap((v) => !v)}>{mobileShowMap ? "Show Stops" : "Show Map"}</button>
      </div>

      <div class="schedule-map-split">
        <div class={`schedule-map-pane schedule-map-pane-map ${mobileShowMap ? "" : "mobile-hidden"}`}>
          {configState === "loading" && <div class="schedule-map-status">Loading map…</div>}
          {configState === "unconfigured" && (
            <div class="schedule-map-status"><MapPin size={20} aria-hidden="true" /><p>Map display isn't configured for this server yet. Your stops are still available in the list.</p></div>
          )}
          {configState === "error" && <div class="schedule-map-status"><p>Couldn't load map settings. Your stops are still available in the list.</p></div>}
          {configState === "ready" && mapsLoadFailed && <div class="schedule-map-status"><p>The map couldn't be loaded. Your stops are still available in the list.</p></div>}
          {configState === "ready" && !mapsLoadFailed && (
            <>
              <div ref={mapContainerRef} class="schedule-map-canvas" role="img" aria-label="Map of today's route" />
              {mapsReady && markers.length === 0 && (
                <div class="schedule-map-empty-overlay"><p>No mapped stops for this day.</p></div>
              )}
            </>
          )}
        </div>

        <div class={`schedule-map-pane schedule-map-list ${mobileShowMap ? "mobile-hidden" : ""}`}>
          {orderedStops.length === 0 ? (
            <div class="tech-empty-state"><p>No jobs scheduled for this day.</p></div>
          ) : (
            <ul class="schedule-map-job-list tech-route-stop-list">
              {orderedStops.map(({ job, stopNumber }, idx) => {
                const isGeocoded = job.geocode_status === "geocoded" && job.latitude != null && job.longitude != null;
                const navUrl = buildNavigationUrl(job.address);
                const nextJob = idx < orderedStops.length - 1 ? orderedStops[idx + 1].job : null;
                const leg = nextJob && routeLegs ? legBetween(routeLegs, job.id, nextJob.id) : undefined;
                return (
                  <Fragment key={job.id}>
                  <li
                    id={`tech-route-stop-${job.id}`}
                    class={`schedule-map-job-row tech-route-stop ${selectedJobId === job.id ? "selected" : ""}`}
                    role="button" tabIndex={0} aria-current={selectedJobId === job.id}
                    onClick={() => isGeocoded && setSelectedJobId(job.id)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && isGeocoded && (e.preventDefault(), setSelectedJobId(job.id))}
                  >
                    <div class="schedule-row-top">
                      <span class="tech-route-stop-number" aria-label={`Stop ${stopNumber}`}>{stopNumber}</span>
                      <span class="identifier">{job.identifier}</span>
                      <span class="schedule-job-status-badge" style={{ background: `${STATUS_COLORS[job.status] || "#6b7280"}22`, color: STATUS_COLORS[job.status] || "#6b7280" }}>
                        {STATUS_ABBR[job.status] || "?"}
                      </span>
                      {!isGeocoded && <span class="text-muted schedule-map-nogeo-tag">Location not mapped</span>}
                    </div>
                    <div class="text-bold">{job.scheduled_time} <span class="text-muted">({job.duration} min)</span></div>
                    <div>{job.customer_name || "—"}</div>
                    {job.address && <div class="text-muted schedule-row-address"><MapPin size={12} /> {job.address}</div>}
                    <div class="tech-route-stop-actions">
                      <button type="button" class="btn btn-sm" onClick={(e) => { e.stopPropagation(); navigate(`/jobs/${job.id}`); }}>Open Job</button>
                      {navUrl && (
                        <a class="btn btn-sm" href={navUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open navigation to ${job.address}`} onClick={(e) => e.stopPropagation()}>
                          <Navigation2 size={13} /> Navigate
                        </a>
                      )}
                      <button type="button" class="btn btn-sm" onClick={(e) => { e.stopPropagation(); setOnTheWayTarget(job); }}>
                        <Truck size={13} /> On The Way
                      </button>
                    </div>
                  </li>
                  {nextJob && routeLegs !== null && (
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

      {onTheWayTarget && (
        <ConfirmDialog
          title="Send On The Way notification?"
          message={`Let the customer know you're on your way for ${onTheWayTarget.identifier}?`}
          confirmLabel="Notify"
          submitting={onTheWaySubmitting}
          onConfirm={submitOnTheWay}
          onClose={() => setOnTheWayTarget(null)}
        />
      )}
    </div>
  );
}

function buildStopInfoWindow(job: Job, stopNumber: number | undefined, onNavigate: (to: string) => void): HTMLElement {
  // DOM construction via textContent only — never innerHTML — matching
  // schedule-map.tsx's own XSS-safe popup-content precedent exactly.
  const container = document.createElement("div");
  container.className = "schedule-map-infowindow";
  const title = document.createElement("div");
  title.className = "schedule-map-infowindow-title";
  title.textContent = `Stop ${stopNumber ?? "?"} — ${job.identifier}`;
  container.appendChild(title);
  const meta = document.createElement("div");
  meta.textContent = `${job.scheduled_time} (${job.duration} min)`;
  container.appendChild(meta);
  const status = document.createElement("div");
  status.textContent = `Status: ${STATUS_LABELS[job.status] || job.status}`;
  container.appendChild(status);
  if (job.address) {
    const address = document.createElement("div");
    address.className = "schedule-map-infowindow-address";
    address.textContent = job.address;
    container.appendChild(address);
  }
  const link = document.createElement("button");
  link.type = "button";
  link.className = "btn btn-sm";
  link.textContent = "Open Job";
  link.addEventListener("click", () => onNavigate(`/jobs/${job.id}`));
  container.appendChild(link);
  return container;
}
