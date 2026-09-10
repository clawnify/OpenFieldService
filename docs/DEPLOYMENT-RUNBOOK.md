# Open Fieldservice Stack 2 Deployment Runbook

This runbook is for a separately authorized Stack 2 deployment and cutover. It does not authorize deployment, DNS changes, provider calls, data deletion, Stack 1 removal, or credential storage in Git.

## Runtime prerequisites

- Node.js pinned via the repository `engines` field (`>=24.0.0 <25.0.0`) and `.nvmrc` (`24.19.0`); use the repository `packageManager` declaration (`pnpm@11.21.0`) through Corepack. CI (`.github/workflows/quality.yml`) uses the same Node 24 major.
- PostgreSQL 17, reachable through `DATABASE_URL`.
- The repository and `pnpm-lock.yaml`.
- Auth.js-compatible `AUTH_SECRET` with at least 32 random characters.
- R2/S3-compatible private bucket credentials when file, PDF, evidence, signature, or signed-artifact features are enabled.

## Environment inventory

| Variable | Classification | Notes |
| --- | --- | --- |
| `DATABASE_URL` | required at build/runtime | PostgreSQL URL; never commit it. |
| `AUTH_SECRET` | required at build/runtime | At least 32 random characters. |
| `APP_URL` | required runtime for Phone Operations; development fallback otherwise | Canonical public HTTPS application URL used for provider callbacks; never use a localhost value in production. |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT` | optional until storage is exercised; required as a complete runtime group for storage | Private R2/S3-compatible bucket; reconnect to the same bucket when moving hosts. |
| `MAINTENANCE_SCHEDULER_SECRET` | optional runtime, required for internal scheduler invocation | At least 32 random characters; fail closed when absent. |
| `PHONE_OPERATIONS_ENCRYPTION_KEY` | optional runtime, required to save/reveal Phone credentials | At least 32 characters; provider-specific application boundary. |
| `SEED_ADMIN_PASSWORD` | development/test-only | Never use for production. |
| `TWILIO_*`, email/SMS provider credentials | provider-specific runtime, currently deferred | No live dispatch is part of this runbook. |

There are no committed production secrets. Environment parsing is strict and rejects incomplete R2 configuration or missing required values. `.env.example` contains placeholders only.

## Clean bootstrap

```text
corepack enable
corepack pnpm install --frozen-lockfile
create an empty PostgreSQL 17 database
set DATABASE_URL and AUTH_SECRET in the runtime environment
cd apps/web
pnpm drizzle-kit migrate
pnpm build
pnpm start
```

For a development-only synthetic environment, `pnpm db:seed` requires `SEED_ADMIN_PASSWORD` (12+ characters) and never reads legacy D1 data. The script runs via `tsx --conditions=react-server` — the `react-server` condition is required because `src/db/seed.ts` transitively imports `server-only`-guarded code; omitting it makes the seed fail immediately. The repository Windows integration harness creates an isolated PostgreSQL 17 cluster, applies migrations from zero, runs the real suite, and stops the cluster. If a from-scratch production build produces `ENOENT ... _ssgManifest.js`, delete `apps/web/.next` first — this is a stale local build-cache symptom, not a fresh-clone defect.

## Storage and runtime wiring

R2 uses one private bucket with server-generated organization/entity keys and short-lived signed downloads. Host migration normally reconnects to the same bucket; no object copy is needed unless the operator intentionally changes buckets. Verify credentials and bucket policy before enabling storage flows. Phone/Twilio, Voice Engine, email/SMS dispatch, transcription, and platform cron remain external configuration/deployment tasks and are not fabricated by Stack 2.

## Health and smoke checks

After starting the application, verify the login page, authenticated Customer/Job/Schedule/Estimate/Contract/Invoice/Maintenance/Retention/Phone/Reports routes, one public proposal/signing/follow-up/unsubscribe route, and one internal scheduler authorization check. Use synthetic data only. Do not make live or paid provider calls.

`GET /api/health` performs a trivial `select 1` against `DATABASE_URL` and returns `{"status":"ok"}` with HTTP 200 when the database is reachable, or HTTP 503 otherwise. Point uptime/process monitoring at this route for startup and PostgreSQL-connectivity health; it intentionally does not check R2 or external providers (those fail per-request, not at startup).

## Backup and restore

Before cutover, take a PostgreSQL logical backup using the operator's approved `pg_dump` process and store it outside the repository. Restore it into a disposable PostgreSQL 17 database with `pg_restore` (or `psql` for a plain SQL dump), apply only the compatible pending migrations, start Stack 2 against the restored URL, and repeat smoke checks. Keep environment secrets in the approved secret manager; restore R2 access/configuration separately and do not place keys in the backup or Git.

This exact procedure was verified end-to-end on 2026-09-10 with disposable synthetic data on a throwaway PostgreSQL 17 cluster: `pg_dump -Fc` → `pg_restore` into a second empty database → row counts matched exactly → production build/start against the restored database → `/login` returned HTTP 200. A production backup/restore against real operator credentials/data remains an owner-executed drill.

## Scheduler, monitoring, and rotation

Run the repository internal scheduler hook from a trusted server/platform scheduler, with the scheduler secret supplied only by the runtime secret manager. Repeated/concurrent runs are database-idempotent and return bounded results. Monitor application errors, authentication failures, database health, outbox backlog, storage errors, and scheduler results. Rotate `AUTH_SECRET`, scheduler, Phone encryption, and provider credentials according to the secret manager procedure; rotation must be coordinated with active sessions/provider configuration.

## DNS, reverse proxy, and environment switch plan

- **Production app URL**: set `APP_URL` to the final public HTTPS origin before cutover; it is required at runtime for Phone Operations callback URL generation and should be treated as required for every production boot (a localhost value must never reach production).
- **Routing/reverse proxy**: run `next start` (or the platform's Next.js runtime) behind the operator's reverse proxy/load balancer; the proxy is responsible for terminating client connections and forwarding to the Node process's port.
- **TLS responsibility**: TLS termination is owned by the reverse proxy/edge, not by the Next.js process. Certificates must be valid for `APP_URL`'s host before the DNS switch.
- **DNS**: if the production hostname changes, lower the DNS TTL in advance, then repoint the record only after smoke checks in this runbook pass against the new deployment.
- **Auth/public URL implications**: Auth.js session cookies and callback URLs are derived from the request origin behind the proxy; confirm the proxy forwards `X-Forwarded-Host`/`X-Forwarded-Proto` correctly so Auth.js sees the real public origin.
- **Phone callback implications**: Twilio webhook/callback URLs are generated from `APP_URL`; a mismatch between `APP_URL` and the live DNS/TLS endpoint breaks inbound call/webhook signature verification. Do not enable live Phone/Twilio configuration until `APP_URL` matches the switched DNS target.
- **Scheduler endpoint configuration**: point the platform scheduler at `/api/internal/maintenance/run` and `/api/internal/retention/run` with `Authorization: Bearer <MAINTENANCE_SCHEDULER_SECRET>`; both routes return HTTP 404 (fail closed) when the secret is absent or mismatched.
- **Rollback target**: the reverse proxy/DNS rollback target is the existing Stack 1 deployment, kept intact for the owner-approved retention window.
- **Smoke checks**: repeat the Health and smoke checks section above against the new URL before considering the switch final.

This plan is documentation only; no DNS record, reverse-proxy config, or TLS certificate was changed as part of this verification.

## External provider / scheduler matrix

| Runtime | Required for core cutover | Enabled at launch | Configuration required | Verification method | Rollback / disable behavior |
| --- | --- | --- | --- | --- | --- |
| PostgreSQL 17 | Yes | Yes | `DATABASE_URL` | Migration + integration suite + backup/restore drill (this doc) | Restore from logical backup; stop app on connectivity loss |
| R2 / S3-compatible storage | Yes, for attachment/PDF/evidence/signature/contract features | Yes if those features are used | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT` (all-or-nothing) | Attachment unit/integration tests; code-reviewed signed-URL/key-scoping logic (`src/lib/r2.ts`); live browser walkthrough confirmed Contract signing, Maintenance signing, and Technician evidence upload each correctly fail (not silently) when R2 is unconfigured, blocking at exactly the storage call; no live bucket exercised in this environment | Env schema rejects partial R2 config at boot; unset entirely disables storage-dependent routes at the call site, not silently |
| Platform scheduler (Maintenance/Retention automation) | No (manual operation still works without it) | Recommended | `MAINTENANCE_SCHEDULER_SECRET`, trusted scheduler caller | Route returns 404 without a matching bearer secret (timing-safe compare); confirmed in code | Omit the secret/caller to fail closed; automation simply does not run |
| Email/SMS dispatch (notifications, campaigns, follow-up) | No | No — explicitly deferred | Not yet defined (no live adapter wired) | Outbox/pending-intent pattern only; no live send path exists | N/A — disabled by omission |
| Twilio / PSTN (Phone Operations) | No | No | Per-org encrypted Twilio credentials, `PHONE_OPERATIONS_ENCRYPTION_KEY` | HMAC signature verification, encryption/tamper tests reviewed; no live call made | Leave credentials unset; Phone routes remain but provider actions no-op/error |
| Voice Engine / Media Streams | No | No | External service, not in this repository | Not applicable in this repository | External deployment decision, not a repository toggle |
| Transcription | No | No | Tied to Voice Engine deployment | Not applicable in this repository | Same as Voice Engine |
| Accounting / settlement | No | No — explicitly deferred (future phase) | Not yet defined | N/A | N/A — disabled by omission |

