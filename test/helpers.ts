import { env, exports as workerExports } from "cloudflare:workers";
import { expect } from "vitest";
import { hashPassword } from "../src/server/auth.js";

export interface JsonResponse<T> {
  response: Response;
  body: T;
}

export async function request<T>(path: string, init?: RequestInit): Promise<JsonResponse<T>> {
  const response = await workerExports.default.fetch(`http://example.test${path}`, init);
  const body = await response.json() as T;
  return { response, body };
}

/** Like request(), but for endpoints that respond with a redirect (no JSON body to parse).
 *  Uses redirect: "manual" so a 3xx response is returned as-is for inspection instead
 *  of being auto-followed (which would otherwise try to actually fetch e.g. accounts.google.com). */
export async function requestRaw(path: string, init: RequestInit = {}): Promise<Response> {
  return workerExports.default.fetch(`http://example.test${path}`, { redirect: "manual", ...init });
}

function withJsonBody(init: RequestInit, body: unknown): RequestInit {
  return {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
    body: JSON.stringify(body),
  };
}

export async function post<T>(path: string, body: unknown, init: RequestInit = {}): Promise<JsonResponse<T>> {
  return request<T>(path, withJsonBody({ ...init, method: "POST" }, body));
}

export async function put<T>(path: string, body: unknown, init: RequestInit = {}): Promise<JsonResponse<T>> {
  return request<T>(path, withJsonBody({ ...init, method: "PUT" }, body));
}

export async function del<T>(path: string, init: RequestInit = {}): Promise<JsonResponse<T>> {
  return request<T>(path, { ...init, method: "DELETE" });
}

export async function createCustomer(name = "Ada Heating") {
  const result = await post<{ id: number; name: string }>("/api/customers", {
    name,
    email: "service@example.test",
    phone: "555-0100",
    address: "100 Main St",
    city: "Burnaby",
    state: "BC",
    zip: "V5A 1A1",
  }, await authHeaders());
  expect(result.response.status).toBe(201);
  return result.body;
}

export async function createJob(customerId: number, scheduledDate: string, overrides: Record<string, unknown> = {}) {
  const result = await post<{ id: number; scheduled_date: string }>("/api/jobs", {
    customer_id: customerId,
    service_type_id: 1,
    scheduled_date: scheduledDate,
    ...overrides,
  }, await authHeaders());
  expect(result.response.status).toBe(201);
  return result.body;
}

export async function executeStatements(statements: string[]) {
  await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
}

/** Uploads a pre-work photo, a post-work photo, a submitted technician report,
 *  and a customer signature for `jobId` — everything canCompleteJob() (Phase 4)
 *  requires before a job can reach "completed". `auth` must belong to someone
 *  authorized for this job's compliance data (admin/dispatcher, or the job's
 *  own assigned technician) — same as any other compliance-writing call. */
export async function satisfyCompletionRequirements(jobId: number, auth: RequestInit): Promise<void> {
  const cookie = (auth.headers as Record<string, string>).cookie;

  for (const kind of ["pre_work_photo", "post_work_photo"]) {
    const form = new FormData();
    form.append("kind", kind);
    form.append("file", new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], `${kind}.jpg`, { type: "image/jpeg" }));
    const res = await request(`/api/jobs/${jobId}/photos`, { method: "POST", headers: { cookie }, body: form });
    expect(res.response.status).toBe(201);
  }

  const savedReport = await put(`/api/jobs/${jobId}/completion-report`, { work_performed: "Replaced filter and tested system." }, auth);
  expect(savedReport.response.status).toBe(200);
  const submitted = await post(`/api/jobs/${jobId}/completion-report/submit`, {}, auth);
  expect(submitted.response.status).toBe(200);

  const signed = await post(`/api/jobs/${jobId}/signature`, {
    signer_name: "Jane Customer",
    signature_data_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  }, auth);
  expect(signed.response.status).toBe(201);
}

/** Applies every migration statement (CREATE TABLE, ALTER TABLE, CREATE INDEX, seed
 *  INSERTs) — safe to call exactly once per test-file DB (beforeAll). Migrations may
 *  contain non-idempotent statements (e.g. ALTER TABLE ADD COLUMN), so this must NOT
 *  be called again against the same DB — see reseedBaselineData() for per-test resets. */
export async function applySchema() {
  await executeStatements(JSON.parse(env.TEST_SCHEMA_STATEMENTS) as string[]);
}

