import { describe, expect, it } from "vitest";
import { mockGoogleRoutesApi } from "./helpers.js";
import { GeocodingError, NoopRoutingProvider } from "../src/server/geocoding.js";
import { GoogleRoutingProvider, buildRoutingProvider, MAX_INTERMEDIATE_WAYPOINTS } from "../src/server/google-routing.js";

// Phase 10.4 — adapter-level tests. Every test here mocks globalThis.fetch
// (see mockGoogleRoutesApi in test/helpers.ts) — this file makes ZERO real
// network calls to the Google Routes API, same discipline as
// test/google-geocoding.test.ts.

const ORIGIN = { latitude: 49.28, longitude: -123.12 };
const DEST = { latitude: 49.25, longitude: -123.0 };
const MID = { latitude: 49.26, longitude: -123.05 };

describe("GoogleRoutingProvider — adapter", () => {
  it("1. maps a successful single-leg route to the shared RouteResult contract", async () => {
    const mock = mockGoogleRoutesApi({ legDistances: [12400], legDurations: [1080], polyline: "abc123" });
    try {
      const provider = new GoogleRoutingProvider("test-key");
      const result = await provider.route({ origin: ORIGIN, destination: DEST });
      expect(result).toEqual({
        distanceMeters: 12400, durationSeconds: 1080,
        legs: [{ distanceMeters: 12400, durationSeconds: 1080 }],
        geometry: "abc123",
      });
    } finally {
      mock.restore();
    }
  });

  it("2. a multi-waypoint route returns one leg per origin/waypoint/destination pair, in order", async () => {
    const mock = mockGoogleRoutesApi({ legDistances: [1000, 2000], legDurations: [60, 120] });
    try {
      const provider = new GoogleRoutingProvider("test-key");
      const result = await provider.route({ origin: ORIGIN, destination: DEST, waypoints: [MID] });
      expect(result.legs).toEqual([
        { distanceMeters: 1000, durationSeconds: 60 },
        { distanceMeters: 2000, durationSeconds: 120 },
      ]);
      expect(result.distanceMeters).toBe(3000);
      expect(result.durationSeconds).toBe(180);
    } finally {
      mock.restore();
    }
  });

  it("3. distance/duration parsing: Google's duration string format ('165s') is parsed to a plain number of seconds", async () => {
    const mock = mockGoogleRoutesApi({ legDurations: [165] });
    try {
      const provider = new GoogleRoutingProvider("test-key");
      const result = await provider.route({ origin: ORIGIN, destination: DEST });
      expect(result.durationSeconds).toBe(165);
      expect(typeof result.durationSeconds).toBe("number");
    } finally {
      mock.restore();
    }
  });

  it("4. polyline extraction: encodedPolyline surfaces as RouteResult.geometry, untyped/opaque", async () => {
    const mock = mockGoogleRoutesApi({ polyline: "ipkcFfichVnP@j@BLoFVwM{E?" });
    try {
      const provider = new GoogleRoutingProvider("test-key");
      const result = await provider.route({ origin: ORIGIN, destination: DEST });
      expect(result.geometry).toBe("ipkcFfichVnP@j@BLoFVwM{E?");
    } finally {
      mock.restore();
    }
  });

  it("5. no-route (routes: []) maps to NO_ROUTE, never a fabricated result", async () => {
    const mock = mockGoogleRoutesApi({ noRoute: true });
    try {
      const provider = new GoogleRoutingProvider("test-key");
      await expect(provider.route({ origin: ORIGIN, destination: DEST })).rejects.toMatchObject({ code: "NO_ROUTE" });
    } finally {
      mock.restore();
    }
  });

  it("6. a malformed (non-JSON) response maps to INVALID_RESPONSE", async () => {
    const mock = mockGoogleRoutesApi({ malformed: true });
    try {
      const provider = new GoogleRoutingProvider("test-key");
      await expect(provider.route({ origin: ORIGIN, destination: DEST })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    } finally {
      mock.restore();
    }
  });

  it("7. a leg-count mismatch (omitted legs array) maps to INVALID_RESPONSE, defense in depth", async () => {
    const mock = mockGoogleRoutesApi({ omitLegs: true });
    try {
      const provider = new GoogleRoutingProvider("test-key");
      await expect(provider.route({ origin: ORIGIN, destination: DEST })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    } finally {
      mock.restore();
    }
  });

  it("8. HTTP timeout maps to TIMEOUT, never hangs past the configured bound", async () => {
    const mock = mockGoogleRoutesApi({ delayMs: 50 });
    try {
      const provider = new GoogleRoutingProvider("test-key", 10);
      await expect(provider.route({ origin: ORIGIN, destination: DEST })).rejects.toMatchObject({ code: "TIMEOUT" });
    } finally {
      mock.restore();
    }
  });

  it("9. HTTP 401/403 (or PERMISSION_DENIED/UNAUTHENTICATED status) maps to PROVIDER_AUTH_ERROR", async () => {
    const mock = mockGoogleRoutesApi({ httpStatus: 403, googleErrorStatus: "PERMISSION_DENIED" });
    try {
      const provider = new GoogleRoutingProvider("test-key");
      await expect(provider.route({ origin: ORIGIN, destination: DEST })).rejects.toMatchObject({ code: "PROVIDER_AUTH_ERROR" });
    } finally {
      mock.restore();
    }
  });

  it("10. HTTP 429 (or RESOURCE_EXHAUSTED status) maps to RATE_LIMITED", async () => {
    const mock = mockGoogleRoutesApi({ httpStatus: 429, googleErrorStatus: "RESOURCE_EXHAUSTED" });
    try {
      const provider = new GoogleRoutingProvider("test-key");
      await expect(provider.route({ origin: ORIGIN, destination: DEST })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    } finally {
      mock.restore();
    }
  });

  it("11. HTTP 400 (or INVALID_ARGUMENT status) maps to INVALID_ROUTE_INPUT", async () => {
    const mock = mockGoogleRoutesApi({ httpStatus: 400, googleErrorStatus: "INVALID_ARGUMENT" });
    try {
      const provider = new GoogleRoutingProvider("test-key");
      await expect(provider.route({ origin: ORIGIN, destination: DEST })).rejects.toMatchObject({ code: "INVALID_ROUTE_INPUT" });
    } finally {
      mock.restore();
    }
  });

  it("12. HTTP 5xx (or UNAVAILABLE status) maps to PROVIDER_UNAVAILABLE", async () => {
    const mock = mockGoogleRoutesApi({ httpStatus: 503, googleErrorStatus: "UNAVAILABLE" });
    try {
      const provider = new GoogleRoutingProvider("test-key");
      await expect(provider.route({ origin: ORIGIN, destination: DEST })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    } finally {
      mock.restore();
    }
  });

  it("13. a network-level fetch failure maps to PROVIDER_UNAVAILABLE, never leaks the raw error", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { throw new TypeError("network down"); }) as typeof fetch;
    try {
      const provider = new GoogleRoutingProvider("test-key");
      await expect(provider.route({ origin: ORIGIN, destination: DEST })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("14. invalid input: more than MAX_INTERMEDIATE_WAYPOINTS waypoints is rejected before any network call", async () => {
    const mock = mockGoogleRoutesApi();
    try {
      const provider = new GoogleRoutingProvider("test-key");
      const tooMany = Array.from({ length: MAX_INTERMEDIATE_WAYPOINTS + 1 }, () => MID);
      await expect(provider.route({ origin: ORIGIN, destination: DEST, waypoints: tooMany })).rejects.toMatchObject({ code: "INVALID_ROUTE_INPUT" });
      expect(mock.state.calls).toHaveLength(0);
    } finally {
      mock.restore();
    }
  });

  it("15. field mask: the request always carries X-Goog-FieldMask and X-Goog-Api-Key headers, never the key in the URL", async () => {
    const mock = mockGoogleRoutesApi();
    try {
      const provider = new GoogleRoutingProvider("super-secret-key");
      await provider.route({ origin: ORIGIN, destination: DEST });
      expect(mock.state.calls).toHaveLength(1);
      const call = mock.state.calls[0];
      expect(call.headers["X-Goog-FieldMask"]).toContain("routes.distanceMeters");
      expect(call.headers["X-Goog-Api-Key"]).toBe("super-secret-key");
      expect(call.url).not.toContain("super-secret-key");
    } finally {
      mock.restore();
    }
  });

  it("16. waypoint order preserved: intermediates are sent in the exact input order, never reordered", async () => {
    const mock = mockGoogleRoutesApi();
    try {
      const provider = new GoogleRoutingProvider("test-key");
      const wp1 = { latitude: 1, longitude: 1 };
      const wp2 = { latitude: 2, longitude: 2 };
      await provider.route({ origin: ORIGIN, destination: DEST, waypoints: [wp1, wp2] });
      const body = mock.state.calls[0].body as { intermediates: { location: { latLng: { latitude: number } } }[] };
      expect(body.intermediates.map((w) => w.location.latLng.latitude)).toEqual([1, 2]);
    } finally {
      mock.restore();
    }
  });

  it("17. optimization disabled: optimizeWaypointOrder is always hard-coded false, never true or caller-controlled", async () => {
    const mock = mockGoogleRoutesApi();
    try {
      const provider = new GoogleRoutingProvider("test-key");
      await provider.route({ origin: ORIGIN, destination: DEST, waypoints: [MID] });
      const body = mock.state.calls[0].body as { optimizeWaypointOrder: boolean; travelMode: string; routingPreference: string };
      expect(body.optimizeWaypointOrder).toBe(false);
      expect(body.travelMode).toBe("DRIVE");
      expect(body.routingPreference).toBe("TRAFFIC_UNAWARE");
    } finally {
      mock.restore();
    }
  });

  it("18. secret absent from errors: a thrown GeocodingError's message never contains the API key", async () => {
    const mock = mockGoogleRoutesApi({ httpStatus: 500 });
    try {
      const provider = new GoogleRoutingProvider("super-secret-key-xyz");
      try {
        await provider.route({ origin: ORIGIN, destination: DEST });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(GeocodingError);
        expect((err as GeocodingError).message).not.toContain("super-secret-key-xyz");
        expect((err as GeocodingError).code).toBe("PROVIDER_UNAVAILABLE");
      }
    } finally {
      mock.restore();
    }
  });
});

describe("buildRoutingProvider — config selection", () => {
  it("19. ROUTING_PROVIDER unset/other -> NoopRoutingProvider (always throws PROVIDER_UNAVAILABLE, never fabricates a route)", async () => {
    const provider = buildRoutingProvider({});
    expect(provider).toBeInstanceOf(NoopRoutingProvider);
    await expect(provider.route({ origin: ORIGIN, destination: DEST })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("20. ROUTING_PROVIDER=google with no key -> a safely-failing provider (PROVIDER_AUTH_ERROR), never a crash", async () => {
    const provider = buildRoutingProvider({ ROUTING_PROVIDER: "google" });
    expect(provider).not.toBeInstanceOf(NoopRoutingProvider);
    await expect(provider.route({ origin: ORIGIN, destination: DEST })).rejects.toMatchObject({ code: "PROVIDER_AUTH_ERROR" });
  });

  it("21. ROUTING_PROVIDER=google with a key -> GoogleRoutingProvider", () => {
    const provider = buildRoutingProvider({ ROUTING_PROVIDER: "google", GOOGLE_ROUTES_API_KEY: "test-only-mock-key" });
    expect(provider).toBeInstanceOf(GoogleRoutingProvider);
  });
});
