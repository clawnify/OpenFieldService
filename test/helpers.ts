import { env, exports as workerExports } from "cloudflare:workers";
import { expect } from "vitest";

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
    "DELETE FROM jobs",
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
    "DELETE FROM customers",
    "DELETE FROM users",
    "UPDATE _meta SET value = '0' WHERE key IN ('job_counter', 'invoice_counter', 'lead_counter')",
    "DELETE FROM sqlite_sequence",
  ]);
  await reseedBaselineData();
}

export const ADMIN_EMAIL = "admin@fieldscheduler.local";
export const ADMIN_PASSWORD = "ChangeMe123!";

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
  emailCalls: { to: string; subject: string; idempotencyKey: string | null }[];
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
      const body = (init?.body ? JSON.parse(init.body as string) : {}) as { to: string[]; subject: string };
      const headers = init?.headers as Record<string, string> | undefined;
      state.emailCalls.push({ to: body.to[0], subject: body.subject, idempotencyKey: headers?.["Idempotency-Key"] ?? null });
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