/** Re-runs only the seed (INSERT OR IGNORE) statements from the migrations — safe to
 *  call after every test's DELETEs, unlike applySchema(), because it never touches
 *  table structure. This is what restores the baseline admin user / service types /
 *  materials rows that resetDatabase() just deleted.
 *
 *  Filters specifically on "INSERT OR IGNORE", not just "INSERT" — a migration can
 *  also contain a one-time, non-idempotent data-transform INSERT (e.g. copying
 *  rescaled rows into a temp table as part of a SQLite table-rebuild, see
 *  migrations/0007_financial_invoicing.sql) that must run exactly once via
 *  applySchema() and never again: that temp table (e.g. invoices_new) gets
 *  renamed away before this function's first call, so blindly re-running a bare
 *  INSERT that targets it would fail every single test. Every genuine seed
 *  statement in this codebase already uses INSERT OR IGNORE by convention — this
 *  filter just enforces that as the real contract instead of "any INSERT". */
async function reseedBaselineData() {
  const statements = (JSON.parse(env.TEST_SCHEMA_STATEMENTS) as string[])
    .filter((s) => s.trim().toUpperCase().startsWith("INSERT OR IGNORE"));
  await executeStatements(statements);
}

/** Raw SELECT for test assertions against tables not exposed by any API response. */
export async function queryDb<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const stmt = params.length ? env.DB.prepare(sql).bind(...params) : env.DB.prepare(sql);
  const result = await stmt.all();
  return result.results as T[];
}

