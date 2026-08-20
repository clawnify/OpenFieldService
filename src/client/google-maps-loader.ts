/**
 * Phase 10.2 — minimal, dependency-free Google Maps JavaScript API loader.
 * No npm package added (verified unnecessary — see Section 28's dependency
 * audit): this is ~50 lines of vanilla browser script injection, the exact
 * amount of code a loader library would wrap anyway. Classic
 * `google.maps.Marker`/`InfoWindow` are used (not the newer
 * AdvancedMarkerElement, which requires a Map ID and a separate "marker"
 * library param) — the smallest coherent integration for read-only pins.
 *
 * Only the handful of Maps JS types this app actually uses are declared
 * below (ambient global augmentation) — not a full @types/google.maps
 * devDependency, per the same "verify necessity" principle.
 */

declare global {
  // Required for TypeScript ambient global augmentation of
  // `window.google.maps` — there is no ES2015-module equivalent for
  // extending an existing global namespace.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace google.maps {
    interface LatLngLiteral { lat: number; lng: number }
    interface LatLngBoundsLiteral { north: number; south: number; east: number; west: number }

    class LatLngBounds {
      constructor(sw?: LatLngLiteral, ne?: LatLngLiteral);
      extend(point: LatLngLiteral): void;
    }

    interface MapOptions {
      center?: LatLngLiteral;
      zoom?: number;
      mapTypeControl?: boolean;
      streetViewControl?: boolean;
      fullscreenControl?: boolean;
      gestureHandling?: string;
      clickableIcons?: boolean;
    }

    class Map {
      constructor(el: HTMLElement, opts?: MapOptions);
      setCenter(pos: LatLngLiteral): void;
      setZoom(zoom: number): void;
      fitBounds(bounds: LatLngBounds | LatLngBoundsLiteral, padding?: number): void;
    }

    interface MarkerOptions {
      position: LatLngLiteral;
      map?: Map | null;
      title?: string;
      label?: string;
    }

    class Marker {
      constructor(opts: MarkerOptions);
      setMap(map: Map | null): void;
      addListener(event: string, handler: () => void): void;
      getPosition(): LatLngLiteral | undefined;
    }

    interface InfoWindowOptions {
      content?: Node | string;
      ariaLabel?: string;
    }

    class InfoWindow {
      constructor(opts?: InfoWindowOptions);
      open(opts: { map?: Map; anchor?: Marker }): void;
      close(): void;
      addListener(event: string, handler: () => void): void;
    }
  }

  interface Window {
    google?: { maps: typeof google.maps };
  }
}

const SCRIPT_ID = "google-maps-js-api";

let loadPromise: Promise<typeof google.maps> | null = null;

/** Injects the Maps JS script exactly once (idempotent across repeated
 *  calls/re-mounts) and resolves with `google.maps` once it's ready.
 *  Never called with the server-side geocoding secret — callers must pass
 *  the browser key obtained from GET /api/config/maps. */
export function loadGoogleMaps(apiKey: string): Promise<typeof google.maps> {
  if (window.google?.maps) return Promise.resolve(window.google.maps);
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID);
    if (existing) {
      existing.addEventListener("load", () => {
        if (window.google?.maps) resolve(window.google.maps);
        else reject(new Error("Google Maps script loaded but google.maps is unavailable"));
      });
      existing.addEventListener("error", () => reject(new Error("Failed to load Google Maps script")));
      return;
    }

    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.async = true;
    script.defer = true;
    // encodeURIComponent, not raw interpolation — defense in depth even
    // though the key comes from our own server config, never user input.
    // Deliberately NOT `&loading=async`: that mode only bootstraps
    // `google.maps.importLibrary()` and leaves `google.maps.Map`/`Marker`/
    // `InfoWindow` undefined until each library is explicitly imported —
    // this loader (and the classic Marker/InfoWindow API this app uses)
    // assumes the full namespace is populated synchronously once the
    // script's `load` event fires, which is exactly what omitting
    // `loading=async` guarantees. (Found live: `loading=async` produced a
    // real "google.maps.Map is not a constructor" runtime error during
    // Phase 10.2 browser verification.)
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}`;
    script.addEventListener("load", () => {
      if (window.google?.maps) resolve(window.google.maps);
      else reject(new Error("Google Maps script loaded but google.maps is unavailable"));
    });
    script.addEventListener("error", () => {
      loadPromise = null; // allow a retry on a later mount, e.g. after a transient network failure
      reject(new Error("Failed to load Google Maps script"));
    });
    document.head.appendChild(script);
  });

  return loadPromise;
}
