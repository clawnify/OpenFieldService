import { get, query, run } from "./db.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { getBusinessTimezone } from "./business-timezone.js";
import {
  GoogleApiError, buildDeterministicEventId, deleteEvent, insertEvent, refreshAccessToken, updateEvent,
  type GoogleEventInput, type GoogleOAuthEnv,
} from "./google-calendar.js";
import { STATUS_LABELS } from "./workflow.js";

export interface CalendarSyncEnv extends GoogleOAuthEnv {
  TOKEN_ENCRYPTION_KEY: string;
}

export interface IntegrationRow {
  user_id: number;
  google_calendar_id: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  token_expires_at: string;
  sync_enabled: number;
}

interface SyncJobRow {
  id: number;
  identifier: string;
  status: string;
  scheduled_date: string;
  scheduled_time: string;
  duration: number;
  address: string;
  notes: string;
  organization_id: number;
  customer_name: string | null;
  technician_name: string | null;
  service_type_name: string | null;
}

/** Pure wall-clock arithmetic — deliberately never touches a real timezone, so
 *  adding a job's duration can never shift a date/time across a DST boundary. */
function addMinutes(date: string, time: string, minutes: number): { date: string; time: string } {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, hh, mm));
  dt.setUTCMinutes(dt.getUTCMinutes() + minutes);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`,
    time: `${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}`,
  };
}

function buildEventInput(job: SyncJobRow, timeZone: string): GoogleEventInput {
  const title = [job.service_type_name, job.customer_name].filter(Boolean).join(" — ") || job.identifier;
  const end = addMinutes(job.scheduled_date, job.scheduled_time, job.duration || 60);
  const lines = [
    `Field Scheduler Job: ${job.identifier}`,
    `Customer: ${job.customer_name || "—"}`,
    `Technician: ${job.technician_name || "Unassigned"}`,
    `Status: ${STATUS_LABELS[job.status] || job.status}`,
  ];
  if (job.notes) lines.push("", "Notes:", job.notes);
  return {
    summary: title,
    description: lines.join("\n"),
    location: job.address || "",
    startDateTime: `${job.scheduled_date}T${job.scheduled_time}:00`,
    endDateTime: `${end.date}T${end.time}:00`,
    timeZone,
  };
}

export async function ensureValidAccessToken(env: CalendarSyncEnv, integration: IntegrationRow): Promise<string> {
  const expiresAt = new Date(integration.token_expires_at || 0).getTime();
  if (Date.now() < expiresAt - 60_000) {
    return decryptSecret(integration.access_token_encrypted, env.TOKEN_ENCRYPTION_KEY);
  }
  if (!integration.refresh_token_encrypted) {
    throw new GoogleApiError("no_refresh_token", 401, "No refresh token on file; reauthorization required");
  }
  const refreshToken = await decryptSecret(integration.refresh_token_encrypted, env.TOKEN_ENCRYPTION_KEY);
  const tokens = await refreshAccessToken(env, refreshToken);
  const accessEnc = await encryptSecret(tokens.access_token, env.TOKEN_ENCRYPTION_KEY);
  const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  await run(
    "UPDATE calendar_integrations SET access_token_encrypted = ?, token_expires_at = ?, status = 'connected', updated_at = datetime('now') WHERE user_id = ?",
    [accessEnc, newExpiresAt, integration.user_id]
  );
  return tokens.access_token;
}

/** Looks up the user's integration and returns a valid (refreshed if needed) access
 *  token. Throws GoogleApiError if not connected or reauthorization is required —
 *  callers that need a specific "not connected" vs. "expired" distinction should
 *  catch and inspect the error rather than relying on a sync side-effect. */
export async function getValidAccessTokenForUser(env: CalendarSyncEnv, userId: number): Promise<string> {
  const integration = await get<IntegrationRow>(
    "SELECT user_id, google_calendar_id, access_token_encrypted, refresh_token_encrypted, token_expires_at, sync_enabled FROM calendar_integrations WHERE user_id = ?",
    [userId]
  );
  if (!integration) throw new GoogleApiError("not_connected", 400, "Google Calendar is not connected");
  return ensureValidAccessToken(env, integration);
}

async function markIntegrationNeedsReauth(userId: number): Promise<void> {
  await run(
    "UPDATE calendar_integrations SET status = 'needs_reauth', updated_at = datetime('now') WHERE user_id = ?",
    [userId]
  );
}

async function upsertMapping(
  userId: number, jobId: number, calendarId: string,
  fields: { external_event_id?: string; sync_status: string; sync_error?: string; synced?: boolean }
): Promise<void> {
  const externalEventId = fields.external_event_id ?? "";
  const syncError = fields.sync_error ?? "";
  const lastSyncedAt = fields.synced ? new Date().toISOString() : null;
  await run(
    `INSERT INTO calendar_event_mappings (user_id, job_id, provider, calendar_id, external_event_id, last_synced_at, sync_status, sync_error, updated_at)
     VALUES (?, ?, 'google', ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, job_id) DO UPDATE SET
       calendar_id = excluded.calendar_id,
       external_event_id = CASE WHEN excluded.external_event_id != '' THEN excluded.external_event_id ELSE calendar_event_mappings.external_event_id END,
       last_synced_at = COALESCE(excluded.last_synced_at, calendar_event_mappings.last_synced_at),
       sync_status = excluded.sync_status,
       sync_error = excluded.sync_error,
       updated_at = datetime('now')`,
    [userId, jobId, calendarId, externalEventId, lastSyncedAt, fields.sync_status, syncError]
  );
}

export type SyncOutcome = "created" | "updated" | "deleted" | "failed" | "not_connected" | "skipped";

// How long a claim may be held before a subsequent caller treats it as
// abandoned (the holder crashed/timed out before reaching the `finally`
// release) and steals it rather than skipping forever. Comfortably above any
// realistic sync duration (a couple of HTTPS calls to Google).
const CLAIM_STALE_MS = 30_000;

/** D1-only mutual-exclusion for one (user_id, job_id) pair — defense in depth
 *  alongside the deterministic event id (the primary fix). A single D1 INSERT
 *  against a PRIMARY KEY is atomic: of two concurrent claim attempts for the
 *  same pair, exactly one succeeds. The loser should skip this sync attempt
 *  rather than proceed — it's not lost work, the job will be synced again on
 *  its next edit (or a later "Sync Now"), same as any other best-effort sync. */
async function tryClaimSync(userId: number, jobId: number): Promise<boolean> {
  const now = new Date().toISOString();
  try {
    await run("INSERT INTO calendar_sync_claims (user_id, job_id, claimed_at) VALUES (?, ?, ?)", [userId, jobId, now]);
    return true;
  } catch {
    const existing = await get<{ claimed_at: string }>(
      "SELECT claimed_at FROM calendar_sync_claims WHERE user_id = ? AND job_id = ?", [userId, jobId]
    );
    if (!existing) return false; // race on the race — someone else claimed/released between our INSERT and this SELECT
    if (Date.now() - new Date(existing.claimed_at).getTime() <= CLAIM_STALE_MS) return false;
    // Stale — the previous holder never released. Steal it.
    await run("UPDATE calendar_sync_claims SET claimed_at = ? WHERE user_id = ? AND job_id = ?", [now, userId, jobId]);
    return true;
  }
}

async function releaseSyncClaim(userId: number, jobId: number): Promise<void> {
  await run("DELETE FROM calendar_sync_claims WHERE user_id = ? AND job_id = ?", [userId, jobId]);
}

/** Syncs one job into one user's Google Calendar. Never throws — failures are
 *  recorded on the mapping row and reported back via the outcome.
 *
 *  Idempotency/concurrency (see Serena risks/google-calendar-sync-race for the
 *  full writeup this implements): every insert uses a deterministic event id
 *  derived from (userId, jobId) — see buildDeterministicEventId() — so Google
 *  itself rejects a duplicate creation attempt (concurrent OR retried) with a
 *  409, which is treated as "reconcile," not a failure. The D1 claim above is
 *  a second, independent layer that stops two concurrent callers from even
 *  both reaching the Google API for the same pair — but the deterministic id
 *  is what actually protects against a duplicate *Google-side* event; do not
 *  rely on the claim alone (a crashed holder, a claim-table bug, or a future
 *  caller that forgets to claim would otherwise still be exposed). */
export async function syncJobForUser(env: CalendarSyncEnv, userId: number, jobId: number): Promise<SyncOutcome> {
  const integration = await get<IntegrationRow>(
    "SELECT user_id, google_calendar_id, access_token_encrypted, refresh_token_encrypted, token_expires_at, sync_enabled FROM calendar_integrations WHERE user_id = ?",
    [userId]
  );
  if (!integration || !integration.sync_enabled) return "not_connected";

  if (!(await tryClaimSync(userId, jobId))) return "skipped";

  try {
    return await syncJobForUserClaimed(env, userId, jobId, integration);
  } finally {
    await releaseSyncClaim(userId, jobId);
  }
}

async function syncJobForUserClaimed(
  env: CalendarSyncEnv, userId: number, jobId: number, integration: IntegrationRow
): Promise<SyncOutcome> {
  const deterministicId = buildDeterministicEventId(userId, jobId);

  const mapping = await get<{ external_event_id: string; sync_status: string }>(
    "SELECT external_event_id, sync_status FROM calendar_event_mappings WHERE user_id = ? AND job_id = ?",
    [userId, jobId]
  );

  const job = await get<SyncJobRow>(
    `SELECT j.id, j.identifier, j.status, j.scheduled_date, j.scheduled_time, j.duration, j.address, j.notes,
            j.organization_id,
            c.name as customer_name, t.name as technician_name, st.name as service_type_name
     FROM jobs j
     LEFT JOIN customers c ON j.customer_id = c.id
     LEFT JOIN technicians t ON j.technician_id = t.id
     LEFT JOIN service_types st ON j.service_type_id = st.id
     WHERE j.id = ?`,
    [jobId]
  );

  try {
    const accessToken = await ensureValidAccessToken(env, integration);

    // Job no longer exists locally (hard-deleted) — remove its Google event, if
    // any. Always targets the deterministic id, not just whatever the mapping
    // row happens to say: a prior insert that succeeded on Google but crashed
    // before the mapping write would otherwise leave an orphaned event behind
    // forever. deleteEvent() is already 404/410-tolerant, so this is safe to
    // call even when no event actually exists under that id.
    if (!job) {
      await deleteEvent(accessToken, integration.google_calendar_id, deterministicId);
      await upsertMapping(userId, jobId, integration.google_calendar_id, { sync_status: "deleted", synced: true });
      return "deleted";
    }

    // Cancelled jobs: remove the event so no stale scheduled event is left behind.
    // If the job is later un-cancelled, the "deleted" mapping below makes the
    // next sync create (or, via the deterministic id, transparently reconcile)
    // a fresh event rather than patch a removed one.
    if (job.status === "cancelled") {
      await deleteEvent(accessToken, integration.google_calendar_id, deterministicId);
      await upsertMapping(userId, jobId, integration.google_calendar_id, { sync_status: "deleted", synced: true });
      return "deleted";
    }

    const timeZone = await getBusinessTimezone(job.organization_id);
    const eventInput = buildEventInput(job, timeZone);

    if (mapping?.external_event_id && mapping.sync_status !== "deleted") {
      await updateEvent(accessToken, integration.google_calendar_id, mapping.external_event_id, eventInput);
      await upsertMapping(userId, jobId, integration.google_calendar_id, {
        external_event_id: mapping.external_event_id, sync_status: "synced", synced: true,
      });
      return "updated";
    }

    try {
      const created = await insertEvent(accessToken, integration.google_calendar_id, eventInput, deterministicId);
      await upsertMapping(userId, jobId, integration.google_calendar_id, {
        external_event_id: created.id, sync_status: "synced", synced: true,
      });
      return "created";
    } catch (err) {
      // Reconciliation, not a failure: an event under this deterministic id
      // already exists on Google — either a genuinely concurrent request won
      // the race, or an earlier attempt succeeded on Google's side but crashed
      // before we recorded it locally (the "retry after uncertain response"
      // case). Either way the event is real and it's ours (only Field
      // Scheduler ever mints an id in this fs job<id>u<user id> shape) — adopt
      // it and patch it with current data so the surviving event is correct,
      // rather than erroring or creating a second one.
      if (err instanceof GoogleApiError && err.isConflict) {
        await updateEvent(accessToken, integration.google_calendar_id, deterministicId, eventInput);
        await upsertMapping(userId, jobId, integration.google_calendar_id, {
          external_event_id: deterministicId, sync_status: "synced", synced: true,
        });
        return "updated";
      }
      throw err;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await upsertMapping(userId, jobId, integration.google_calendar_id, { sync_status: "failed", sync_error: message });
    if (err instanceof GoogleApiError && err.isAuthError) {
      await markIntegrationNeedsReauth(userId);
    }
    return "failed";
  }
}

/** Fans a single job's change out to every user with sync enabled. Isolated per
 *  user and never throws — a Google failure must never block a local job write.
 *
 *  Phase 11.6: scoped to the job's own organization. Without this, a job
 *  create/edit/status-change in ANY organization would push that job's
 *  customer/technician/notes data into the personal Google Calendar of EVERY
 *  user platform-wide who has sync enabled, regardless of which organization
 *  they belong to — the same bug class as `syncAllJobsForUser`'s fixed P0,
 *  just triggered automatically on every job mutation instead of "Sync Now". */
export async function syncJobToAllConnectedUsers(env: CalendarSyncEnv, jobId: number): Promise<void> {
  try {
    const job = await get<{ organization_id: number }>("SELECT organization_id FROM jobs WHERE id = ?", [jobId]);
    if (!job) return;
    const integrations = await query<{ user_id: number }>(
      `SELECT ci.user_id FROM calendar_integrations ci
       JOIN users u ON u.id = ci.user_id
       WHERE ci.sync_enabled = 1 AND u.organization_id = ?`,
      [job.organization_id]
    );
    for (const { user_id } of integrations) {
      await syncJobForUser(env, user_id, jobId).catch(() => "failed" as const);
    }
  } catch {
    // Sync is best-effort and must never affect the caller's local write.
  }
}

/** Removes the Google event for every connected user, for this job. Must be
 *  called BEFORE the job row is deleted locally — calendar_event_mappings.job_id has
 *  ON DELETE CASCADE, so once the job row is gone the mapping is gone with it.
 *  Never throws.
 *
 *  Iterates every user with sync enabled (not just those with an existing
 *  mapping row) and always targets the deterministic event id: a mapping row
 *  can be missing even though a Google-side event exists, if an earlier insert
 *  succeeded on Google but crashed before the mapping write ever happened —
 *  without this, that event would be orphaned forever. deleteEvent() is
 *  404/410-tolerant, so attempting a delete for a user/job pair with no actual
 *  event is a harmless no-op.
 *
 *  Phase 11.6: scoped to the job's own organization (job row still exists at
 *  call time — this must run before the local delete, per the caller's own
 *  contract above), same reasoning as `syncJobToAllConnectedUsers`. Without
 *  this, deleting a job in ANY organization would attempt to delete a
 *  same-id-shaped event out of EVERY other organization's connected users'
 *  calendars too (harmless in practice since the deterministic id is
 *  namespaced by this job's own id, but still an unauthorized cross-org
 *  provider call this actor has no right to trigger). */
export async function deleteJobFromAllCalendars(env: CalendarSyncEnv, jobId: number): Promise<void> {
  try {
    const job = await get<{ organization_id: number }>("SELECT organization_id FROM jobs WHERE id = ?", [jobId]);
    if (!job) return;
    const integrations = await query<{ user_id: number }>(
      `SELECT ci.user_id FROM calendar_integrations ci
       JOIN users u ON u.id = ci.user_id
       WHERE ci.sync_enabled = 1 AND u.organization_id = ?`,
      [job.organization_id]
    );
    for (const { user_id } of integrations) {
      try {
        const integration = await get<IntegrationRow>(
          "SELECT user_id, google_calendar_id, access_token_encrypted, refresh_token_encrypted, token_expires_at, sync_enabled FROM calendar_integrations WHERE user_id = ?",
          [user_id]
        );
        if (!integration) continue;
        const accessToken = await ensureValidAccessToken(env, integration);
        await deleteEvent(accessToken, integration.google_calendar_id, buildDeterministicEventId(user_id, jobId));
      } catch {
        // Best-effort per user; the caller deletes the job locally regardless.
      }
    }
  } catch {
    // Never block a local job deletion.
  }
}

export interface SyncNowResult {
  created: number;
  updated: number;
  deleted: number;
  failed: number;
}

/** Manual "Sync Now": reconciles every job against this user's calendar.
 *
 *  Phase 11.5: scoped to the calling user's own organization. `syncJobForUser`
 *  -> `syncJobForUserClaimed`'s job lookup has no organization filter of its
 *  own (it's an internal engine function, not a route — see the identical
 *  note on the `/retry` route in index.ts), so this bulk fan-out is the
 *  caller that MUST filter before ever calling it. Without this, every job
 *  from every organization would be pushed into this user's personal Google
 *  Calendar. */
export async function syncAllJobsForUser(env: CalendarSyncEnv, userId: number): Promise<SyncNowResult> {
  const result: SyncNowResult = { created: 0, updated: 0, deleted: 0, failed: 0 };
  const integration = await get<{ sync_enabled: number }>(
    "SELECT sync_enabled FROM calendar_integrations WHERE user_id = ?", [userId]
  );
  if (!integration || !integration.sync_enabled) return result;

  const actor = await get<{ organization_id: number }>("SELECT organization_id FROM users WHERE id = ?", [userId]);
  if (!actor) return result;

  const jobs = await query<{ id: number }>(
    "SELECT id FROM jobs WHERE organization_id = ? ORDER BY scheduled_date ASC", [actor.organization_id]
  );
  for (const { id } of jobs) {
    const outcome = await syncJobForUser(env, userId, id);
    switch (outcome) {
      case "created": result.created++; break;
      case "updated": result.updated++; break;
      case "deleted": result.deleted++; break;
      case "failed": result.failed++; break;
      case "not_connected": break;
      case "skipped": break; // another sync for this job/user was already in flight
    }
  }
  return result;
}
