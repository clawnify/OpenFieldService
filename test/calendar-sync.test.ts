import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applySchema, authHeaders, createCustomer, createJob, createUser,
  del, loginAs, mockGoogleApi, post, put, queryDb, request, requestRaw, resetDatabase,
  type GoogleMock,
} from "./helpers.js";

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

let google: GoogleMock;
afterEach(() => {
  google?.restore();
});

/** Drives the full connect -> Google consent (mocked) -> callback round trip for
 *  whichever user's cookie is passed, returning the resulting integration row. */
async function connectGoogleCalendar(cookie: string) {
  const connectRes = await requestRaw("/api/integrations/google-calendar/connect", { headers: { cookie } });
  expect(connectRes.status).toBe(302);
  const authUrl = new URL(connectRes.headers.get("location")!);
  expect(authUrl.origin + authUrl.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  const state = authUrl.searchParams.get("state")!;
  expect(state).toBeTruthy();

  const callbackRes = await requestRaw(
    `/api/integrations/google-calendar/callback?code=mock-auth-code&state=${state}`,
    { headers: { cookie } }
  );
  expect(callbackRes.status).toBe(302);
  return { authUrl, callbackRes, state };
}

describe("OAuth connection flow", () => {
  it("redirects to Google's authorization endpoint with the correct client id, scopes, and a CSRF state", async () => {
    google = mockGoogleApi();
    const auth = await authHeaders();
    const cookie = (auth.headers as Record<string, string>).cookie;

    const res = await requestRaw("/api/integrations/google-calendar/connect", { headers: { cookie } });
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location")!);

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("test-client-id.apps.googleusercontent.com");
    expect(url.searchParams.get("redirect_uri")).toBe("http://example.test/api/integrations/google-calendar/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("scope")).toContain("calendar.events");
    expect(url.searchParams.get("scope")).toContain("calendar.readonly");
    expect(url.searchParams.get("state")).toBeTruthy();

    const states = await queryDb("SELECT * FROM calendar_oauth_states WHERE state = ?", [url.searchParams.get("state")]);
    expect(states).toHaveLength(1);
  });

  it("rejects an unauthenticated connect attempt", async () => {
    const res = await requestRaw("/api/integrations/google-calendar/connect");
    expect(res.status).toBe(401);
  });

  it("completes the callback, storing encrypted tokens and the connected account email", async () => {
    google = mockGoogleApi({ userEmail: "field-admin@gmail.com" });
    const auth = await authHeaders();
    const cookie = (auth.headers as Record<string, string>).cookie;

    const { callbackRes } = await connectGoogleCalendar(cookie);
    expect(callbackRes.headers.get("location")).toContain("google=connected");

    const status = await request<{ connected: boolean; account_email: string; status: string }>(
      "/api/integrations/google-calendar", auth
    );
    expect(status.body).toMatchObject({ connected: true, account_email: "field-admin@gmail.com", status: "connected" });

    const rows = await queryDb<{ access_token_encrypted: string; refresh_token_encrypted: string }>(
      "SELECT access_token_encrypted, refresh_token_encrypted FROM calendar_integrations"
    );
    expect(rows).toHaveLength(1);
    // Tokens must be encrypted at rest — never the raw mock token string.
    expect(rows[0].access_token_encrypted).not.toContain("mock-access-token");
    expect(rows[0].refresh_token_encrypted).not.toContain("mock-refresh-token");
  });

  it("rejects a callback with a state that was never issued (CSRF protection)", async () => {
    google = mockGoogleApi();
    const auth = await authHeaders();
    const cookie = (auth.headers as Record<string, string>).cookie;

    const res = await requestRaw(
      "/api/integrations/google-calendar/callback?code=whatever&state=not-a-real-state",
      { headers: { cookie } }
    );
    expect(res.headers.get("location")).toContain("google=invalid_request");

    const rows = await queryDb("SELECT * FROM calendar_integrations");
    expect(rows).toHaveLength(0);
  });

  it("redirects with a denied status when the user declines authorization", async () => {
    const auth = await authHeaders();
    const cookie = (auth.headers as Record<string, string>).cookie;
    const res = await requestRaw(
      "/api/integrations/google-calendar/callback?error=access_denied",
      { headers: { cookie } }
    );
    expect(res.headers.get("location")).toContain("google=denied");
  });
});

describe("calendar selection", () => {
  it("lists the connected account's Google Calendars", async () => {
    google = mockGoogleApi({
      calendars: [{ id: "primary", summary: "Primary Calendar", primary: true }, { id: "work-cal", summary: "Work Calendar" }],
    });
    const auth = await authHeaders();
    await connectGoogleCalendar((auth.headers as Record<string, string>).cookie);

    const res = await request<{ calendars: { id: string; summary: string }[] }>(
      "/api/integrations/google-calendar/calendars", auth
    );
    expect(res.response.status).toBe(200);
    expect(res.body.calendars.map((c) => c.summary)).toEqual(["Primary Calendar", "Work Calendar"]);
  });

  it("reports a stale Google credential as 409, not 401, and leaves the Field Scheduler session intact", async () => {
    // Regression test: this endpoint used to return 401 when Google's token needed
    // reauthorization, which collided with the frontend's global rule that any 401
    // means "the Field Scheduler session is dead, log out" (src/client/api.ts). A
    // perfectly valid session hitting this route while Google needed reauth was
    // getting force-logged-out even though nothing was wrong with its own session.
    google = mockGoogleApi();
    const auth = await authHeaders();
    const cookie = (auth.headers as Record<string, string>).cookie;
    await connectGoogleCalendar(cookie);
    google.state.failAllWithStatus = 401;

    const res = await request<{ error: string }>("/api/integrations/google-calendar/calendars", auth);
    expect(res.response.status).toBe(409);
    expect(res.response.status).not.toBe(401);
    expect(res.body.error).toMatch(/reconnect/i);

    // The Field Scheduler session itself must still be valid — this is exactly what
    // navigating Dashboard -> Google Calendar checks in the real app.
    const me = await request("/api/auth/me", { headers: { cookie } });
    expect(me.response.status).toBe(200);

    const status = await request<{ status: string }>("/api/integrations/google-calendar", auth);
    expect(status.body.status).toBe("needs_reauth");
  });

  it("saves the selected calendar and sync preference", async () => {
    google = mockGoogleApi();
    const auth = await authHeaders();
    await connectGoogleCalendar((auth.headers as Record<string, string>).cookie);

    const save = await put<{ ok: boolean }>("/api/integrations/google-calendar/settings", {
      calendar_id: "work-cal",
      calendar_summary: "Work Calendar",
      sync_enabled: true,
    }, auth);
    expect(save.response.status).toBe(200);

    const status = await request<{ calendar_id: string; calendar_summary: string }>("/api/integrations/google-calendar", auth);
    expect(status.body).toMatchObject({ calendar_id: "work-cal", calendar_summary: "Work Calendar" });
  });
});

describe("job sync", () => {
  async function connectedAdmin() {
    google = mockGoogleApi();
    const auth = await authHeaders();
    await connectGoogleCalendar((auth.headers as Record<string, string>).cookie);
    return auth;
  }

  it("creates a Google Calendar event when a job is created", async () => {
    await connectedAdmin();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20", { scheduled_time: "10:00", duration: 120 });

    expect(google.state.events.size).toBe(1);
    const [[, event]] = [...google.state.events.entries()];
    // America/Vancouver, not UTC — migrations/0012 now seeds BUSINESS_TIMEZONE
    // for every environment (see the "job sync — business timezone correctness"
    // describe block below for the full fresh-environment/DST coverage).
    expect(event.start).toMatchObject({ dateTime: "2026-08-20T10:00:00", timeZone: "America/Vancouver" });
    expect(event.end).toMatchObject({ dateTime: "2026-08-20T12:00:00", timeZone: "America/Vancouver" });
    expect(event.location).toBe("100 Main St, Burnaby, BC, V5A 1A1");
    expect(event.description).toContain("Customer: Ada Heating");

    const mapping = await queryDb<{ sync_status: string; external_event_id: string }>(
      "SELECT sync_status, external_event_id FROM calendar_event_mappings WHERE job_id = ?", [job.id]
    );
    expect(mapping[0]).toMatchObject({ sync_status: "synced" });
    expect(mapping[0].external_event_id).toBeTruthy();
  });

  it("updates the existing Google event (not a new one) when a job is edited", async () => {
    const auth = await connectedAdmin();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20", { scheduled_time: "10:00" });
    expect(google.state.events.size).toBe(1);

    await put(`/api/jobs/${job.id}`, { notes: "Bring extra filters" }, auth);

    expect(google.state.events.size).toBe(1);
    const mappings = await queryDb("SELECT * FROM calendar_event_mappings WHERE job_id = ?", [job.id]);
    expect(mappings).toHaveLength(1);
    const [[, event]] = [...google.state.events.entries()];
    expect(event.description).toContain("Bring extra filters");
  });

  it("updates (not duplicates) the event when a job is rescheduled", async () => {
    const auth = await connectedAdmin();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20", { scheduled_time: "10:00" });
    const firstEventId = [...google.state.events.keys()][0];

    await put(`/api/jobs/${job.id}`, { scheduled_date: "2026-08-21" }, auth);

    expect(google.state.events.size).toBe(1);
    expect([...google.state.events.keys()][0]).toBe(firstEventId);
    const event = google.state.events.get(firstEventId)!;
    expect((event.start as { dateTime: string }).dateTime).toBe("2026-08-21T10:00:00");
  });

  it("removes the Google event when a job is cancelled, and does not leave it scheduled", async () => {
    const auth = await connectedAdmin();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20");
    expect(google.state.events.size).toBe(1);

    await post(`/api/jobs/${job.id}/transition`, { to_status: "cancelled" }, auth);

    expect(google.state.events.size).toBe(0);
    const mapping = await queryDb<{ sync_status: string }>(
      "SELECT sync_status FROM calendar_event_mappings WHERE job_id = ?", [job.id]
    );
    expect(mapping[0].sync_status).toBe("deleted");
  });

  it("creates a fresh event if a cancelled job is rescheduled back to active", async () => {
    const auth = await connectedAdmin();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20");
    await post(`/api/jobs/${job.id}/transition`, { to_status: "cancelled" }, auth);
    expect(google.state.events.size).toBe(0);

    await post(`/api/jobs/${job.id}/transition`, { to_status: "scheduled" }, auth);

    expect(google.state.events.size).toBe(1);
    const mapping = await queryDb<{ sync_status: string }>(
      "SELECT sync_status FROM calendar_event_mappings WHERE job_id = ?", [job.id]
    );
    expect(mapping[0].sync_status).toBe("synced");
  });

  it("removes the Google event when a job is deleted outright", async () => {
    const auth = await connectedAdmin();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20");
    expect(google.state.events.size).toBe(1);

    await del(`/api/jobs/${job.id}`, auth);

    expect(google.state.events.size).toBe(0);
  });

  it("never blocks job creation when Google Calendar is not connected", async () => {
    google = mockGoogleApi();
    const customer = await createCustomer();

    const job = await createJob(customer.id, "2026-08-20");

    expect(job.id).toBeGreaterThan(0);
    expect(google.state.events.size).toBe(0);
    expect(google.state.calls).toHaveLength(0);
  });

  it("never blocks job creation when Google Calendar sync fails", async () => {
    await connectedAdmin();
    google.state.failAllWithStatus = 500;
    const customer = await createCustomer();

    const job = await createJob(customer.id, "2026-08-20");

    expect(job.id).toBeGreaterThan(0);
    const mapping = await queryDb<{ sync_status: string; sync_error: string }>(
      "SELECT sync_status, sync_error FROM calendar_event_mappings WHERE job_id = ?", [job.id]
    );
    expect(mapping[0].sync_status).toBe("failed");
    expect(mapping[0].sync_error).toBeTruthy();
  });
});

// Business-timezone / DST correctness — see mem:risks/google-calendar-timezone-default.
// buildEventInput()/toGoogleEventBody() (calendar-sync.ts + google-calendar.ts) were
// already correct: they send a plain local "YYYY-MM-DDTHH:mm:ss" (no offset, no `Z`)
// paired with an explicit IANA `timeZone`, exactly Google's documented contract for a
// timed event — never a `Date`/`toISOString()` UTC conversion.
//
// The original root cause (JOB-34) was that the only timezone source, hidden
// `_meta.timezone`, defaulted to 'UTC' with no admin-facing way to change it. This
// has since been promoted into the Global Settings `BUSINESS_TIMEZONE` key
// (migrations/0012), resolved through the single shared
// `src/server/business-timezone.ts#getBusinessTimezone()` — the same resolver
// `notification-dispatcher.ts`'s day-before reminder uses (see
// test/notification-dispatcher.test.ts and test/business-timezone.test.ts for that
// side and the resolver's own unit coverage). `calendar-sync.ts` no longer queries
// `_meta` on its own. The tests below prove: (1) a completely unconfigured
// environment now resolves to the safe 'America/Vancouver' default — never UTC —
// closing the fresh-environment risk at the Calendar-integration level; (2) the
// legacy `_meta.timezone` value is still honored as a backward-compat fallback for
// a database that hasn't published `BUSINESS_TIMEZONE` yet; (3) publishing
// `BUSINESS_TIMEZONE` (the normal admin path) correctly drives the Calendar payload,
// including changing it mid-stream (Vancouver -> Toronto) and every DST/boundary
// case — no code change to the payload-building logic itself was needed for any of
// this, only to which source it reads the zone id from.
describe("job sync — business timezone correctness (root cause + DST)", () => {
  async function connectedAdmin() {
    google = mockGoogleApi();
    const auth = await authHeaders();
    await connectGoogleCalendar((auth.headers as Record<string, string>).cookie);
    return auth;
  }

  it("CLOSES THE JOB-34 ROOT CAUSE: a completely unconfigured environment (no BUSINESS_TIMEZONE setting, _meta.timezone still at its schema-default 'UTC') resolves to the safe America/Vancouver default, never silently to UTC", async () => {
    await connectedAdmin();
    // resetDatabase() wipes global_settings (nothing published this run) but
    // deliberately never touches _meta — reset it back to the schema default
    // explicitly so this test is self-contained and doesn't depend on
    // execution order relative to the other tests below that set
    // _meta.timezone to a real value. This is the exact "fresh,
    // never-configured" condition that used to produce JOB-34's bug; it must
    // no longer resolve to UTC.
    await queryDb("UPDATE _meta SET value = 'UTC' WHERE key = 'timezone'");
    const timezoneRow = await queryDb<{ value: string }>("SELECT value FROM _meta WHERE key = 'timezone'");
    expect(timezoneRow[0].value).toBe("UTC");
    const settingsRow = await queryDb("SELECT 1 FROM global_settings WHERE key = 'BUSINESS_TIMEZONE'");
    expect(settingsRow).toHaveLength(0);

    const customer = await createCustomer();
    await createJob(customer.id, "2026-08-20", { scheduled_time: "11:00", duration: 90 });

    const [[, event]] = [...google.state.events.entries()];
    expect(event.start).toMatchObject({ dateTime: "2026-08-20T11:00:00", timeZone: "America/Vancouver" });
    expect(event.end).toMatchObject({ dateTime: "2026-08-20T12:30:00", timeZone: "America/Vancouver" });
  });

  it("backward compatibility: honors a legacy _meta.timezone value when BUSINESS_TIMEZONE hasn't been published yet", async () => {
    await connectedAdmin();
    await queryDb("UPDATE _meta SET value = 'America/Toronto' WHERE key = 'timezone'");

    const customer = await createCustomer();
    await createJob(customer.id, "2026-08-20", { scheduled_time: "11:00", duration: 90 });

    const [[, event]] = [...google.state.events.entries()];
    expect(event.start).toMatchObject({ dateTime: "2026-08-20T11:00:00", timeZone: "America/Toronto" });
  });

  it("a published BUSINESS_TIMEZONE takes priority over a legacy _meta.timezone value", async () => {
    await connectedAdmin();
    await queryDb("UPDATE _meta SET value = 'America/Toronto' WHERE key = 'timezone'");
    await setBusinessTimezone("America/Vancouver");

    const customer = await createCustomer();
    await createJob(customer.id, "2026-08-20", { scheduled_time: "11:00", duration: 90 });

    const [[, event]] = [...google.state.events.entries()];
    expect(event.start).toMatchObject({ dateTime: "2026-08-20T11:00:00", timeZone: "America/Vancouver" });
  });

  it("Toronto value propagates correctly as America/Toronto", async () => {
    await connectedAdmin();
    await setBusinessTimezone("America/Toronto");
    const customer = await createCustomer();
    await createJob(customer.id, "2026-08-20", { scheduled_time: "11:00", duration: 90 });

    const [[, event]] = [...google.state.events.entries()];
    expect(event.start).toMatchObject({ dateTime: "2026-08-20T11:00:00", timeZone: "America/Toronto" });
    expect(event.end).toMatchObject({ dateTime: "2026-08-20T12:30:00", timeZone: "America/Toronto" });
  });

  it("changing BUSINESS_TIMEZONE mid-stream changes the payload timezone on the NEXT sync, without touching the job's stored scheduled_date/scheduled_time or creating a duplicate event", async () => {
    const auth = await connectedAdmin();
    await setBusinessTimezone("America/Vancouver");
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20", { scheduled_time: "11:00", duration: 90 });
    const firstEventId = [...google.state.events.keys()][0];
    const [[, firstEvent]] = [...google.state.events.entries()];
    expect(firstEvent.start).toMatchObject({ timeZone: "America/Vancouver" });

    await setBusinessTimezone("America/Toronto");
    // The job's own wall-clock fields never change just because the global
    // setting changed — only a subsequent sync/update/retry picks up the new
    // zone (Section 14's documented change-time semantics).
    const unchangedJob = await queryDb<{ scheduled_date: string; scheduled_time: string }>(
      "SELECT scheduled_date, scheduled_time FROM jobs WHERE id = ?", [job.id]
    );
    expect(unchangedJob[0]).toMatchObject({ scheduled_date: "2026-08-20", scheduled_time: "11:00" });

    await post(`/api/integrations/google-calendar/jobs/${job.id}/retry`, {}, auth);

    expect(google.state.events.size).toBe(1);
    expect([...google.state.events.keys()][0]).toBe(firstEventId); // same event, not a duplicate
    const event = google.state.events.get(firstEventId)!;
    expect(event.start).toMatchObject({ dateTime: "2026-08-20T11:00:00", timeZone: "America/Toronto" });
  });

  /** Publishes BUSINESS_TIMEZONE through the real admin API — the normal,
   *  supported path an administrator uses (see the Global Settings UI /
   *  test/business-timezone.test.ts for the setting's own dedicated
   *  validation/RBAC/history coverage). */
  async function setBusinessTimezone(tz: string) {
    const auth = await authHeaders();
    const res = await post("/api/settings", {
      key: "BUSINESS_TIMEZONE", value: tz, data_type: "string", category: "business_operations",
    }, auth);
    expect(res.response.status).toBe(201);
  }

  it("summer (PDT): 11:00 local stays 11:00 in the Google payload, tagged with the IANA zone (never a fixed offset)", async () => {
    await connectedAdmin();
    await setBusinessTimezone("America/Vancouver");
    const customer = await createCustomer();
    await createJob(customer.id, "2026-08-20", { scheduled_time: "11:00", duration: 90 });

    const [[, event]] = [...google.state.events.entries()];
    expect(event.start).toMatchObject({ dateTime: "2026-08-20T11:00:00", timeZone: "America/Vancouver" });
    expect(event.end).toMatchObject({ dateTime: "2026-08-20T12:30:00", timeZone: "America/Vancouver" });
  });

  it("winter (PST): 11:00 local stays 11:00 in the Google payload — same IANA zone string as summer, DST resolution is left entirely to Google", async () => {
    await connectedAdmin();
    await setBusinessTimezone("America/Vancouver");
    const customer = await createCustomer();
    await createJob(customer.id, "2026-12-15", { scheduled_time: "11:00", duration: 90 });

    const [[, event]] = [...google.state.events.entries()];
    expect(event.start).toMatchObject({ dateTime: "2026-12-15T11:00:00", timeZone: "America/Vancouver" });
    expect(event.end).toMatchObject({ dateTime: "2026-12-15T12:30:00", timeZone: "America/Vancouver" });
  });

  it("odd-minute duration is preserved exactly (no rounding/timezone artifacts)", async () => {
    await connectedAdmin();
    await setBusinessTimezone("America/Vancouver");
    const customer = await createCustomer();
    await createJob(customer.id, "2026-08-20", { scheduled_time: "09:05", duration: 37 });

    const [[, event]] = [...google.state.events.entries()];
    expect(event.start).toMatchObject({ dateTime: "2026-08-20T09:05:00" });
    expect(event.end).toMatchObject({ dateTime: "2026-08-20T09:42:00" });
  });

  it("midnight-adjacent start (00:15) stays on the same local date", async () => {
    await connectedAdmin();
    await setBusinessTimezone("America/Vancouver");
    const customer = await createCustomer();
    await createJob(customer.id, "2026-08-20", { scheduled_time: "00:15", duration: 30 });

    const [[, event]] = [...google.state.events.entries()];
    expect(event.start).toMatchObject({ dateTime: "2026-08-20T00:15:00", timeZone: "America/Vancouver" });
    expect(event.end).toMatchObject({ dateTime: "2026-08-20T00:45:00", timeZone: "America/Vancouver" });
  });

  it("late-night start (23:30) stays on the same local date; only the computed end (correctly) rolls into the next calendar day", async () => {
    await connectedAdmin();
    await setBusinessTimezone("America/Vancouver");
    const customer = await createCustomer();
    await createJob(customer.id, "2026-08-20", { scheduled_time: "23:30", duration: 45 });

    const [[, event]] = [...google.state.events.entries()];
    expect(event.start).toMatchObject({ dateTime: "2026-08-20T23:30:00", timeZone: "America/Vancouver" });
    expect(event.end).toMatchObject({ dateTime: "2026-08-21T00:15:00", timeZone: "America/Vancouver" });
  });

  it("reschedule across a DST boundary (Aug -> Dec) preserves the 11:00 wall-clock time and updates the same event, not a new one", async () => {
    const auth = await connectedAdmin();
    await setBusinessTimezone("America/Vancouver");
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20", { scheduled_time: "11:00", duration: 90 });
    const firstEventId = [...google.state.events.keys()][0];

    await put(`/api/jobs/${job.id}`, { scheduled_date: "2026-12-15" }, auth);

    expect(google.state.events.size).toBe(1);
    expect([...google.state.events.keys()][0]).toBe(firstEventId); // deterministic id unchanged
    const event = google.state.events.get(firstEventId)!;
    expect(event.start).toMatchObject({ dateTime: "2026-12-15T11:00:00", timeZone: "America/Vancouver" });
  });

  it("changing only the time (update) preserves wall-clock semantics", async () => {
    const auth = await connectedAdmin();
    await setBusinessTimezone("America/Vancouver");
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20", { scheduled_time: "11:00", duration: 90 });

    await put(`/api/jobs/${job.id}`, { scheduled_time: "13:30" }, auth);

    expect(google.state.events.size).toBe(1);
    const [[, event]] = [...google.state.events.entries()];
    expect(event.start).toMatchObject({ dateTime: "2026-08-20T13:30:00", timeZone: "America/Vancouver" });
    expect(event.end).toMatchObject({ dateTime: "2026-08-20T15:00:00", timeZone: "America/Vancouver" });
  });

  it("cancellation/delete is unaffected by a non-UTC business timezone", async () => {
    const auth = await connectedAdmin();
    await setBusinessTimezone("America/Vancouver");
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20", { scheduled_time: "11:00" });
    expect(google.state.events.size).toBe(1);

    await post(`/api/jobs/${job.id}/transition`, { to_status: "cancelled" }, auth);

    expect(google.state.events.size).toBe(0);
    const mapping = await queryDb<{ sync_status: string }>(
      "SELECT sync_status FROM calendar_event_mappings WHERE job_id = ?", [job.id]
    );
    expect(mapping[0].sync_status).toBe("deleted");
  });
});

describe("token refresh and reauthorization", () => {
  it("refreshes an expired access token transparently before syncing", async () => {
    google = mockGoogleApi();
    const auth = await authHeaders();
    await connectGoogleCalendar((auth.headers as Record<string, string>).cookie);

    // Force the stored token to look expired.
    await queryDb("UPDATE calendar_integrations SET token_expires_at = '2000-01-01T00:00:00.000Z'");
    google.state.calls = [];

    const customer = await createCustomer();
    await createJob(customer.id, "2026-08-20");

    const tokenCalls = google.state.calls.filter((c) => c.url.startsWith("https://oauth2.googleapis.com/token"));
    expect(tokenCalls.length).toBeGreaterThan(0);
    expect(google.state.events.size).toBe(1);
  });

  it("marks the integration as needing reauthorization when the refresh token is rejected", async () => {
    google = mockGoogleApi();
    const auth = await authHeaders();
    await connectGoogleCalendar((auth.headers as Record<string, string>).cookie);
    await queryDb("UPDATE calendar_integrations SET token_expires_at = '2000-01-01T00:00:00.000Z'");
    google.state.failAllWithStatus = 401;

    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20");

    const status = await request<{ status: string }>("/api/integrations/google-calendar", auth);
    expect(status.body.status).toBe("needs_reauth");
    const mapping = await queryDb<{ sync_status: string }>(
      "SELECT sync_status FROM calendar_event_mappings WHERE job_id = ?", [job.id]
    );
    expect(mapping[0].sync_status).toBe("failed");
  });
});

describe("manual sync and retry", () => {
  it("Sync Now reports created/updated/failed counts across all jobs", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    await createJob(customer.id, "2026-08-20");
    await createJob(customer.id, "2026-08-21");

    google = mockGoogleApi();
    const cookie = (auth.headers as Record<string, string>).cookie;
    await connectGoogleCalendar(cookie);
    google.state.calls = [];

    const sync = await post<{ created: number; updated: number; failed: number; deleted: number }>(
      "/api/integrations/google-calendar/sync", {}, auth
    );
    expect(sync.response.status).toBe(200);
    expect(sync.body.created).toBe(2);
    expect(google.state.events.size).toBe(2);
  });

  it("retries a failed job sync and clears the failure once it succeeds", async () => {
    google = mockGoogleApi();
    const auth = await authHeaders();
    await connectGoogleCalendar((auth.headers as Record<string, string>).cookie);
    const customer = await createCustomer();
    google.state.failAllWithStatus = 500;
    const job = await createJob(customer.id, "2026-08-20");
    let mapping = await queryDb<{ sync_status: string }>("SELECT sync_status FROM calendar_event_mappings WHERE job_id = ?", [job.id]);
    expect(mapping[0].sync_status).toBe("failed");

    google.state.failAllWithStatus = null;
    const retry = await post<{ sync_status: string }>(`/api/integrations/google-calendar/jobs/${job.id}/retry`, {}, auth);

    expect(retry.body.sync_status).toBe("synced");
    mapping = await queryDb("SELECT sync_status FROM calendar_event_mappings WHERE job_id = ?", [job.id]);
    expect(mapping[0].sync_status).toBe("synced");
  });
});

describe("disconnect", () => {
  it("clears the stored integration and revokes the token, without touching jobs", async () => {
    google = mockGoogleApi();
    const auth = await authHeaders();
    await connectGoogleCalendar((auth.headers as Record<string, string>).cookie);
    const customer = await createCustomer();
    await createJob(customer.id, "2026-08-20");

    const res = await post<{ ok: boolean }>("/api/integrations/google-calendar/disconnect", {}, auth);
    expect(res.response.status).toBe(200);

    const status = await request<{ connected: boolean }>("/api/integrations/google-calendar", auth);
    expect(status.body.connected).toBe(false);

    const revokeCalls = google.state.calls.filter((c) => c.url.startsWith("https://oauth2.googleapis.com/revoke"));
    expect(revokeCalls.length).toBe(1);

    const jobs = await request<{ jobs: unknown[] }>("/api/jobs", auth);
    expect(jobs.body.jobs).toHaveLength(1);
  });

  it("does not create a new job or fail when creating jobs after disconnect", async () => {
    google = mockGoogleApi();
    const auth = await authHeaders();
    await connectGoogleCalendar((auth.headers as Record<string, string>).cookie);
    await post("/api/integrations/google-calendar/disconnect", {}, auth);

    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20");
    expect(job.id).toBeGreaterThan(0);
  });
});

describe("multi-user support", () => {
  it("keeps separate Google Calendar connections and events per user", async () => {
    google = mockGoogleApi();
    const adminAuth = await authHeaders();
    const adminCookie = (adminAuth.headers as Record<string, string>).cookie;

    const staff = await createUser({ email: "scheduler@example.test", password: "SchedulerPass1", role: "dispatcher" });
    const { cookie: staffCookie } = await loginAs("scheduler@example.test", "SchedulerPass1");

    google.state.userEmail = "admin-personal@gmail.com";
    await connectGoogleCalendar(adminCookie);
    google.state.userEmail = "scheduler-personal@gmail.com";
    await connectGoogleCalendar(staffCookie);

    const integrations = await queryDb<{ user_id: number; google_account_email: string }>(
      "SELECT user_id, google_account_email FROM calendar_integrations ORDER BY user_id"
    );
    expect(integrations).toHaveLength(2);
    expect(integrations.map((i) => i.google_account_email).sort()).toEqual([
      "admin-personal@gmail.com", "scheduler-personal@gmail.com",
    ]);

    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20");

    // One job, synced into two different users' calendars -> two distinct events.
    expect(google.state.events.size).toBe(2);
    const mappings = await queryDb<{ user_id: number; external_event_id: string }>(
      "SELECT user_id, external_event_id FROM calendar_event_mappings WHERE job_id = ?", [job.id]
    );
    expect(mappings).toHaveLength(2);
    expect(mappings[0].external_event_id).not.toBe(mappings[1].external_event_id);
    expect(mappings.map((m) => m.user_id).sort()).toEqual([1, staff.id].sort());
  });

  it("does not expose one user's Google account details to another user", async () => {
    google = mockGoogleApi({ userEmail: "admin-only@gmail.com" });
    const adminAuth = await authHeaders();
    await connectGoogleCalendar((adminAuth.headers as Record<string, string>).cookie);

    await createUser({ email: "other@example.test", password: "OtherPass123", role: "dispatcher" });
    const { cookie: otherCookie } = await loginAs("other@example.test", "OtherPass123");

    const status = await request<{ connected: boolean }>("/api/integrations/google-calendar", { headers: { cookie: otherCookie } });
    expect(status.body.connected).toBe(false);
    expect(JSON.stringify(status.body)).not.toContain("admin-only@gmail.com");
  });
});

describe("personal Google Calendar events stay untouched", () => {
  const PERSONAL_EVENT_ID = "personal-evt-doctor-appt";
  const personalEvent = () => ({
    summary: "Doctor Appointment",
    description: "",
    location: "",
    start: { dateTime: "2026-08-20T10:00:00", timeZone: "UTC" },
    end: { dateTime: "2026-08-20T11:00:00", timeZone: "UTC" },
  });

  function seedPersonalEvent() {
    google = mockGoogleApi({ events: new Map([[PERSONAL_EVENT_ID, personalEvent()]]) });
  }

  function callsAgainstPersonalEvent() {
    return google.state.calls.filter((c) => c.url.includes(PERSONAL_EVENT_ID));
  }

  it("never lists or reads a calendar's existing events — no such call exists in the sync path", async () => {
    seedPersonalEvent();
    const auth = await authHeaders();
    await connectGoogleCalendar((auth.headers as Record<string, string>).cookie);
    const customer = await createCustomer();
    await createJob(customer.id, "2026-08-20", { scheduled_time: "10:00" });

    const eventsCollectionGets = google.state.calls.filter(
      (c) => c.method === "GET" && /\/calendar\/v3\/calendars\/[^/]+\/events(\?|$)/.test(c.url)
    );
    expect(eventsCollectionGets).toHaveLength(0);
    // The personal event that was already on the calendar is still there, untouched.
    expect(google.state.events.get(PERSONAL_EVENT_ID)).toEqual(personalEvent());
  });

  it("does not modify or delete a personal event when a Field Scheduler job is created at the same time", async () => {
    seedPersonalEvent();
    const auth = await authHeaders();
    await connectGoogleCalendar((auth.headers as Record<string, string>).cookie);
    const customer = await createCustomer();

    // Same 10:00 AM slot as the personal "Doctor Appointment" — both must coexist.
    await createJob(customer.id, "2026-08-20", { scheduled_time: "10:00" });

    expect(google.state.events.size).toBe(2); // personal event + the new FS event
    expect(google.state.events.get(PERSONAL_EVENT_ID)).toEqual(personalEvent());
    expect(callsAgainstPersonalEvent()).toHaveLength(0);
  });

  it("does not modify the personal event when the Field Scheduler job at the same time is updated", async () => {
    seedPersonalEvent();
    const auth = await authHeaders();
    await connectGoogleCalendar((auth.headers as Record<string, string>).cookie);
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20", { scheduled_time: "10:00" });

    await put(`/api/jobs/${job.id}`, { notes: "Bring extra filters", scheduled_time: "10:30" }, auth);

    expect(google.state.events.get(PERSONAL_EVENT_ID)).toEqual(personalEvent());
    expect(callsAgainstPersonalEvent()).toHaveLength(0);
  });

  it("does not delete the personal event when the Field Scheduler job is cancelled", async () => {
    seedPersonalEvent();
    const auth = await authHeaders();
    await connectGoogleCalendar((auth.headers as Record<string, string>).cookie);
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20", { scheduled_time: "10:00" });

    await post(`/api/jobs/${job.id}/transition`, { to_status: "cancelled" }, auth);

    expect(google.state.events.has(PERSONAL_EVENT_ID)).toBe(true);
    expect(google.state.events.get(PERSONAL_EVENT_ID)).toEqual(personalEvent());
    expect(callsAgainstPersonalEvent()).toHaveLength(0);
  });

  it("does not delete the personal event when the Field Scheduler job is deleted outright", async () => {
    seedPersonalEvent();
    const auth = await authHeaders();
    await connectGoogleCalendar((auth.headers as Record<string, string>).cookie);
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20", { scheduled_time: "10:00" });
    expect(google.state.events.size).toBe(2);

    await del(`/api/jobs/${job.id}`, auth);

    expect(google.state.events.size).toBe(1);
    expect(google.state.events.get(PERSONAL_EVENT_ID)).toEqual(personalEvent());
    expect(callsAgainstPersonalEvent()).toHaveLength(0);
  });

  it("does not touch the personal event during a full Sync Now reconciliation", async () => {
    seedPersonalEvent();
    const auth = await authHeaders();
    const customer = await createCustomer();
    await createJob(customer.id, "2026-08-20", { scheduled_time: "10:00" });
    await createJob(customer.id, "2026-08-21", { scheduled_time: "14:00" });

    await connectGoogleCalendar((auth.headers as Record<string, string>).cookie);
    const sync = await post<{ created: number }>("/api/integrations/google-calendar/sync", {}, auth);

    expect(sync.body.created).toBe(2);
    expect(google.state.events.size).toBe(3); // 2 FS jobs + the untouched personal event
    expect(google.state.events.get(PERSONAL_EVENT_ID)).toEqual(personalEvent());
    expect(callsAgainstPersonalEvent()).toHaveLength(0);
  });

  it("does not delete any Google Calendar events, personal or otherwise, on disconnect", async () => {
    seedPersonalEvent();
    const auth = await authHeaders();
    await connectGoogleCalendar((auth.headers as Record<string, string>).cookie);
    const customer = await createCustomer();
    await createJob(customer.id, "2026-08-20", { scheduled_time: "10:00" });
    expect(google.state.events.size).toBe(2);

    await post("/api/integrations/google-calendar/disconnect", {}, auth);

    // Disconnect only revokes the token locally; it must never delete Google-side events.
    expect(google.state.events.size).toBe(2);
    expect(google.state.events.get(PERSONAL_EVENT_ID)).toEqual(personalEvent());
    const deleteCalls = google.state.calls.filter((c) => c.method === "DELETE" && c.url.includes("/events/"));
    expect(deleteCalls).toHaveLength(0);
  });

  it("a Google event without a Field Scheduler mapping can never be targeted by update or delete", async () => {
    seedPersonalEvent();
    const auth = await authHeaders();
    await connectGoogleCalendar((auth.headers as Record<string, string>).cookie);
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20", { scheduled_time: "10:00" });

    // Sanity: the job's own mapping points at a DIFFERENT event id than the personal one.
    const mapping = await queryDb<{ external_event_id: string }>(
      "SELECT external_event_id FROM calendar_event_mappings WHERE job_id = ?", [job.id]
    );
    expect(mapping[0].external_event_id).not.toBe(PERSONAL_EVENT_ID);

    // Exercise every mutating flow available; none of them may reference the personal id.
    await put(`/api/jobs/${job.id}`, { scheduled_time: "11:00" }, auth);
    await post(`/api/jobs/${job.id}/transition`, { to_status: "cancelled" }, auth);
    await post(`/api/jobs/${job.id}/transition`, { to_status: "scheduled" }, auth);
    await post(`/api/integrations/google-calendar/jobs/${job.id}/retry`, {}, auth);
    await post("/api/integrations/google-calendar/sync", {}, auth);

    expect(callsAgainstPersonalEvent()).toHaveLength(0);
    expect(google.state.events.get(PERSONAL_EVENT_ID)).toEqual(personalEvent());
  });

  it("only exposes calendar metadata (id/summary) for the picker, never event contents", async () => {
    seedPersonalEvent();
    const auth = await authHeaders();
    await connectGoogleCalendar((auth.headers as Record<string, string>).cookie);

    const res = await request<{ calendars: Record<string, unknown>[] }>("/api/integrations/google-calendar/calendars", auth);

    expect(res.response.status).toBe(200);
    for (const cal of res.body.calendars) {
      expect(Object.keys(cal).sort()).toEqual(["id", "primary", "summary"].filter((k) => k in cal).sort());
    }
    expect(JSON.stringify(res.body)).not.toContain("Doctor Appointment");
  });
});