/** Full deterministic reset used by every test file's beforeEach. */
export async function resetDatabase() {
  resetCachedAdminCookie();
  await executeStatements([
    "DELETE FROM calendar_event_mappings",
    "DELETE FROM calendar_oauth_states",
    "DELETE FROM calendar_integrations",
    "DELETE FROM calendar_sync_claims",
    "DELETE FROM global_settings",
    "DELETE FROM sessions",
    "DELETE FROM invoice_lines",
    "DELETE FROM invoices",
    "DELETE FROM job_materials",
    "DELETE FROM materials",
    "DELETE FROM job_checklist",
    "DELETE FROM job_notes",
    // job_assets (Phase 11.4) cascades from both jobs and assets (ON DELETE
    // CASCADE), but per this file's own established convention every new
    // table gets an explicit entry anyway — deleted before jobs/assets
    // themselves, same ordering discipline as job_checklist/job_notes above.
    "DELETE FROM job_assets",
    "DELETE FROM jobs",
    // contracts (Phase 13) MUST be deleted before quotes/quote_versions:
    // contracts.quote_id is ON DELETE CASCADE (order-independent), but
    // contracts.accepted_quote_version_id has NO ON DELETE action (a
    // deliberate RESTRICT-like binding — see migrations/0018's header) —
    // deleting a still-referenced quote_versions row first would fail with
    // SQLITE_CONSTRAINT_FOREIGNKEY, the exact same forward-reference lesson
    // Phase 12 already learned the hard way for quotes.current_version_id
    // (see the comment on the quotes block right below). Deleting
    // `contracts` first also cascades away contract_versions/
    // contract_status_history/contract_signers/contract_signature_requests/
    // contract_signature_events automatically (each ON DELETE CASCADE from
    // its parent) — the explicit entries below are therefore redundant
    // no-ops by the time they run, kept anyway per this file's own
    // established "every new table gets its own entry" convention.
    "DELETE FROM contracts",
    // contract_templates MUST be deleted before contract_template_versions
    // for the identical forward-reference reason (current_version_id).
    "DELETE FROM contract_templates",
    "DELETE FROM contract_template_versions",
    "DELETE FROM contract_versions",
    "DELETE FROM contract_status_history",
    "DELETE FROM contract_signers",
    "DELETE FROM contract_signature_requests",
    "DELETE FROM contract_signature_events",
    // quotes.current_version_id REFERENCES quote_versions(id) with NO
    // delete action (see migrations/0017's header comment on why this
    // forward-reference is legal in SQLite) — this is the REVERSE of the
    // usual "children before parents" direction: `quotes` must be deleted
    // FIRST, while it still points at its current version, or the delete
    // is rejected as an FK violation (confirmed empirically — the original
    // child-first ordering here failed with SQLITE_CONSTRAINT_FOREIGNKEY).
    // Deleting `quotes` first also cascades away quote_versions (quote_id
    // ON DELETE CASCADE) and quote_status_history (quote_id ON DELETE
    // CASCADE) automatically, which in turn cascades quote_line_items
    // (quote_version_id ON DELETE CASCADE) — the 3 explicit deletes below
    // are therefore redundant no-ops by the time they run, kept anyway per
    // this file's own established "every new table gets its own entry,
    // checked explicitly rather than assumed" convention. Deleted before
    // "leads" below since quotes.lead_id (ON DELETE SET NULL) would
    // otherwise survive a lead delete with a dangling reference during
    // this per-test reset. By this point `contracts` (above) is already
    // gone, so nothing still references these quote_versions rows via
    // accepted_quote_version_id either.
    "DELETE FROM quotes",
    "DELETE FROM quote_line_items",
    "DELETE FROM quote_status_history",
    "DELETE FROM quote_versions",
    // leads (Phase 8.0) has no FK relationship requiring a particular
    // ordering here — every FK it holds (assigned_user_id/
    // referred_by_customer_id/converted_customer_id/converted_by) is
    // ON DELETE SET NULL, never RESTRICT, so it can be cleared independently
    // of customers/users below. lead_status_history cascades from leads
    // (ON DELETE CASCADE) and does not need its own entry, same pattern as
    // job_compliance_audit/payments/invoice_audit cascading from their
    // parents.
    "DELETE FROM leads",
    // notification_outbox (Phase 9.0) has no FK to customers/leads at all
    // (entity_type/entity_id is a deliberate plain text/int pair, not a
    // real FK — see migrations/0011's module comment), so deleting
    // customers/leads below does NOT cascade it away — it needs its own
    // explicit entry, unlike every *_history/*_audit table so far.
    // notification_delivery_attempts cascades from notification_outbox and
    // notification_preferences cascades from customers/leads (both ON
    // DELETE CASCADE) — neither needs its own entry, same established
    // pattern as lead_status_history/payments/invoice_lines.
    "DELETE FROM notification_outbox",
    "DELETE FROM service_types",
    "DELETE FROM technicians",
    // bc_rebate_customer_profiles (Phase 11.3) cascades from customers
    // (ON DELETE CASCADE) but is deleted explicitly anyway per this file's
    // own established convention — every new table gets its own entry
    // here, checked explicitly rather than assumed (see the calendar_sync_
    // claims/global_settings history above this list).
    "DELETE FROM bc_rebate_customer_profiles",
    // assets (Phase 11.4) cascades from customers (ON DELETE CASCADE) but,
    // same as bc_rebate_customer_profiles above, gets its own explicit
    // entry per this file's established convention rather than relying on
    // the cascade alone — deleted before customers.
    "DELETE FROM assets",
    "DELETE FROM customers",
    "DELETE FROM users",
    // organizations (Phase 11.5) — deleted AFTER users (FK: users.organization_id
    // has no ON DELETE action, so a still-referencing user row would violate
    // the constraint). id=1 (DEFAULT_ORGANIZATION_ID) is never deleted — every
    // other test file's fixtures assume it always exists; any additional
    // organization a test created via createSecondOrganization() is cleaned
    // up here like everything else.
    // organization_profiles (Phase 13A Company Profile hardening) cascades
    // from organizations (ON DELETE CASCADE) for any non-default org, but
    // org id=1 is never deleted above, so a profile a test wrote for the
    // default org must be cleared explicitly or it would leak into the
    // next test.
    "DELETE FROM organization_profiles",
    // tax_profiles/tax_snapshots (Phase 13D) — same reasoning as
    // organization_profiles directly above: org id=1 is never deleted, so a
    // tax profile version (or a document's tax snapshot) a test wrote for
    // the default org must be cleared explicitly or it leaks into the next
    // test. tax_profile_components/tax_snapshot_components both cascade
    // from their parent (ON DELETE CASCADE) but get their own entries
    // anyway per this file's established convention.
    "DELETE FROM tax_profile_components",
    "DELETE FROM tax_profiles",
    "DELETE FROM tax_snapshot_components",
    "DELETE FROM tax_snapshots",
    // Phone Operations (Phase 15) — same reasoning: org id=1 is never
    // deleted, so every one of these must be cleared explicitly or leak
    // into the next test.
    "DELETE FROM call_transcripts",
    "DELETE FROM call_events",
    "DELETE FROM call_outcomes",
    "DELETE FROM call_transfers",
    "DELETE FROM call_sessions",
    "DELETE FROM calls",
    "DELETE FROM phone_numbers",
    "DELETE FROM voice_agents",
    "DELETE FROM voice_engine_service_credentials",
    "DELETE FROM voice_engine_credentials",
    "DELETE FROM phone_operations_settings",
    "DELETE FROM phone_operations_audit",
    // Phase 16 — call_follow_ups/call_tool_invocations both cascade from
    // calls (ON DELETE CASCADE), already in this list, but get their own
    // entries anyway per this file's established convention (see the
    // Phase 13D tax_snapshot_components precedent above).
    "DELETE FROM call_follow_ups",
    "DELETE FROM call_tool_invocations",
    // Pricebook (Phase 17) — org id=1 is never deleted, so items/categories a
    // test wrote for the default org must be cleared explicitly or leak into
    // the next test, same reasoning as organization_profiles/tax_profiles
    // above. pricebook_item_audit cascades from pricebook_items (ON DELETE
    // CASCADE) but gets its own entry anyway per this file's established
    // convention. quote_line_items/invoice_lines/assets.pricebook_item_id
    // are all ON DELETE SET NULL, not RESTRICT, so deleting pricebook_items
    // here (those rows are already gone via their own cascades above) needs
    // no special ordering relative to them.
    "DELETE FROM pricebook_item_audit",
    "DELETE FROM pricebook_items",
    "DELETE FROM pricebook_categories",
    "DELETE FROM organizations WHERE id != 1",
    "UPDATE _meta SET value = '0' WHERE key IN ('job_counter', 'invoice_counter', 'lead_counter', 'quote_counter', 'contract_counter')",
    "DELETE FROM sqlite_sequence",
  ]);
  await reseedBaselineData();
}

