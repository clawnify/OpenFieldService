import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applySchema, authHeaders, createCustomer, createJob, executeStatements, mockGoogleApi,
  post, put, queryDb, request, requestRaw, resetDatabase, type GoogleMock,
} from "./helpers.js";

// Regression suite for the P0 fix documented in Serena as
// risks/google-calendar-sync-race. The invariant under test throughout:
//
//   ONE Field Scheduler Job -> MAXIMUM ONE Field Scheduler-owned Google
//   Calendar Event, regardless of concurrent requests, retries, network
//   uncertainty, manual Sync Now, or job transitions.
//
// test/calendar-sync.test.ts already covers: update-existing-event,
// cancellation/delete, reconnect/reauthorization, and multi-user isolation —
// not duplicated here, just re-run as part of the full suite to confirm they
// still hold after this fix.

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

async function connectGoogleCalendar(cookie: string) {
  const connectRes = await requestRaw("/api/integrations/google-calendar/connect", { headers: { cookie } });
  expect(connectRes.status).toBe(302);
  const authUrl = new URL(connectRes.headers.get("location")!);
  const state = authUrl.searchParams.get("state")!;
  const callbackRes = await requestRaw(
    `/api/integrations/google-calendar/callback?code=mock-auth-code&state=${state}`,
    { headers: { cookie } }
  );
  expect(callbackRes.status).toBe(302);
}

async function setup(insertDelayMs = 15) {
  google = mockGoogleApi({ insertDelayMs });
  const auth = await authHeaders();
  const cookie = (auth.headers as Record<string, string>).cookie;
  await connectGoogleCalendar(cookie);
  const customer = await createCustomer();
  const job = await createJob(customer.id, "2026-09-01");
  return { auth, cookie, job };
}

const retryUrl = (jobId: number) => `/api/integrations/google-calendar/jobs/${jobId}/retry`;

describe("concurrent requests for the same job", () => {
  it("two simultaneous sync requests for the same user/job create at most one event", async () => {
    const { auth, job } = await setup(20);
    google.state.calls = [];

    const [r1, r2] = await Promise.all([
      post(retryUrl(job.id), {}, auth),
      post(retryUrl(job.id), {}, auth),
    ]);
    expect(r1.response.status).toBe(200);
    expect(r2.response.status).toBe(200);

    expect(google.state.events.size).toBe(1);
    const postCalls = google.state.calls.filter((c) => c.method === "POST" && c.url.includes("/events"));
    expect(postCalls.length).toBeLessThanOrEqual(1); // the claim should stop the second caller before it ever reaches Google

    const mappings = await queryDb<{ external_event_id: string; sync_status: string }>(
      "SELECT external_event_id, sync_status FROM calendar_event_mappings WHERE job_id = ?", [job.id]
    );
    expect(mappings).toHaveLength(1);
    expect(mappings[0].sync_status).toBe("synced");
    expect(mappings[0].external_event_id).toBeTruthy();
  });

  it("automatic sync (job edit) and manual Sync Now overlapping never produce a duplicate", async () => {
    const { auth, job } = await setup(20);
    google.state.calls = [];

    const [editRes, syncRes] = await Promise.all([
      put(`/api/jobs/${job.id}`, { notes: "overlap test" }, auth),
      post("/api/integrations/google-calendar/sync", {}, auth),
    ]);
    expect(editRes.response.status).toBe(200);
    expect(syncRes.response.status).toBe(200);

    expect(google.state.events.size).toBe(1);
    const mappings = await queryDb("SELECT * FROM calendar_event_mappings WHERE job_id = ?", [job.id]);
    expect(mappings).toHaveLength(1);
  });

  it("automatic sync (job edit) and a manual retry overlapping never produce a duplicate", async () => {
    const { auth, job } = await setup(20);
    google.state.calls = [];

    const [editRes, retryRes] = await Promise.all([
      put(`/api/jobs/${job.id}`, { notes: "overlap test 2" }, auth),
      post(retryUrl(job.id), {}, auth),
    ]);
    expect(editRes.response.status).toBe(200);
    expect(retryRes.response.status).toBe(200);

    expect(google.state.events.size).toBe(1);
  });

  it("three-way overlap (edit + Sync Now + retry) still converges on exactly one event", async () => {
    const { auth, job } = await setup(20);

    await Promise.all([
      put(`/api/jobs/${job.id}`, { notes: "three way" }, auth),
      post("/api/integrations/google-calendar/sync", {}, auth),
      post(retryUrl(job.id), {}, auth),
    ]);

    expect(google.state.events.size).toBe(1);
    const mappings = await queryDb("SELECT * FROM calendar_event_mappings WHERE job_id = ?", [job.id]);
    expect(mappings).toHaveLength(1);
  });
});

