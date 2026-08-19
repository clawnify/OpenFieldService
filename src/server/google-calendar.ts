/**
 * Thin client for Google's official OAuth 2.0 and Calendar API v3 REST endpoints.
 * Deliberately uses plain `fetch` rather than the `googleapis` SDK — that SDK
 * targets Node.js and is not a good fit for the Workers runtime; the REST API
 * it wraps is the same official surface, so this is not a "fake" integration.
 */

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const GOOGLE_CALENDAR_LIST_URL = "https://www.googleapis.com/calendar/v3/users/me/calendarList";
const googleEventsUrl = (calendarId: string) =>
  `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;

// Minimum scopes needed: read the user's calendar list (to let them pick one) and
// create/update/delete events (to sync jobs) — not full calendar management, and
// `openid email` only to label the connected account in the UI.
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
].join(" ");

export interface GoogleOAuthEnv {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REDIRECT_URI: string;
}

export class GoogleApiError extends Error {
  code: string;
  status: number;
  detail: string;

  constructor(code: string, status: number, detail: string) {
    super(`${code} (HTTP ${status}): ${detail}`);
    this.name = "GoogleApiError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }

  /** True when Google says the credential itself is bad (expired/revoked) — caller should prompt reauth. */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** True when a client-supplied event id (see buildDeterministicEventId) collided
   *  with an event that already exists — not a failure, a reconciliation signal.
   *  See src/server/calendar-sync.ts syncJobForUser() for how this is handled. */
  get isConflict(): boolean {
    return this.status === 409;
  }
}

/**
 * A stable, predictable Google Calendar event id for one Field Scheduler job in
 * one connected user's calendar — the core of the idempotency fix documented in
 * Serena (risks/google-calendar-sync-race). Passing this as the event's `id` on
 * insert means Google itself rejects a second concurrent/retried creation
 * attempt for the same (userId, jobId) with an HTTP 409 instead of silently
 * creating a duplicate event — the dedup authority lives with Google, not with
 * our own bookkeeping (which is exactly where UNIQUE(user_id, job_id) on
 * calendar_event_mappings falls short: that constraint only ever governs our
 * local mapping row, enforced *after* Google's event already exists).
 *
 * Google's custom event id must match /^[a-v0-9]{5,1024}$/ (lowercase base32hex
 * alphabet only — no hyphens/underscores). "fsjob{jobId}u{userId}" satisfies
 * that for any real id values Field Scheduler will ever have.
 */
export function buildDeterministicEventId(userId: number, jobId: number): string {
  return `fsjob${jobId}u${userId}`;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}

export function buildAuthUrl(env: GoogleOAuthEnv, state: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: GOOGLE_SCOPES,
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

export async function exchangeCodeForTokens(env: GoogleOAuthEnv, code: string): Promise<GoogleTokenResponse> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.GOOGLE_REDIRECT_URI,
      code,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new GoogleApiError("token_exchange_failed", res.status, await safeText(res));
  return res.json();
}

export async function refreshAccessToken(env: GoogleOAuthEnv, refreshToken: string): Promise<GoogleTokenResponse> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new GoogleApiError("token_refresh_failed", res.status, await safeText(res));
  return res.json();
}

/** Best-effort revoke; failures are swallowed since disconnect must always succeed locally. */
export async function revokeToken(token: string): Promise<void> {
  try {
    await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: "POST" });
  } catch {
    // Network failure revoking with Google shouldn't block a local disconnect.
  }
}

export async function fetchGoogleAccountEmail(accessToken: string): Promise<string> {
  const res = await fetch(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new GoogleApiError("userinfo_failed", res.status, await safeText(res));
  const data = await res.json() as { email?: string };
  return data.email || "";
}

export interface GoogleCalendarListEntry {
  id: string;
  summary: string;
  primary?: boolean;
}

export async function listCalendars(accessToken: string): Promise<GoogleCalendarListEntry[]> {
  const res = await fetch(GOOGLE_CALENDAR_LIST_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new GoogleApiError("list_calendars_failed", res.status, await safeText(res));
  const data = await res.json() as { items?: GoogleCalendarListEntry[] };
  return (data.items || []).map((c) => ({ id: c.id, summary: c.summary, primary: c.primary }));
}

export interface GoogleEventInput {
  summary: string;
  description: string;
  location: string;
  /** Local wall-clock datetime, no offset, e.g. "2026-08-20T10:00:00" — paired with timeZone. */
  startDateTime: string;
  endDateTime: string;
  timeZone: string;
}

function toGoogleEventBody(event: GoogleEventInput) {
  return {
    summary: event.summary,
    description: event.description,
    location: event.location,
    start: { dateTime: event.startDateTime, timeZone: event.timeZone },
    end: { dateTime: event.endDateTime, timeZone: event.timeZone },
  };
}

/** `eventId`, when given, is sent as Google's client-supplied `id` — see
 *  buildDeterministicEventId(). A 409 response means an event with that id
 *  already exists; thrown as GoogleApiError with isConflict=true so the caller
 *  can reconcile (see syncJobForUser) instead of treating it as a failure. */
export async function insertEvent(
  accessToken: string, calendarId: string, event: GoogleEventInput, eventId?: string
): Promise<{ id: string }> {
  const res = await fetch(googleEventsUrl(calendarId), {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...toGoogleEventBody(event), ...(eventId ? { id: eventId } : {}) }),
  });
  if (!res.ok) throw new GoogleApiError("event_insert_failed", res.status, await safeText(res));
  return res.json();
}

export async function updateEvent(
  accessToken: string, calendarId: string, eventId: string, event: GoogleEventInput
): Promise<{ id: string }> {
  const res = await fetch(`${googleEventsUrl(calendarId)}/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(toGoogleEventBody(event)),
  });
  if (!res.ok) throw new GoogleApiError("event_update_failed", res.status, await safeText(res));
  return res.json();
}

export async function deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void> {
  const res = await fetch(`${googleEventsUrl(calendarId)}/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  // 404/410 means it's already gone from Google's side — deletion is idempotent, not an error.
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new GoogleApiError("event_delete_failed", res.status, await safeText(res));
  }
}
