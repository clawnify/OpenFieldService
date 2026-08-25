import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  authHeaders, createSecondOrganization, createUser, loginAs, put, request, requestRaw,
  resetDatabase, applySchema,
} from "./helpers.js";

// A real, valid 1x1 PNG (same fixture already used by test/helpers.ts's
// satisfyCompletionRequirements for job-signature uploads) — needed here
// too, since setCompanyLogo() actually validates content-type/size and
// downstream PDF rendering actually calls pdf-lib's embedPng() on it.
const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
function tinyPngFile(name = "logo.png"): File {
  const bytes = Uint8Array.from(atob(TINY_PNG_BASE64), (ch) => ch.charCodeAt(0));
  return new File([bytes], name, { type: "image/png" });
}

// Phase 13A hardening — Company Profile: tenant business identity used by
// the Contract PDF (contract-pdf.ts). Covers CRUD, RBAC (admin-only both
// directions), tenant isolation, and validation. The critical Contract-PDF
// snapshot-immutability acceptance test (Section 22 — an already-signed
// Contract's PDF must not change after a later profile edit) lives in
// test/contracts.test.ts alongside the rest of the Signed Document Access
// suite, not here.

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

describe("company profile", () => {
  it("returns a well-formed, all-empty profile before anything has been saved", async () => {
    const auth = await authHeaders();
    const res = await request<{ profile: Record<string, unknown> }>("/api/company-profile", auth);
    expect(res.response.status).toBe(200);
    expect(res.body.profile).toMatchObject({ company_name: "", legal_name: "", phone: "" });
  });

  it("lets an admin save and read back a full profile", async () => {
    const auth = await authHeaders();
    const saved = await put<{ profile: Record<string, unknown> }>("/api/company-profile", {
      company_name: "Coreline Comfort",
      legal_name: "Coreline Comfort Ltd.",
      phone: "604-555-0100",
      email: "office@corelinecomfort.test",
      website: "https://corelinecomfort.test",
      address_line1: "123 Main St",
      city: "Vancouver",
      state: "BC",
      postal_code: "V1V 1V1",
      country: "Canada",
      business_number: "123456789BC0001",
      tax_number: "123456789RT0001",
      contract_footer: "Thank you for your business.",
    }, auth);
    expect(saved.response.status).toBe(200);
    expect(saved.body.profile).toMatchObject({ company_name: "Coreline Comfort", legal_name: "Coreline Comfort Ltd." });

    const read = await request<{ profile: Record<string, unknown> }>("/api/company-profile", auth);
    expect(read.body.profile).toMatchObject({ company_name: "Coreline Comfort", tax_number: "123456789RT0001" });
  });

  it("a partial update only overwrites the fields provided, leaving the rest intact", async () => {
    const auth = await authHeaders();
    await put("/api/company-profile", { company_name: "Coreline Comfort", phone: "604-555-0100" }, auth);
    const partial = await put<{ profile: Record<string, unknown> }>("/api/company-profile", { phone: "604-555-9999" }, auth);
    expect(partial.body.profile).toMatchObject({ company_name: "Coreline Comfort", phone: "604-555-9999" });
  });

  it("rejects a non-admin from reading or updating the company profile", async () => {
    await createUser({ email: "dispatch@example.test", password: "DispatchPass1", role: "dispatcher" });
    const { cookie } = await loginAs("dispatch@example.test", "DispatchPass1");

    const read = await request("/api/company-profile", { headers: { cookie } });
    expect(read.response.status).toBe(403);

    const write = await put("/api/company-profile", { company_name: "Should Not Save" }, { headers: { cookie } });
    expect(write.response.status).toBe(403);
  });

  it("rejects an obviously malformed email or website", async () => {
    const auth = await authHeaders();
    const badEmail = await put<{ error: string }>("/api/company-profile", { email: "not-an-email" }, auth);
    expect(badEmail.response.status).toBe(400);

    const badWebsite = await put<{ error: string }>("/api/company-profile", { website: "not a url" }, auth);
    expect(badWebsite.response.status).toBe(400);
  });

  it("accepts an empty string for email/website (clears the field, does not run it through the format regex)", async () => {
    const auth = await authHeaders();
    await put("/api/company-profile", { email: "office@example.test", website: "https://example.test" }, auth);
    const cleared = await put<{ profile: Record<string, unknown> }>("/api/company-profile", { email: "", website: "" }, auth);
    expect(cleared.response.status).toBe(200);
    expect(cleared.body.profile).toMatchObject({ email: "", website: "" });
  });

  it("enforces length caps on short fields (200 chars) and the contract footer (2000 chars)", async () => {
    const auth = await authHeaders();
    const okShort = await put("/api/company-profile", { company_name: "A".repeat(200) }, auth);
    expect(okShort.response.status).toBe(200);
    const tooLongShort = await put<{ error: string }>("/api/company-profile", { company_name: "A".repeat(201) }, auth);
    expect(tooLongShort.response.status).toBe(400);

    const okFooter = await put("/api/company-profile", { contract_footer: "B".repeat(2000) }, auth);
    expect(okFooter.response.status).toBe(200);
    const tooLongFooter = await put<{ error: string }>("/api/company-profile", { contract_footer: "B".repeat(2001) }, auth);
    expect(tooLongFooter.response.status).toBe(400);
  });

  it("never leaks or overwrites another organization's profile (tenant isolation / IDOR)", async () => {
    const orgA = await authHeaders();
    await put("/api/company-profile", { company_name: "Org A Co" }, orgA);

    const second = await createSecondOrganization("Org B");
    const { cookie } = await loginAs(second.email, second.password);
    const orgB = { headers: { cookie } };

    // Org B reads its own (empty) profile, never Org A's.
    const readB = await request<{ profile: Record<string, unknown> }>("/api/company-profile", orgB);
    expect(readB.body.profile.company_name).toBe("");

    // Org B writes its own profile.
    await put("/api/company-profile", { company_name: "Org B Co" }, orgB);

    // Org A's profile is unaffected by Org B's write.
    const readA = await request<{ profile: Record<string, unknown> }>("/api/company-profile", orgA);
    expect(readA.body.profile.company_name).toBe("Org A Co");
  });
});

