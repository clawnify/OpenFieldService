import { beforeEach, describe, expect, it } from "vitest";
import { mockGoogleGeocodingApi } from "./helpers.js";
import { GeocodingError, NoopGeocodingProvider } from "../src/server/geocoding.js";
import { GoogleGeocodingProvider, buildGeocodingProvider } from "../src/server/google-geocoding.js";

// Phase 10.1 — adapter-level tests. Every test here mocks globalThis.fetch
// (see mockGoogleGeocodingApi in test/helpers.ts) — this file makes ZERO
// real network calls to Google Maps Platform (Section 20's explicit
// requirement), matching the same same-isolate monkey-patch pattern
// test/api.test.ts already uses for Google Calendar/Resend/Twilio.

describe("GoogleGeocodingProvider — adapter", () => {
  it("1. maps a successful Google result to the shared GeocodeResult contract", async () => {
    const mock = mockGoogleGeocodingApi({ lat: 49.28, lng: -123.12, formattedAddress: "1 Main St, Vancouver, BC, Canada", placeId: "abc123" });
    try {
      const provider = new GoogleGeocodingProvider("test-key");
      const result = await provider.geocode({ address: "1 Main St, Vancouver, BC" });
      expect(result).toEqual({
        status: "ok", latitude: 49.28, longitude: -123.12,
        formattedAddress: "1 Main St, Vancouver, BC, Canada", providerReference: "abc123",
      });
    } finally {
      mock.restore();
    }
  });

  it("2. ZERO_RESULTS maps to not_found, not an exception", async () => {
    const mock = mockGoogleGeocodingApi({ status: "ZERO_RESULTS" });
    try {
      const provider = new GoogleGeocodingProvider("test-key");
      const result = await provider.geocode({ address: "an address that doesn't exist" });
      expect(result).toEqual({ status: "not_found" });
    } finally {
      mock.restore();
    }
  });

  it("3. a malformed (non-JSON) response maps to INVALID_RESPONSE, never propagates the raw body", async () => {
    const mock = mockGoogleGeocodingApi({ malformed: true });
    try {
      const provider = new GoogleGeocodingProvider("test-key");
      await expect(provider.geocode({ address: "1 Main St" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    } finally {
      mock.restore();
    }
  });

  it("4. an OK status with an invalid/out-of-range coordinate is rejected (defense in depth), never trusted from Google alone", async () => {
    const mock = mockGoogleGeocodingApi({ invalidCoordinate: true });
    try {
      const provider = new GoogleGeocodingProvider("test-key");
      await expect(provider.geocode({ address: "1 Main St" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    } finally {
      mock.restore();
    }
  });

  it("5. a 4xx HTTP response (non-auth) maps to INVALID_RESPONSE", async () => {
    const mock = mockGoogleGeocodingApi({ httpStatus: 400 });
    try {
      const provider = new GoogleGeocodingProvider("test-key");
      await expect(provider.geocode({ address: "1 Main St" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    } finally {
      mock.restore();
    }
  });

  it("5b. a 401/403 HTTP response maps to PROVIDER_AUTH_ERROR", async () => {
    const mock = mockGoogleGeocodingApi({ httpStatus: 403 });
    try {
      const provider = new GoogleGeocodingProvider("test-key");
      await expect(provider.geocode({ address: "1 Main St" })).rejects.toMatchObject({ code: "PROVIDER_AUTH_ERROR" });
    } finally {
      mock.restore();
    }
  });

  it("6. a 5xx HTTP response maps to PROVIDER_UNAVAILABLE", async () => {
    const mock = mockGoogleGeocodingApi({ httpStatus: 503 });
    try {
      const provider = new GoogleGeocodingProvider("test-key");
      await expect(provider.geocode({ address: "1 Main St" })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    } finally {
      mock.restore();
    }
  });

  it("7. a slow response past the configured timeout maps to TIMEOUT, not a hang", async () => {
    const mock = mockGoogleGeocodingApi({ delayMs: 500 });
    try {
      const provider = new GoogleGeocodingProvider("test-key", 50); // 50ms timeout, deliberately shorter than the 500ms mock delay
      await expect(provider.geocode({ address: "1 Main St" })).rejects.toMatchObject({ code: "TIMEOUT" });
    } finally {
      mock.restore();
    }
  });

  it("8. OVER_QUERY_LIMIT maps to RATE_LIMITED", async () => {
    const mock = mockGoogleGeocodingApi({ status: "OVER_QUERY_LIMIT" });
    try {
      const provider = new GoogleGeocodingProvider("test-key");
      await expect(provider.geocode({ address: "1 Main St" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    } finally {
      mock.restore();
    }
  });

  it("9. REQUEST_DENIED (bad key / API not enabled) maps to PROVIDER_AUTH_ERROR", async () => {
    const mock = mockGoogleGeocodingApi({ status: "REQUEST_DENIED" });
    try {
      const provider = new GoogleGeocodingProvider("test-key");
      await expect(provider.geocode({ address: "1 Main St" })).rejects.toMatchObject({ code: "PROVIDER_AUTH_ERROR" });
    } finally {
      mock.restore();
    }
  });

  it("10. the API key never appears in a thrown error's message, on any failure path", async () => {
    const mock = mockGoogleGeocodingApi({ httpStatus: 500 });
    try {
      const provider = new GoogleGeocodingProvider("super-secret-real-looking-key-98765");
      let caught: unknown;
      try {
        await provider.geocode({ address: "1 Main St" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(GeocodingError);
      expect((caught as GeocodingError).message).not.toContain("super-secret-real-looking-key-98765");
      expect((caught as GeocodingError).message).not.toContain("key=");
    } finally {
      mock.restore();
    }
  });

  it("11. the raw provider response body never appears in a thrown error's message", async () => {
    const mock = mockGoogleGeocodingApi({ httpStatus: 500 });
    try {
      const provider = new GoogleGeocodingProvider("test-key");
      let caught: unknown;
      try {
        await provider.geocode({ address: "1 Main St" });
      } catch (err) {
        caught = err;
      }
      expect((caught as GeocodingError).message).not.toContain("mocked http failure");
    } finally {
      mock.restore();
    }
  });

  it("12. the service address is properly URL-encoded, including &, #, and unicode characters", async () => {
    const mock = mockGoogleGeocodingApi();
    try {
      const provider = new GoogleGeocodingProvider("test-key");
      await provider.geocode({ address: "1 Main St & 2nd Ave #400, Montréal" });
      expect(mock.state.calls).toHaveLength(1);
      const requestedUrl = new URL(mock.state.calls[0].url);
      expect(requestedUrl.searchParams.get("address")).toBe("1 Main St & 2nd Ave #400, Montréal");
    } finally {
      mock.restore();
    }
  });

  it("applies a soft region bias (region=ca) on every request", async () => {
    const mock = mockGoogleGeocodingApi();
    try {
      const provider = new GoogleGeocodingProvider("test-key");
      await provider.geocode({ address: "1 Main St" });
      const requestedUrl = new URL(mock.state.calls[0].url);
      expect(requestedUrl.searchParams.get("region")).toBe("ca");
    } finally {
      mock.restore();
    }
  });

  it("a genuine network failure (fetch throws) maps to PROVIDER_UNAVAILABLE", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { throw new TypeError("network down"); }) as typeof fetch;
    try {
      const provider = new GoogleGeocodingProvider("test-key");
      await expect(provider.geocode({ address: "1 Main St" })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("buildGeocodingProvider() — configuration selection (Section 23)", () => {
  beforeEach(() => {
    // Every case here constructs its own env object — nothing reads real
    // process env or .dev.vars, so this suite can never accidentally pick
    // up a real local key.
  });

  it("provider=none (or unset) selects NoopGeocodingProvider — zero external calls", async () => {
    const mock = mockGoogleGeocodingApi();
    try {
      const provider = buildGeocodingProvider({});
      expect(provider).toBeInstanceOf(NoopGeocodingProvider);
      const result = await provider.geocode({ address: "1 Main St" });
      expect(result).toEqual({ status: "not_found" });
      expect(mock.state.calls).toHaveLength(0);
    } finally {
      mock.restore();
    }
  });

  it("provider=google with no key configured fails safely, with zero external calls and no key to leak", async () => {
    const mock = mockGoogleGeocodingApi();
    try {
      const provider = buildGeocodingProvider({ GEOCODING_PROVIDER: "google" });
      await expect(provider.geocode({ address: "1 Main St" })).rejects.toMatchObject({ code: "PROVIDER_AUTH_ERROR" });
      expect(mock.state.calls).toHaveLength(0);
    } finally {
      mock.restore();
    }
  });

  it("provider=google with a (mocked, never real) key selects the real Google adapter", async () => {
    const mock = mockGoogleGeocodingApi({ lat: 49.1, lng: -123.1 });
    try {
      const provider = buildGeocodingProvider({ GEOCODING_PROVIDER: "google", GOOGLE_MAPS_API_KEY: "mock-test-key-never-real" });
      expect(provider).toBeInstanceOf(GoogleGeocodingProvider);
      const result = await provider.geocode({ address: "1 Main St" });
      expect(result).toEqual({ status: "ok", latitude: 49.1, longitude: -123.1, formattedAddress: expect.any(String), providerReference: expect.any(String) });
      expect(mock.state.calls).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });
});