export const ADMIN_EMAIL = "admin@fieldscheduler.local";
export const ADMIN_PASSWORD = "ChangeMe123!";

// ── Phase 11.5 — tenant/organization test fixtures ──────────────────────
//
// The seeded admin (above) always belongs to DEFAULT_ORGANIZATION_ID (the
// organization migration 0015 creates and every pre-existing row backfills
// to). For isolation tests, a genuinely second organization needs its own
// admin seeded directly via raw SQL — there is no API path to create a user
// in an organization other than your own, by design (that's the whole
// point of the boundary), so this mirrors how the default org's own admin
// is seeded by migration rather than created through the API.

export const DEFAULT_ORGANIZATION_ID = 1;

export async function createOrganization(name: string): Promise<number> {
  const result = await env.DB.prepare("INSERT INTO organizations (name, status) VALUES (?, 'active')").bind(name).run();
  return result.meta.last_row_id as number;
}

export interface SecondOrgFixture {
  organizationId: number;
  email: string;
  password: string;
}

let secondOrgCounter = 0;

/** Seeds a brand-new organization plus its own admin user (real PBKDF2 hash,
 *  a genuinely loginable credential, not a fixture-only stub). Call
 *  `loginAs(fixture.email, fixture.password)` to get real session auth for
 *  it, then use the ordinary post/put/del helpers exactly as with the
 *  default-org admin — every fixture created that way is correctly scoped
 *  to this new organization by the application's own create-path logic
 *  (never by this helper reaching into the database for anything beyond
 *  the org + its one seed admin). */
export async function createSecondOrganization(name = "Second Org"): Promise<SecondOrgFixture> {
  secondOrgCounter++;
  const organizationId = await createOrganization(name);
  const email = `org${organizationId}-admin-${secondOrgCounter}@example.test`;
  const password = "SecondOrgPass1";
  const passwordHash = await hashPassword(password);
  await env.DB.prepare(
    "INSERT INTO users (name, email, password_hash, role, active, organization_id) VALUES (?, ?, ?, 'admin', 1, ?)"
  ).bind("Second Org Admin", email, passwordHash, organizationId).run();
  return { organizationId, email, password };
}

export async function createUser(overrides: Record<string, unknown> = {}) {
  const result = await post<{ user: { id: number; email: string } }>("/api/users", {
    name: "Staff User",
    email: "staff@example.test",
    password: "StaffPass123",
    role: "dispatcher",
    ...overrides,
  }, await authHeaders());
  expect(result.response.status).toBe(201);
  return result.body.user;
}

/** Extracts the session token from a Set-Cookie header so it can be replayed on later requests. */
export function extractSessionCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("Response did not set a session cookie");
  const [cookiePair] = setCookie.split(";");
  return cookiePair;
}

export async function loginAs(email: string, password: string): Promise<{ cookie: string; body: { user: { id: number; role: string } } }> {
  const result = await post<{ user: { id: number; role: string } }>("/api/auth/login", { email, password });
  expect(result.response.status).toBe(200);
  return { cookie: extractSessionCookie(result.response), body: result.body };
}

export async function loginAsAdmin(): Promise<string> {
  const { cookie } = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  return cookie;
}

let cachedAdminCookie: string | null = null;

/** Convenience RequestInit carrying an authenticated admin session cookie, cached per test. */
export async function authHeaders(): Promise<RequestInit> {
  if (!cachedAdminCookie) cachedAdminCookie = await loginAsAdmin();
  return { headers: { cookie: cachedAdminCookie } };
}

export function resetCachedAdminCookie() {
  cachedAdminCookie = null;
}

// ── Google Calendar API mock ────────────────────────────────────────
//
// The worker and this test file run in the same isolate (that's the point of
// @cloudflare/vitest-pool-workers), so monkey-patching globalThis.fetch here
// also intercepts the outbound fetch() calls the worker's route handlers make
// to Google. No real network requests to Google are ever made in tests.