describe("company logo (Phase 13A final document hardening)", () => {
  function cookieOf(auth: RequestInit): string {
    return (auth.headers as Record<string, string>).cookie;
  }

  it("lets an admin upload, preview, and remove a logo", async () => {
    const auth = await authHeaders();
    const form = new FormData();
    form.append("file", tinyPngFile());
    const upload = await request<{ profile: Record<string, unknown> }>("/api/company-profile/logo", { method: "POST", headers: { cookie: cookieOf(auth) }, body: form });
    expect(upload.response.status).toBe(200);
    expect(upload.body.profile.logo_key).not.toBeNull();

    const preview = await requestRaw("/api/company-profile/logo", { headers: { cookie: cookieOf(auth) } });
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("image/png");

    const removed = await request<{ profile: Record<string, unknown> }>("/api/company-profile/logo", { method: "DELETE", headers: { cookie: cookieOf(auth) } });
    expect(removed.response.status).toBe(200);
    expect(removed.body.profile.logo_key).toBeNull();

    const previewAfterRemove = await requestRaw("/api/company-profile/logo", { headers: { cookie: cookieOf(auth) } });
    expect(previewAfterRemove.status).toBe(404);
  });

  it("rejects an unsupported content type (e.g. SVG) and an oversized file", async () => {
    const auth = await authHeaders();
    const svgForm = new FormData();
    svgForm.append("file", new File([new Uint8Array([1, 2, 3])], "logo.svg", { type: "image/svg+xml" }));
    const svgRes = await request<{ error: string }>("/api/company-profile/logo", { method: "POST", headers: { cookie: cookieOf(auth) }, body: svgForm });
    expect(svgRes.response.status).toBe(400);

    const bigForm = new FormData();
    bigForm.append("file", new File([new Uint8Array(2 * 1024 * 1024 + 1)], "logo.png", { type: "image/png" }));
    const bigRes = await request<{ error: string }>("/api/company-profile/logo", { method: "POST", headers: { cookie: cookieOf(auth) }, body: bigForm });
    expect(bigRes.response.status).toBe(400);
  });

  it("rejects a non-admin from uploading, previewing, or removing a logo", async () => {
    await createUser({ email: "dispatch-logo@example.test", password: "DispatchPass1", role: "dispatcher" });
    const { cookie } = await loginAs("dispatch-logo@example.test", "DispatchPass1");
    const form = new FormData();
    form.append("file", tinyPngFile());
    const upload = await request("/api/company-profile/logo", { method: "POST", headers: { cookie }, body: form });
    expect(upload.response.status).toBe(403);
    const preview = await requestRaw("/api/company-profile/logo", { headers: { cookie } });
    expect(preview.status).toBe(403);
    const remove = await request("/api/company-profile/logo", { method: "DELETE", headers: { cookie } });
    expect(remove.response.status).toBe(403);
  });

  it("never leaks one organization's logo to another (tenant isolation)", async () => {
    const orgA = await authHeaders();
    const form = new FormData();
    form.append("file", tinyPngFile());
    await request("/api/company-profile/logo", { method: "POST", headers: { cookie: cookieOf(orgA) }, body: form });

    const second = await createSecondOrganization("Org B Logo Co");
    const { cookie } = await loginAs(second.email, second.password);
    const previewB = await requestRaw("/api/company-profile/logo", { headers: { cookie } });
    expect(previewB.status).toBe(404); // Org B has no logo of its own, never sees Org A's
  });
});