Previously established non-blocking deferrals (email/SMS live dispatch, Twilio/Voice Engine/transcription live deployment, accounting settlement) are preserved as-is; none are promoted to blockers here.

## Cutover and rollback

1. Confirm owner approval, test-data assumption, backup, environment, R2 access, and external-runtime decisions.
2. Provision PostgreSQL 17 and the Stack 2 runtime; install from the frozen lockfile and run migrations.
3. Run authenticated/public/internal smoke checks with synthetic or approved data.
4. Switch the application URL/reverse proxy only after smoke checks pass; do not delete Stack 1.
5. Monitor the agreed window for authentication, tenant isolation, financial, file, scheduler, and domain errors.
6. On a rollback trigger (data integrity, tenant isolation, authentication, financial, or sustained availability failure), stop Stack 2 writes, preserve logs and the backup, restore the prior application route/runtime, and reconcile any approved post-backup changes before retrying.
7. Keep Stack 1 intact for the owner-approved rollback retention window. Physical legacy removal is a separate destructive task.

## Continuous integration

`.github/workflows/quality.yml` has two jobs: `verify` (unchanged, Stack 1 root scripts on Node 24) and `verify-web` (new), which runs on a PostgreSQL 17 service container and executes, for `apps/web`: frozen install, typecheck, lint, `drizzle-kit migrate` from zero, unit tests, PostgreSQL integration tests, production build, and a git-independent Drizzle drift check (compares the migration file count before/after `drizzle-kit generate`, since `apps/web` is not yet committed to git so a git-diff-based check would always false-positive). This closes a real gap: CI previously did not build or test `apps/web` at all. **Hosted-runner execution of `verify-web` has not been observed** — the workflow YAML was locally syntax-validated only; it will run for real on the next push or pull request.