export interface GoogleMockState {
  tokenResponse: { access_token: string; refresh_token?: string; expires_in: number; scope: string; token_type: string };
  userEmail: string;
  calendars: { id: string; summary: string; primary?: boolean }[];
  events: Map<string, Record<string, unknown>>;
  nextEventId: number;
  failNextInsert: boolean;
  failNextUpdate: boolean;
  failAllWithStatus: number | null;
  calls: { method: string; url: string }[];
  /** Artificial delay (ms) before an insert/update resolves — used by
   *  concurrency tests to force two overlapping syncJobForUser() calls to both
   *  pass their "check" (mapping read) before either completes its "act"
   *  (Google call + mapping write), reliably reproducing the interleaving a
   *  real concurrent-request race would produce, instead of hoping JS's
   *  natural microtask ordering happens to interleave them. */
  insertDelayMs: number;
}

export interface GoogleMock {
  state: GoogleMockState;
  restore: () => void;
}

export function mockGoogleApi(overrides: Partial<GoogleMockState> = {}): GoogleMock {
  const state: GoogleMockState = {
    tokenResponse: { access_token: "mock-access-token", refresh_token: "mock-refresh-token", expires_in: 3600, scope: "openid email", token_type: "Bearer" },
    userEmail: "mockuser@gmail.com",
    calendars: [{ id: "primary", summary: "Primary Calendar", primary: true }, { id: "work@group.calendar.google.com", summary: "Work Calendar" }],
    events: new Map(),
    nextEventId: 1,
    failNextInsert: false,
    failNextUpdate: false,
    failAllWithStatus: null,
    calls: [],
    insertDelayMs: 0,
    ...overrides,
  };

  const original = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const isGoogleUrl = url.includes("googleapis.com") || url.includes("accounts.google.com");
    if (!isGoogleUrl) return original(input as RequestInfo, init);

    const method = (init?.method || "GET").toUpperCase();
    state.calls.push({ method, url });

    if (state.failAllWithStatus !== null) {
      return new Response(JSON.stringify({ error: "mocked_failure" }), { status: state.failAllWithStatus });
    }

    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify(state.tokenResponse), { status: 200 });
    }
    if (url.startsWith("https://oauth2.googleapis.com/revoke")) {
      return new Response(null, { status: 200 });
    }
    if (url.startsWith("https://www.googleapis.com/oauth2/v2/userinfo")) {
      return new Response(JSON.stringify({ email: state.userEmail }), { status: 200 });
    }
    if (url.startsWith("https://www.googleapis.com/calendar/v3/users/me/calendarList")) {
      return new Response(JSON.stringify({ items: state.calendars }), { status: 200 });
    }

    const eventsMatch = url.match(/\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/?]+))?/);
    if (eventsMatch) {
      const eventId = eventsMatch[2] ? decodeURIComponent(eventsMatch[2]) : null;
      if (method === "POST") {
        if (state.insertDelayMs > 0) await new Promise((r) => setTimeout(r, state.insertDelayMs));
        if (state.failNextInsert) {
          state.failNextInsert = false;
          return new Response(JSON.stringify({ error: "mocked insert failure" }), { status: 500 });
        }
        const body = (init?.body ? JSON.parse(init.body as string) : {}) as Record<string, unknown>;
        // Real Google behavior: a client-supplied `id` (see buildDeterministicEventId)
        // is used as-is, and a second insert with an id that already exists is a
        // 409 conflict, not a silent overwrite or a second event.
        const id = typeof body.id === "string" ? body.id : `evt${state.nextEventId++}`;
        if (state.events.has(id)) {
          return new Response(JSON.stringify({ error: { code: 409, message: "The requested identifier already exists." } }), { status: 409 });
        }
        state.events.set(id, body);
        return new Response(JSON.stringify({ ...body, id }), { status: 200 });
      }
      if (method === "PATCH" && eventId) {
        if (state.insertDelayMs > 0) await new Promise((r) => setTimeout(r, state.insertDelayMs));
        if (state.failNextUpdate) {
          state.failNextUpdate = false;
          return new Response(JSON.stringify({ error: "mocked update failure" }), { status: 500 });
        }
        // Real Google behavior: PATCHing a nonexistent event id is a 404, not a
        // silent create — important for the retry/reconciliation tests, where a
        // stale/wrong id must fail loudly rather than quietly fabricate an event.
        if (!state.events.has(eventId)) {
          return new Response(JSON.stringify({ error: { code: 404, message: "Not Found" } }), { status: 404 });
        }
        const body = (init?.body ? JSON.parse(init.body as string) : {}) as Record<string, unknown>;
        state.events.set(eventId, body);
        return new Response(JSON.stringify({ ...body, id: eventId }), { status: 200 });
      }
      if (method === "DELETE" && eventId) {
        const existed = state.events.delete(eventId);
        return new Response(null, { status: existed ? 200 : 410 });
      }
    }

    return new Response(JSON.stringify({ error: "unhandled mock route", url }), { status: 500 });
  }) as typeof fetch;

  return {
    state,
    restore() {
      globalThis.fetch = original;
    },
  };
}

