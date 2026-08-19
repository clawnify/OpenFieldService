import { describe, expect, it } from "vitest";
import { scalePointerPosition } from "../src/client/signature-geometry.js";

// Focused regression test for the mobile signature-pad coordinate bug found
// while fixing mem:backlog/p1-technician-completion-compliance's mobile-layout
// finding: the canvas has a fixed 400x160 internal buffer but is stretched to
// 100% of its container by CSS, so on any viewport narrower than 400px (every
// phone) a raw client-vs-rect pointer offset no longer matches buffer space —
// the drawn stroke silently drifted from the actual touch point. There is no
// DOM/browser test environment in this project (vitest runs under
// @cloudflare/vitest-pool-workers, not jsdom), so this exercises the extracted
// pure math directly rather than a rendered canvas — see
// src/client/signature-geometry.ts for why it was pulled out of the component.

describe("scalePointerPosition", () => {
  it("passes through 1:1 when the rendered size exactly matches the canvas buffer (desktop case)", () => {
    const rect = { left: 100, top: 50, width: 400, height: 160 };
    const canvas = { width: 400, height: 160 };
    expect(scalePointerPosition(150, 90, rect, canvas)).toEqual({ x: 50, y: 40 });
  });

  it("scales up when the canvas is rendered narrower than its buffer (phone case)", () => {
    // A phone-width modal stretches the 400x160 buffer down to a 280px-wide
    // rendered canvas — a touch at the rendered midpoint (140px in) must map
    // to the buffer's midpoint (200px), not stay at 140.
    const rect = { left: 20, top: 300, width: 280, height: 160 };
    const canvas = { width: 400, height: 160 };
    const pos = scalePointerPosition(160, 380, rect, canvas);
    expect(pos.x).toBeCloseTo(200, 5); // (160-20) * (400/280) = 200
    expect(pos.y).toBeCloseTo(80, 5); // (380-300) * (160/160) = 80 — height wasn't stretched here
  });

  it("scales both axes independently when width and height stretch by different ratios", () => {
    const rect = { left: 0, top: 0, width: 200, height: 200 };
    const canvas = { width: 400, height: 160 };
    // x buffer is stretched 2x relative to render (400/200), y is squashed 0.8x (160/200)
    expect(scalePointerPosition(100, 100, rect, canvas)).toEqual({ x: 200, y: 80 });
  });

  it("accounts for the canvas's offset position on the page, not just its size", () => {
    const rect = { left: 50, top: 25, width: 400, height: 160 };
    const canvas = { width: 400, height: 160 };
    // A click exactly at the canvas's top-left corner must map to buffer (0,0)
    expect(scalePointerPosition(50, 25, rect, canvas)).toEqual({ x: 0, y: 0 });
  });
});
