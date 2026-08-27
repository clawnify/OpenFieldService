#!/usr/bin/env node
// Phase 19A — a committed, reusable Playwright regression check for the
// shared ConfirmDialog component (src/client/components/confirm-dialog.tsx),
// used at ~26 call sites app-wide. Unlike this phase's other fixes (pure
// additive id/aria-label markup), ConfirmDialog carries real stateful
// behavior — a keydown listener, imperative focus management, a Tab focus
// trap — so a markup diff review alone can't catch a regression here.
//
// This is NOT wired into `pnpm test` / CI: it needs a live app server
// (`pnpm run dev`) and an authenticated session, and this repo has no
// existing E2E-server-lifecycle harness to build one on top of (unlike the
// vitest-pool-workers suite, which gets a fresh isolated D1 per test). Per
// CLAUDE.md's Dependency Rules ("do not add unnecessary infrastructure"),
// building a full CI-integrated E2E pipeline for one component was judged
// disproportionate — this script is the documented, reproducible middle
// ground: a real interactive check any future phase can re-run by hand
// (or eventually wire into CI once a genuine webServer harness exists).
//
// Usage (with `pnpm run dev` already running):
//   FS_BASE_URL=http://localhost:5180 FS_EMAIL=<admin-email> FS_PASSWORD=<password> \
//     node test/e2e/confirm-dialog-check.mjs
// Point FS_EMAIL/FS_PASSWORD at any admin account already seeded in your
// local dev D1 (this script only ever posts credentials directly to your
// own local server's /api/auth/login — never enters them into a browser
// field — and only opens/cancels a delete dialog; it never confirms a
// deletion).
import { chromium } from "@playwright/test";

const BASE = process.env.FS_BASE_URL || "http://localhost:5180";
const EMAIL = process.env.FS_EMAIL;
const PASSWORD = process.env.FS_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error("Set FS_EMAIL and FS_PASSWORD (a local dev admin account) before running this script.");
  console.error("See the header comment in this file for details.");
  process.exit(1);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!loginRes.ok) {
  console.error(`Login failed: ${loginRes.status} ${await loginRes.text()}`);
  process.exit(1);
}
const cookie = loginRes.headers.get("set-cookie").split(";")[0].split("=")[1];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
await context.addCookies([{ name: "fs_session", value: cookie, domain: new URL(BASE).hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
const page = await context.newPage();

await page.goto(`${BASE}/customers`, { waitUntil: "networkidle" });
const firstCustomerLink = page.locator(".table-row, .customer-row, a[href^='/customers/']").first();
if (!(await firstCustomerLink.count())) {
  console.error("No customers found to test against — create at least one customer first.");
  await browser.close();
  process.exit(1);
}
await firstCustomerLink.click();
await page.waitForLoadState("networkidle");

const deleteBtn = page.locator("button", { hasText: "Delete" }).first();
await deleteBtn.click();
await page.waitForTimeout(300);

const dialog = page.locator('[role="dialog"]');
check("dialog has role=dialog and aria-modal", await dialog.getAttribute("aria-modal") === "true");
const box = await dialog.boundingBox();
check("dialog fits the 390px viewport", box && box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
check("focus lands on Close button on open", (await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))) === "Close");

await page.keyboard.press("Tab");
const afterTab1 = await page.evaluate(() => document.activeElement?.textContent?.trim());
await page.keyboard.press("Tab");
const afterTab2 = await page.evaluate(() => document.activeElement?.textContent?.trim());
await page.keyboard.press("Tab");
const wrapped = (await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))) === "Close";
check("Tab cycles Close -> Cancel -> Delete -> wraps to Close (focus trap)", wrapped, `Cancel="${afterTab1}" Delete="${afterTab2}"`);

await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check("Escape closes the dialog", !(await dialog.isVisible().catch(() => false)));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