// ── PDF text extraction (Phase 13B content-correctness tests) ───────────
//
// pdf-lib's default save() Flate-compresses content streams, so a raw
// substring check against a rendered PDF's bytes only ever finds the
// literal object dictionaries — never the actual text drawn on the page.
// This inflates every `stream ... endstream` block (using the Workers-
// runtime-native DecompressionStream — PDF's FlateDecode is the same
// zlib/RFC1950 format as the Streams API's "deflate") and decodes the hex
// strings pdf-lib draws Tj text as, so a test can assert on what the
// rendered page actually says. StandardFonts like Helvetica draw literal
// single-byte-per-character text, so this round-trips as plain ASCII.
// Best-effort: any block that isn't itself Flate-compressed (already-plain
// object dictionaries) is skipped rather than failing the extraction.
//
// This is deliberately NOT a substitute for exact-byte comparison against
// an immutable stored artifact (see contracts' signed_document_hash
// pattern) — Invoice/Receipt PDFs are live-rendered and embed a real
// generation timestamp (CreationDate/ModDate) on every render, so two
// renders of the same invoice/payment seconds apart are legitimately
// byte-different even though their financial content is identical. Text
// extraction is the correct invariant to test here, not byte equality.

export function pdfBytesToText(bytes: Uint8Array): string {
  let result = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    result += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return result;
}

function textToBytes(text: string): Uint8Array {
  return Uint8Array.from(text, (ch) => ch.charCodeAt(0));
}

export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const raw = pdfBytesToText(bytes);
  let out = "";
  let from = 0;
  for (;;) {
    const streamAt = raw.indexOf("stream", from);
    if (streamAt === -1) break;
    const endAt = raw.indexOf("endstream", streamAt);
    if (endAt === -1) break;
    let bodyStart = streamAt + "stream".length;
    if (raw[bodyStart] === "\r") bodyStart++;
    if (raw[bodyStart] === "\n") bodyStart++;
    let bodyEnd = endAt;
    if (raw[bodyEnd - 1] === "\n") bodyEnd--;
    if (raw[bodyEnd - 1] === "\r") bodyEnd--;
    const body = textToBytes(raw.slice(bodyStart, bodyEnd));
    try {
      const ds = new DecompressionStream("deflate");
      const decompressedStream = new Response(body as BodyInit).body!.pipeThrough(ds);
      const inflated = new Uint8Array(await new Response(decompressedStream).arrayBuffer());
      out += pdfBytesToText(inflated);
    } catch {
      // Not a Flate stream (or malformed) — skip, this is best-effort text extraction for tests.
    }
    from = endAt + "endstream".length;
  }
  const decodedHex = out.replace(/<([0-9A-Fa-f]{2,})>/g, (_m, hex: string) => {
    let decoded = "";
    for (let i = 0; i + 1 < hex.length; i += 2) decoded += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    return decoded;
  });
  return out + decodedHex;
}

// ── Notification provider mocks (Phase 9.2) ─────────────────────────────
//
// Same same-isolate monkey-patch trick as mockGoogleApi() above — the
// worker's outbound fetch() calls to Resend/Twilio are intercepted here, so
// no test ever reaches a real provider (Section 21's explicit requirement).

export interface NotificationProviderMockState {
  failNextEmailWithStatus: number | null;
  failNextSmsWithStatus: number | null;
  emailDelayMs: number;
  smsDelayMs: number;
  emailCalls: { to: string; subject: string; idempotencyKey: string | null; attachments: { filename: string; content: string }[] | null }[];
  smsCalls: { to: string; body: string }[];
  nextEmailId: number;
  nextSmsId: number;
  /** Phase 9.4 — invoked right before a SUCCESSFUL email response is
   *  returned, so a test can simulate "the provider accepted the message,
   *  then something else went wrong before it was recorded" (e.g. deleting
   *  the outbox row here to trigger a real FK-constraint failure in
   *  recordAttempt()'s INSERT) — see the Phase 9.4 report's "Uncertain
   *  Provider Outcome" section for what this proves. */
  beforeSuccessfulEmailResponse?: () => Promise<void>;
}

export interface NotificationProviderMock {
  state: NotificationProviderMockState;
  restore: () => void;
}