describe("retry after an uncertain Google API response", () => {
  it("does not create a duplicate when Google's insert succeeded but our mapping write never happened", async () => {
    const { job } = await setup(0);
    const auth = await authHeaders();
    const me = await request<{ user: { id: number } }>("/api/auth/me", auth);
    const userId = me.body.user.id;

    // Simulate the crash: the very first sync (in setup()) already created the
    // real mapping — wipe it to simulate "the mapping write never happened",
    // while the Google-side event (already created, keyed by the deterministic
    // id) is left exactly as-is. This is the state a Worker crash between a
    // successful Google insert and the local upsertMapping() call would leave.
    await executeStatements(["DELETE FROM calendar_event_mappings"]);
    expect(google.state.events.size).toBe(1); // still exists on Google's side

    const retry = await post<{ sync_status: string }>(retryUrl(job.id), {}, auth);
    expect(retry.response.status).toBe(200);

    // No second event: the retried insert hit Google's 409 for the same
    // deterministic id and reconciled instead of creating a duplicate.
    expect(google.state.events.size).toBe(1);
    expect(retry.body.sync_status).toBe("synced");

    const mappings = await queryDb<{ external_event_id: string }>(
      "SELECT external_event_id FROM calendar_event_mappings WHERE job_id = ?", [job.id]
    );
    expect(mappings).toHaveLength(1);
    void userId;
  });

  it("reconciles via 409 even when the local mapping says 'deleted' but the Google event still physically exists", async () => {
    const { job } = await setup(0);
    const auth = await authHeaders();

    // Force the create branch to run again despite an existing Google event:
    // mark the mapping as "deleted" without actually removing the Google-side
    // event (e.g. a delete call that silently failed, or a race with a
    // cancel). The next sync must not blindly re-POST into a duplicate.
    await executeStatements(["UPDATE calendar_event_mappings SET sync_status = 'deleted'"]);
    expect(google.state.events.size).toBe(1);

    const retry = await post<{ sync_status: string }>(retryUrl(job.id), {}, auth);
    expect(retry.response.status).toBe(200);
    expect(retry.body.sync_status).toBe("synced");
    expect(google.state.events.size).toBe(1); // still exactly one — reconciled, not duplicated
  });
});

describe("stale claim recovery", () => {
  it("steals an abandoned claim (crashed holder) instead of skipping forever", async () => {
    const { auth, job } = await setup(0);
    const me = await request<{ user: { id: number } }>("/api/auth/me", auth);

    // Simulate a crashed sync that claimed the pair and never released it,
    // long enough ago to count as abandoned. Must seed claimed_at in the same
    // ISO format production code actually writes (new Date().toISOString()) —
    // SQLite's own datetime('now', ...) produces a space-separated string with
    // no timezone marker, which JS parses as LOCAL time, not UTC, and silently
    // gives a nonsense (often future-looking) staleness age. Same class of bug
    // as the Phase 1 global_settings effective_from gotcha.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await executeStatements([
      `INSERT INTO calendar_sync_claims (user_id, job_id, claimed_at) VALUES (${me.body.user.id}, ${job.id}, '${oneHourAgo}')`,
    ]);

    const retry = await post<{ sync_status: string }>(retryUrl(job.id), {}, auth);
    expect(retry.response.status).toBe(200);
    expect(retry.body.sync_status).toBe("synced"); // proceeded despite the stale claim, not skipped

    const claims = await queryDb("SELECT * FROM calendar_sync_claims WHERE job_id = ?", [job.id]);
    expect(claims).toHaveLength(0); // released after the (stolen) sync completed
  });

  it("does NOT steal a fresh (non-stale) claim — proves skip behavior is real, not a no-op", async () => {
    const { auth, job } = await setup(0);
    const me = await request<{ user: { id: number } }>("/api/auth/me", auth);

    await executeStatements([
      `INSERT INTO calendar_sync_claims (user_id, job_id, claimed_at) VALUES (${me.body.user.id}, ${job.id}, '${new Date().toISOString()}')`,
    ]);
    const before = google.state.calls.length;

    const retry = await post(retryUrl(job.id), {}, auth);
    expect(retry.response.status).toBe(200); // the route itself still succeeds...

    // ...but no Google call was made — the sync was skipped, not performed.
    expect(google.state.calls.length).toBe(before);

    await executeStatements(["DELETE FROM calendar_sync_claims"]); // cleanup so it doesn't leak into other assertions
  });
});

describe("the invariant, exercised end to end", () => {
  it("one job survives create + concurrent edits + Sync Now + retry + reconnect with exactly one event throughout", async () => {
    const { auth, cookie, job } = await setup(15);
    expect(google.state.events.size).toBe(1);

    await Promise.all([
      put(`/api/jobs/${job.id}`, { notes: "a" }, auth),
      put(`/api/jobs/${job.id}`, { notes: "b" }, auth),
      post("/api/integrations/google-calendar/sync", {}, auth),
    ]);
    expect(google.state.events.size).toBe(1);

    await post(`/api/jobs/${job.id}/transition`, { to_status: "in_progress" }, auth);
    expect(google.state.events.size).toBe(1);

    // Reconnect (disconnect + reconnect) must not touch existing Google-side
    // events, and the next sync after reconnecting must still land on the
    // same single event via the deterministic id, not create a second one.
    await post("/api/integrations/google-calendar/disconnect", {}, auth);
    await connectGoogleCalendar(cookie);
    await post(retryUrl(job.id), {}, auth);
    expect(google.state.events.size).toBe(1);

    const mappings = await queryDb("SELECT * FROM calendar_event_mappings WHERE job_id = ?", [job.id]);
    expect(mappings).toHaveLength(1);
  });
});
