import { describe, expect, it } from "vitest";
import { buildNavigationUrl, buildTelUrl, buildSmsUrl } from "../src/client/navigation.js";

describe("buildNavigationUrl", () => {
  it("builds a Google Maps directions URL for a real address", () => {
    const url = buildNavigationUrl("123 Main St, Burnaby, BC");
    expect(url).toBe("https://www.google.com/maps/dir/?api=1&destination=123%20Main%20St%2C%20Burnaby%2C%20BC");
  });

  it("returns null for a blank address", () => {
    expect(buildNavigationUrl("")).toBeNull();
    expect(buildNavigationUrl("   ")).toBeNull();
  });

  it("trims surrounding whitespace before encoding", () => {
    expect(buildNavigationUrl("  100 Main St  ")).toBe("https://www.google.com/maps/dir/?api=1&destination=100%20Main%20St");
  });
});

describe("buildTelUrl", () => {
  it("normalizes a formatted phone number to digits only", () => {
    expect(buildTelUrl("(604) 555-1234")).toBe("tel:6045551234");
  });

  it("preserves a leading + for international numbers", () => {
    expect(buildTelUrl("+1 604-555-1234")).toBe("tel:+16045551234");
  });

  it("returns null for a blank phone number", () => {
    expect(buildTelUrl("")).toBeNull();
    expect(buildTelUrl("   ")).toBeNull();
  });

  it("returns null when nothing but non-digit characters remain", () => {
    expect(buildTelUrl("---")).toBeNull();
  });
});

describe("buildSmsUrl", () => {
  it("normalizes a formatted phone number to digits only", () => {
    expect(buildSmsUrl("(604) 555-1234")).toBe("sms:6045551234");
  });

  it("returns null for a blank phone number", () => {
    expect(buildSmsUrl("")).toBeNull();
  });
});