export function mockNotificationProviders(overrides: Partial<NotificationProviderMockState> = {}): NotificationProviderMock {
  const state: NotificationProviderMockState = {
    failNextEmailWithStatus: null,
    failNextSmsWithStatus: null,
    emailDelayMs: 0,
    smsDelayMs: 0,
    emailCalls: [],
    smsCalls: [],
    nextEmailId: 1,
    nextSmsId: 1,
    ...overrides,
  };

  const original = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;

    if (url.startsWith("https://api.resend.com/emails")) {
      if (state.emailDelayMs > 0) await new Promise((r) => setTimeout(r, state.emailDelayMs));
      const body = (init?.body ? JSON.parse(init.body as string) : {}) as { to: string[]; subject: string; attachments?: { filename: string; content: string }[] };
      const headers = init?.headers as Record<string, string> | undefined;
      state.emailCalls.push({ to: body.to[0], subject: body.subject, idempotencyKey: headers?.["Idempotency-Key"] ?? null, attachments: body.attachments ?? null });
      if (state.failNextEmailWithStatus !== null) {
        const status = state.failNextEmailWithStatus;
        state.failNextEmailWithStatus = null;
        return new Response(JSON.stringify({ message: "mocked failure — contains a fake Authorization: Bearer sk_test_should_never_be_stored token" }), { status });
      }
      if (state.beforeSuccessfulEmailResponse) await state.beforeSuccessfulEmailResponse();
      return new Response(JSON.stringify({ id: `email-${state.nextEmailId++}` }), { status: 200 });
    }

    if (url.startsWith("https://api.twilio.com/")) {
      if (state.smsDelayMs > 0) await new Promise((r) => setTimeout(r, state.smsDelayMs));
      const params = new URLSearchParams(init?.body as string);
      state.smsCalls.push({ to: params.get("To") || "", body: params.get("Body") || "" });
      if (state.failNextSmsWithStatus !== null) {
        const status = state.failNextSmsWithStatus;
        state.failNextSmsWithStatus = null;
        return new Response(JSON.stringify({ message: "mocked failure — contains a fake Authorization: Basic dGVzdDpzZWNyZXQ= token" }), { status });
      }
      return new Response(JSON.stringify({ sid: `SM${state.nextSmsId++}` }), { status: 200 });
    }

    return original(input as RequestInfo, init);
  }) as typeof fetch;

  return {
    state,
    restore() {
      globalThis.fetch = original;
    },
  };
}

// ── Google Geocoding API mock (Phase 10.1) ──────────────────────────────
//
// Same same-isolate monkey-patch trick as mockGoogleApi()/
// mockNotificationProviders() above — no test ever reaches the real Google
// Maps Platform (Section 20's explicit "ZERO real Google network calls"
// requirement for the automated suite).

export interface GoogleGeocodingMockState {
  status: "OK" | "ZERO_RESULTS" | "OVER_QUERY_LIMIT" | "REQUEST_DENIED" | "INVALID_REQUEST" | "UNKNOWN_ERROR";
  lat: number;
  lng: number;
  formattedAddress: string;
  placeId: string;
  /** Non-200 HTTP status to return BEFORE any Google `status` field is
   *  considered — set to test the transport-level (not application-level)
   *  error path. */
  httpStatus: number;
  /** Returns literally-invalid JSON instead of a real body. */
  malformed: boolean;
  /** Returns an "OK" status but with a missing/invalid coordinate — proves
   *  the adapter's own defense-in-depth validation, not just Google's. */
  invalidCoordinate: boolean;
  /** Artificial delay (ms) before responding — races against the caller's
   *  AbortSignal.timeout() the same way mockGoogleApi's insertDelayMs races
   *  a real concurrent request; used by the TIMEOUT test. */
  delayMs: number;
  calls: { url: string }[];
}

export interface GoogleGeocodingMock {
  state: GoogleGeocodingMockState;
  restore: () => void;
}

export function mockGoogleGeocodingApi(overrides: Partial<GoogleGeocodingMockState> = {}): GoogleGeocodingMock {
  const state: GoogleGeocodingMockState = {
    status: "OK",
    lat: 49.2827,
    lng: -123.1207,
    formattedAddress: "123 Mock St, Vancouver, BC, Canada",
    placeId: "mock_place_id",
    httpStatus: 200,
    malformed: false,
    invalidCoordinate: false,
    delayMs: 0,
    calls: [],
    ...overrides,
  };

  const original = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (!url.includes("maps.googleapis.com/maps/api/geocode")) return original(input as RequestInfo, init);
    state.calls.push({ url });

    if (state.delayMs > 0) {
      const signal = init?.signal;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, state.delayMs);
        if (signal) {
          if (signal.aborted) { clearTimeout(timer); reject(new DOMException("The operation was aborted.", "TimeoutError")); return; }
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("The operation was aborted.", "TimeoutError"));
          }, { once: true });
        }
      });
    }

    if (state.malformed) return new Response("not valid json {{{", { status: 200 });
    if (state.httpStatus !== 200) return new Response(JSON.stringify({ error_message: "mocked http failure" }), { status: state.httpStatus });

    if (state.status !== "OK") {
      return new Response(JSON.stringify({ status: state.status, results: [] }), { status: 200 });
    }

    const location = state.invalidCoordinate ? { lat: 999, lng: state.lng } : { lat: state.lat, lng: state.lng };
    return new Response(JSON.stringify({
      status: "OK",
      results: [{ formatted_address: state.formattedAddress, place_id: state.placeId, geometry: { location } }],
    }), { status: 200 });
  }) as typeof fetch;

  return {
    state,
    restore() {
      globalThis.fetch = original;
    },
  };
}