## Browser acceptance findings (2026-09-10)

A live browser walkthrough against a disposable, freshly seeded PostgreSQL-backed instance (synthetic data only) found:

- **PASS**: authenticated desktop flows (CRM, Jobs, Schedule, Estimates, Contracts, Invoices, Maintenance, Retention, Phone, Reports, Settings) render correctly with live data; tax calculation (GST+PST) is correct on Estimate lines; the public proposal accept flow (issue link → customer selects an option → replay-safe view) works end-to-end; the referral flow (mint code → public claim → Lead created → replay-safe by code review) works end-to-end; the Technician offline workspace loads correctly online, scoped to only the assigned Job, and the report-draft/notes fields save and sync cleanly.
- **Real bug found**: `pnpm db:seed` was broken as originally written (see Clean bootstrap section above) — fixed.
- **Real bug found**: the public proposal page (`GET /proposal/[token]`) crashes to Next's generic error boundary ("A server error occurred") for a malformed/unknown token, instead of a clean not-found response — `publicTokenSchema` parsing throws uncaught outside the intended `return null` path. The public `/unsubscribe/[token]` route does not have this problem (it 404s cleanly). Not fixed this pass (verification scope); recommend catching this validation error and mapping it to `notFound()`.
- **Real bug found**: authenticated real-time mutations that throw an expected business/validation error (e.g., adding an Estimate line without a description, or a downstream R2-unavailable condition during Contract signing) crash to the same generic error boundary instead of showing inline form feedback. By contrast, the Technician offline-sync queue handles the identical class of failure (a storage-unavailable condition during evidence upload) gracefully, surfacing it as a typed, inline "conflict" state (`upload evidence · conflict · File storage is temporarily unavailable`). Recommend applying the sync-queue's graceful-degradation pattern to the synchronous authenticated mutation paths.
- **Environment limitation, not an app defect**: this environment has no R2 credentials and no local S3-compatible mock available, so Contract signing, Maintenance signing, and Technician evidence upload (and therefore the full Job completion gate, and therefore automated post-completion follow-ups) cannot be driven to completion here — each blocks at the point it needs object storage. The UI and business logic up to that point are confirmed correct (consent-gated signing ceremony renders correctly; the completion gate's evidence requirement is enforced; the sync queue reports the failure correctly rather than silently dropping it).
- **Not verified this pass**: mobile/tablet width and accessibility (the same `resize_window` tooling limitation from Phase 19C/19D reproduced a third time — the browser viewport did not actually resize despite a success response); Maintenance signing and follow-up public flows specifically (blocked upstream by the R2 gap above); a full offline→reconnect→sync cycle for the Technician (only "loaded online" was exercised, matching this gate's literal scope).

## Owner decision block (APP_URL / DNS / TLS / provider launch)

Fill in before cutover; this is a decision record, not an application default:

```text
Production APP_URL:
Production hostname:
DNS target:
TLS termination:
Reverse proxy / hosting layer:
Auth callback verified:
Phone callback base URL:
Scheduler base URL:
R2 enabled at launch:
Email/SMS enabled at launch:
Twilio/PSTN enabled at launch:
Voice Engine enabled at launch:
Transcription enabled at launch:
Accounting settlement enabled at launch:
Rollback target:
```

Confirmed by code review: `APP_URL`, `DATABASE_URL`, and all provider/scheduler credentials are read from environment variables (`src/lib/env.ts`, Auth.js config, Phone Operations config) — none are hardcoded in application source.

## Third pass (2026-09-10): CI job review, public error hardening, R2-gated acceptance, offline/reconnect, unsubscribe

**CI job review**: `verify-web` (added in the second pass) re-audited — Node 24, PostgreSQL 17 service, frozen install, typecheck, lint, migrate, unit, integration, build, drift check, no production secrets, no live provider calls. Confirmed minimal and correct. **Still not run on a hosted runner** (no push performed this pass either).

**`eslint.config.js` review**: the `apps/**` ignore added in the second pass was independently re-audited this pass — it is exactly one glob entry, does not touch any other ignore pattern, does not disable or weaken any rule, and does not exclude any Stack 1 source. It exists solely because root ESLint 10 cannot parse `apps/web`'s separate ESLint-9/Next toolchain without crashing. Confirmed minimal and necessary; kept as-is.

**Public error-handling gaps fixed** (previously disclosed, now closed): `proposal/[token]`, `contract/[token]` (page + both actions), `maintenance-agreement/[token]`'s sign action, and `refer/[code]`'s claim action now use the same `try { ... } catch (error) { if (error instanceof ApplicationError) notFound()/redirect('?error=1'); throw error; }` pattern already used correctly by `/unsubscribe` and `/follow-up`. Verified live: malformed tokens on `/proposal`, `/contract`, and `/maintenance-agreement` now return clean HTTP 404 (previously a raw 500-style crash). Focused test assertions added to `parity.integration.test.ts`, `contract.integration.test.ts`, and `maintenance.integration.test.ts` confirming the underlying service methods reject a malformed token as an `ApplicationError`. Full apps/web suite re-verified clean after the fix: typecheck/lint PASS, unit 108/108, integration 188/188, production build PASS. No lifecycle/security semantics were changed — only how already-thrown errors are presented.

**R2 test environment**: no docker, no Minio/S3-mock binary, and no S3-compatible mock package exists in this repository or environment (checked `pnpm-lock.yaml` and installed tooling). Building a bespoke fake S3-compatible HTTP server for this one verification pass was deliberately not done — it would be exactly the "large infrastructure... solely for this pass" this gate says to avoid, and a hand-rolled mock's SigV4/behavioral quirks could produce false confidence rather than real R2/Cloudflare-compatibility evidence. **Decision: `PRODUCTION R2 OWNER GATE: REQUIRED`.** See the checklist below.

**R2-gated acceptance (Technician completion, Contract signing, Maintenance signing, follow-up positive path)**: remain `OWNER/R2 VALIDATION REQUIRED` for the reason above. What *was* independently re-confirmed this pass without R2: the Contract "secure signing ceremony" UI is correct and complete up to the signing action; the Technician completion gate's evidence requirement (pre/post-work photo count > 0) is enforced; the offline-sync queue reports an R2 failure as a typed, inline conflict rather than crashing (all from the second pass, re-confirmed still true).

**Technician offline → reconnect → sync (positive path, non-evidence fields): PASS, live-verified.** Using `navigator.onLine` override + synthetic `online`/`offline` window events against a real running instance (the standard, supported way this app detects connectivity — `offline-workspace.tsx` listens for exactly these), the full cycle was exercised: Online → offline event → header shows "Offline" → edited and saved a report field ("Save draft locally") → header shows "Pending sync", sync queue shows `save report · pending` (no network call attempted while offline) → online event → automatic flush → header shows "Synced", queue empty. **Verified server-side**: the offline-authored text was confirmed present in `job_completion_reports.work_performed` via direct database read after sync. Not exercised: evidence-photo staging while offline (blocked by the same R2 gap) and app/page restart mid-queue (tooling can simulate network state but not a genuine process restart within one verification pass).

**Unsubscribe valid-flow acceptance: PASS, live-verified end-to-end**, no R2 needed. A real capability was created via the application's own hashing/rules functions (`createRetentionCapability`/`hashRetentionCapability`, the same primitives the app itself uses — not a fabricated bypass), then walked through the real public page: view → click Unsubscribe → "You're unsubscribed" → confirmed `retention_preferences.unsubscribed_at` set via direct database read. **Replay verified live**: revisiting and re-submitting the identical link a second time returned the same success state with no error (idempotent, matching `unsubscribeLocked`'s `alreadyUnsubscribed` guard — the audit trail only records the event once, per code review, not re-checked via a second DB read this pass). Malformed-token 404 behavior for `/unsubscribe/[token]` was already confirmed in the second pass and is unchanged.

**Follow-up (positive and negative)**: still blocked — requires a completed Job, which requires evidence upload, which requires R2. Not reachable this pass.

**Mobile / tablet / accessibility**: still NOT VERIFIED. `resize_window` was not retried this pass (already reproduced non-functional twice; retrying a known-broken tool a third time would not produce new information). See the owner checklist below.

### Production R2 owner checklist

Complete with real, non-shared credentials — do not print secret values anywhere, including in this file:

- [ ] Confirm the target bucket exists and is provisioned for this application only (not shared with an unrelated system).
- [ ] Confirm the bucket is private (no public read/list access).
- [ ] Confirm the application's R2 access key is scoped to least privilege (object read/write/delete on this bucket's key prefix only, no account-wide access).
- [ ] From a production-like environment (not a developer machine), verify: upload succeeds, download via a signed URL succeeds, the signed URL expires when its TTL elapses (30–900s per `DOWNLOAD_URL_TTL_SECONDS`/`assertFileSignature` bounds in `src/lib/r2.ts`), and an unsigned/direct object URL does not return the object.
- [ ] Verify object keys are correctly organization/entity-scoped (`organizations/<orgId>/<entityType>/<entityId>/<uuid>`, per `createObjectKey`) and that one organization cannot construct a valid key for another organization's objects.
- [ ] Exercise one real Contract signing, one real Maintenance signing, and one real Technician evidence upload end-to-end against this bucket.
- [ ] Confirm backup/recovery expectations for R2 objects (Cloudflare R2's own durability/versioning posture) match the operator's data-retention policy.
- [ ] Document the credential rotation procedure and confirm it does not require an application restart with zero downtime, or document the downtime window if it does.

### Mobile / tablet / accessibility owner checklist

Automated verification could not resize the browser viewport in this environment (tooling limitation, reproduced across three passes). A person with a real device or browser devtools should walk:

**Mobile (~390px width)**: sign-in/dashboard, Customer detail, Job detail, Technician completion workflow, Technician offline workspace, Estimates (Good/Better/Best), public Contract signing, public Maintenance signing, public referral/follow-up/unsubscribe pages, Reports (tables/cards should not force horizontal scroll), Settings.

**Tablet (~768px width)**: repeat the same critical navigation, forms, tables, and both Technician and public flows.

**Accessibility**: keyboard-only navigation through forms and menus; visible focus indicators; every form field has an associated label; validation errors are associated with their field (not just colored text); dialogs/menus trap and return focus correctly; public-facing forms (proposal, contract signing, referral, unsubscribe) are usable without a mouse; no critical status information (e.g., "Selected", "Synced", "Conflict") is conveyed by color alone; sufficient accessible names on icon-only buttons.

## Current gate (updated 2026-09-10, third pass)

Final verification establishes application parity, a pinned Node runtime, a portable clean bootstrap, a verified backup/restore drill, a minimal health endpoint (re-confirmed `/api/health` 200 against three separate fresh instances this pass), a `verify-web` CI job (still not hosted-runner-verified), the three previously-disclosed public error-handling gaps now fixed and verified live, a fully live-verified offline→reconnect→sync cycle, and a fully live-verified unsubscribe flow with replay-safety — but still does not authorize production cutover. Remaining before owner cutover approval: hosted-runner confirmation of the CI job; R2 configuration (no safe local mock exists in this environment) to unlock Contract signing, Maintenance signing, Technician evidence/completion, and follow-up acceptance; mobile/tablet/accessibility acceptance on a real device; the production R2, APP_URL/DNS/TLS, and provider-launch owner decisions catalogued above.
