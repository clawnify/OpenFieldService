# Google Calendar integration — setup

Field Scheduler syncs scheduled jobs into each user's own Google Calendar. This
requires a Google Cloud OAuth client. Nothing in this repo works against Google
until you create one and configure the values below — no credentials are
included or committed.

## 1. Create a Google Cloud project

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create
   a new project (or pick an existing one).
2. Enable the **Google Calendar API**: APIs & Services → Library → search
   "Google Calendar API" → Enable.

## 2. Configure the OAuth consent screen

APIs & Services → OAuth consent screen.

- User type: **External** (or **Internal** if every Field Scheduler user is in
  your Google Workspace organization).
- App name, support email, developer contact — whatever fits your business.
- Scopes: add
  - `openid`
  - `.../auth/userinfo.email`
  - `https://www.googleapis.com/auth/calendar.readonly`
  - `https://www.googleapis.com/auth/calendar.events`

  These are the minimum scopes the integration requests — enough to list the
  user's calendars and create/update/delete events, nothing broader.
- While the app is in "Testing" publishing status, add every Google account
  that will connect (admins, schedulers, technicians) as a test user, or the
  consent screen will reject them. Move to "In production" when ready for
  general use (Google may require verification for sensitive scopes).

## 3. Create an OAuth client

APIs & Services → Credentials → Create Credentials → OAuth client ID.

- Application type: **Web application**.
- Authorized redirect URIs — add the exact callback URL for each environment
  you run:
  - Local dev: `http://localhost:8787/api/integrations/google-calendar/callback`
  - Production: `https://<your-worker-domain>/api/integrations/google-calendar/callback`

  This must exactly match `GOOGLE_REDIRECT_URI` below, including scheme and path.

Save the generated **Client ID** and **Client Secret**.

## 4. Configure Field Scheduler

Three values live in `wrangler.toml` under `[vars]` (not secret — client ID and
redirect URI are safe to commit):

```toml
[vars]
GOOGLE_CLIENT_ID = "your-client-id.apps.googleusercontent.com"
GOOGLE_REDIRECT_URI = "http://localhost:8787/api/integrations/google-calendar/callback"
```

Two values are secrets and must **never** be committed:

| Variable | Local dev | Production |
|---|---|---|
| `GOOGLE_CLIENT_SECRET` | `.dev.vars` (copy `.dev.vars.example`) | `wrangler secret put GOOGLE_CLIENT_SECRET` |
| `TOKEN_ENCRYPTION_KEY` | `.dev.vars` | `wrangler secret put TOKEN_ENCRYPTION_KEY` |

`TOKEN_ENCRYPTION_KEY` is a base64-encoded 32-byte AES-256 key used to encrypt
OAuth access/refresh tokens at rest (see `src/server/crypto.ts`). Generate one
with:

```bash
openssl rand -base64 32
```

Rotating this key invalidates every stored token — every user would need to
reconnect.

## 5. Business timezone — REQUIRED, not optional

Google Calendar events are built from each job's `scheduled_date`/`scheduled_time`
plus an explicit IANA timezone (never a raw UTC offset, so events don't shift
when viewed from another timezone). This is stored in the `_meta` table
(`timezone`, defaults to `UTC`) since the app has no other timezone setting.

**If you skip this step, every synced appointment will display at the wrong
time in Google Calendar** — an appointment scheduled for 11:00 local time gets
sent to Google labeled `UTC`, and Google Calendar then shows it converted into
whatever timezone the viewing Google account is set to (e.g. an 11:00
appointment appears as 04:00 to a Pacific-time viewer). This is not cosmetic —
technicians and customers can act on the wrong appointment time. Update it for
your business's locale before connecting any real calendar:

```sql
UPDATE _meta SET value = 'America/Vancouver' WHERE key = 'timezone';
```

(substitute your own IANA zone — `America/New_York`, `America/Toronto`, etc.)

## 6. Verify

With `.dev.vars` filled in and `pnpm dev` running, sign in, open **Google
Calendar** in the sidebar, and click **Connect Google Calendar**. You'll be
redirected to Google's real consent screen — if you see `invalid_client` or
`redirect_uri_mismatch`, double check the client ID and the authorized redirect
URI match exactly what's configured above.