// ── Google Routes API mock (Phase 10.4) ─────────────────────────────────
//
// Same same-isolate monkey-patch trick as mockGoogleGeocodingApi() above —
// no test ever reaches the real Google Routes API.

export interface GoogleRoutesMockState {
  /** Distance/duration per leg the mock returns for a normal "OK" call —
   *  cycled if there are more legs than entries. */
  legDistances: number[];
  legDurations: number[];
  polyline: string | null;
  /** Returns a `routes: []` response — the ZERO_RESULTS/NOT_FOUND analog. */
  noRoute: boolean;
  /** Non-200 HTTP status, with a standard Google API error body shape
   *  (`{error: {status: ...}}`). */
  httpStatus: number;
  googleErrorStatus: string | null;
  malformed: boolean;
  /** Omits the `legs` array entirely from the response (leg-count mismatch path). */
  omitLegs: boolean;
  delayMs: number;
  calls: { url: string; headers: Record<string, string>; body: unknown }[];
}

export interface GoogleRoutesMock {
  state: GoogleRoutesMockState;
  restore: () => void;
}

export function mockGoogleRoutesApi(overrides: Partial<GoogleRoutesMockState> = {}): GoogleRoutesMock {
  const state: GoogleRoutesMockState = {
    legDistances: [5000],
    legDurations: [600],
    polyline: "mockPolyline123",
    noRoute: false,
    httpStatus: 200,
    googleErrorStatus: null,
    malformed: false,
    omitLegs: false,
    delayMs: 0,
    calls: [],
    ...overrides,
  };

  const original = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (!url.includes("routes.googleapis.com/directions/v2:computeRoutes")) return original(input as RequestInfo, init);

    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const k of Object.keys(h)) headers[k] = h[k];
    }
    let body: unknown = null;
    try { body = init?.body ? JSON.parse(init.body as string) : null; } catch { /* leave body null on parse failure */ }
    state.calls.push({ url, headers, body });

    if (state.delayMs > 0) {
      const signal = init?.signal;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, state.delayMs);
        if (signal) {
          if (signal.aborted) { clearTimeout(timer); reject(new DOMException("The operation was aborted.", "TimeoutError")); return; }
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("The operation was aborted.", "TimeoutError"));
          }, { once: true });
        }
      });
    }

    if (state.malformed) return new Response("not valid json {{{", { status: 200 });
    if (state.httpStatus !== 200) {
      return new Response(JSON.stringify({ error: { code: state.httpStatus, message: "mocked failure", status: state.googleErrorStatus ?? undefined } }), { status: state.httpStatus });
    }
    if (state.noRoute) return new Response(JSON.stringify({ routes: [] }), { status: 200 });

    const requestBody = body as { intermediates?: unknown[] } | null;
    const legCount = (requestBody?.intermediates?.length ?? 0) + 1;
    const legs = state.omitLegs ? undefined : Array.from({ length: legCount }, (_, i) => ({
      distanceMeters: state.legDistances[i % state.legDistances.length],
      duration: `${state.legDurations[i % state.legDurations.length]}s`,
    }));
    const totalDistance = (legs ?? []).reduce((sum, l) => sum + l.distanceMeters, 0) || state.legDistances[0];
    const totalDuration = (legs ?? []).reduce((sum, l) => sum + Number(l.duration.slice(0, -1)), 0) || state.legDurations[0];

    return new Response(JSON.stringify({
      routes: [{
        distanceMeters: totalDistance,
        duration: `${totalDuration}s`,
        legs,
        polyline: state.polyline ? { encodedPolyline: state.polyline } : undefined,
      }],
    }), { status: 200 });
  }) as typeof fetch;

  return {
    state,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** Calls the exported Cloudflare `scheduled()` handler directly — same
 *  in-isolate direct-call pattern `request()` above uses for `fetch()`, just
 *  for the Cron entry point instead (there is no HTTP route to trigger a
 *  dispatch cycle, by design — see notification-dispatcher.ts). */
export async function runScheduled(): Promise<void> {
  const controller = { cron: "* * * * *", scheduledTime: Date.now(), noRetry: () => {} } as unknown as ScheduledController;
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: undefined } as unknown as ExecutionContext;
  const handler = workerExports.default as unknown as { scheduled: (c: ScheduledController, e: unknown, x: ExecutionContext) => Promise<void> };
  await handler.scheduled(controller, env, ctx);
}
