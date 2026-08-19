import { get, query, run } from "./db.js";
import { resolvePreferences, enqueueAppointmentReminder, getCustomerContact, type NotificationChannel } from "./notifications.js";
import { renderEmail, renderSms, TemplateError } from "./notification-templates.js";
import { createResendEmailProvider } from "./notification-resend.js";
import { createTwilioSmsProvider } from "./notification-twilio.js";
import { ProviderError, sanitizeErrorMessage, safeCode } from "./notification-providers.js";
import type { EmailProvider, SmsProvider } from "./notification-providers.js";

/**
 * Phase 9.2 — the dispatcher. Everything from "find a due row" through
 * "record the delivery attempt" lives here, never in a request handler
 * (Section 7's explicit instruction). This module is only ever invoked
 * from the Cloudflare `scheduled()` entry point (see `runCronCycle` at the
 * bottom) — there is no HTTP route that can trigger it (Section 24: no
 * unauthenticated manual-dispatch endpoint exists; tests call these
 * exported functions directly instead, same "no client-DOM test
 * infrastructure, test server logic directly" convention this project
 * already uses everywhere — see `mem:project/fsm-upgrade-plan` decision 10).
 */

export type NotificationProviderBindings = {
  RESEND_API_KEY?: string;
  RESEND_FROM_ADDRESS?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM_NUMBER?: string;
};

export interface Providers {
  email: EmailProvider | null;
  sms: SmsProvider | null;
}

/** Builds real provider adapters from Worker secrets, or `null` for a
 *  channel whose secrets aren't configured — `dispatchOne()` treats a
 *  missing provider as a normal, retryable failure (`provider_not_configured`),
 *  never a crash, so a deployment that hasn't set up SMS yet doesn't wedge
 *  the whole dispatcher. `RESEND_FROM_ADDRESS` is a small, disclosed
 *  addition beyond the task's literal 4-secret list: Resend's send API
 *  requires a `from` address and none was specified as an existing
 *  convention anywhere in this codebase — it is NOT a credential, so it
 *  lives in `wrangler.toml`'s non-secret `[vars]`, same tier as
 *  `GOOGLE_CLIENT_ID`/`GOOGLE_REDIRECT_URI`, not `.dev.vars`/Worker secrets. */
export function buildProviders(env: NotificationProviderBindings): Providers {
  const email = env.RESEND_API_KEY && env.RESEND_FROM_ADDRESS
    ? createResendEmailProvider(env.RESEND_API_KEY, env.RESEND_FROM_ADDRESS)
    : null;
  const sms = env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER
    ? createTwilioSmsProvider(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, env.TWILIO_FROM_NUMBER)
    : null;
  return { email, sms };
}

// ── Timing policy — documented, not buried in a magic number ────────────

/** A claimed ('sending') row not completed within this window is presumed
 *  to belong to a Worker instance that died mid-attempt (uncaught
 *  exception, isolate eviction) — real provider HTTP calls should resolve
 *  in low single-digit seconds; 2 minutes is generous headroom above that
 *  while still being tight enough that a genuinely in-flight attempt is
 *  never at real risk of being reclaimed out from under it in practice. */
export const STALE_SENDING_TIMEOUT_MINUTES = 2;

/** attempts=1 failure -> +1m, attempts=2 failure -> +5m, attempts=3 failure
 *  -> terminal `failed`. Index 0 is the delay applied after a FIRST failed
 *  attempt, index 1 after a second. */
const RETRY_DELAY_MINUTES = [1, 5];
export const MAX_ATTEMPTS = 3;

/** Rows drained per Cron tick. The Cron cadence (see wrangler.toml,
 *  `* * * * *`) already reruns every minute, so a modest per-tick cap keeps
 *  any single invocation short without ever letting the queue grow
 *  unboundedly between ticks. */
const DISPATCH_BATCH_SIZE = 50;

interface OutboxRow {
  id: number;
  event_type: string;
  entity_type: string;
  entity_id: number;
  channel: NotificationChannel;
  recipient: string;
  template_key: string;
  payload: string;
  attempts: number;
  dedupe_key: string;
}

// ── Claim / reclaim ──────────────────────────────────────────────────────

/** Rows stuck in `sending` past the stale timeout are returned to `pending`
 *  so the next claim pass can pick them back up. Uses only existing
 *  columns (`status`, `updated_at`) — see the Phase 9.2 report's "Database
 *  Changes" section for why no `claimed_at` column was added. */
export async function reclaimStaleSendingRows(): Promise<number> {
  const result = await run(
    `UPDATE notification_outbox SET status = 'pending', updated_at = datetime('now')
     WHERE status = 'sending' AND updated_at < datetime('now', ?)`,
    [`-${STALE_SENDING_TIMEOUT_MINUTES} minutes`]
  );
  return result.changes;
}

async function findDueNotificationIds(limit: number): Promise<number[]> {
  const rows = await query<{ id: number }>(
    `SELECT id FROM notification_outbox WHERE status = 'pending' AND scheduled_for <= datetime('now')
     ORDER BY scheduled_for ASC LIMIT ?`,
    [limit]
  );
  return rows.map((r) => r.id);
}

/** The one atomic claim gate — `changes === 1` means THIS caller won the
 *  race; any other value means someone else already claimed it (or it's no
 *  longer pending for some other reason). Never a SELECT-then-assume. */
async function claimNotification(id: number): Promise<boolean> {
  const result = await run(
    `UPDATE notification_outbox SET status = 'sending', updated_at = datetime('now') WHERE id = ? AND status = 'pending'`,
    [id]
  );
  return result.changes === 1;
}

// ── Recipient re-resolution (NOT re-resolving the snapshot address) ─────

/** Resolves WHOSE preferences to re-check from the triggering entity — the
 *  outbox row does not itself store recipient_type/recipient_id (see the
 *  Phase 9.2 report's "Database Changes" section for why this join-based
 *  approach was chosen over adding those two columns). Every wired event
 *  is a customer-recipient event today; a future Lead-recipient event
 *  would extend this switch. Returns null if the underlying entity (and
 *  therefore the recipient) no longer exists — the caller treats that as
 *  `recipient_deleted`. This never re-resolves or overwrites the
 *  snapshotted `recipient` column — it only tells the caller which
 *  Customer's CURRENT preferences to check. */
async function resolveRecipientCustomerId(entityType: string, entityId: number): Promise<number | null> {
  let customerId: number | null = null;
  if (entityType === "job") {
    const row = await get<{ customer_id: number }>("SELECT customer_id FROM jobs WHERE id = ?", [entityId]);
    customerId = row?.customer_id ?? null;
  } else if (entityType === "invoice") {
    const row = await get<{ customer_id: number }>("SELECT customer_id FROM invoices WHERE id = ?", [entityId]);
    customerId = row?.customer_id ?? null;
  } else if (entityType === "payment") {
    const row = await get<{ customer_id: number }>(
      "SELECT i.customer_id as customer_id FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.id = ?", [entityId]
    );
    customerId = row?.customer_id ?? null;
  }
  if (customerId === null) return null;
  const customer = await get<{ id: number }>("SELECT id FROM customers WHERE id = ?", [customerId]);
  return customer ? customerId : null;
}

type CancelReason = "consent_revoked" | "channel_disabled" | "recipient_deleted" | "entity_cancelled" | "schedule_changed";

async function cancelNotification(id: number, reason: CancelReason): Promise<void> {
  await run(
    `UPDATE notification_outbox SET status = 'cancelled', last_error = ?, updated_at = datetime('now') WHERE id = ?`,
    [`cancelled: ${reason}`, id]
  );
}

async function recheckEligibility(
  channel: NotificationChannel, customerId: number
): Promise<{ ok: true } | { ok: false; reason: CancelReason }> {
  const prefs = await resolvePreferences("customer", customerId);
  if (channel === "email" && !prefs.emailEnabled) return { ok: false, reason: "channel_disabled" };
  if (channel === "sms" && !(prefs.smsEnabled && prefs.smsConsentAt)) return { ok: false, reason: "consent_revoked" };
  return { ok: true };
}

/** Reminder-only extra guard (Section 13/29): a reminder enqueued earlier
 *  in the SAME Cron tick must not fire if the job was cancelled or its
 *  schedule changed in the narrow window between enqueue and dispatch.
 *  Every other event type skips this — they aren't schedule-sensitive the
 *  same way and already have their own correctness built into WHEN they're
 *  enqueued (see notifications.ts's event-specific helpers). */
async function reminderStillValid(entityId: number, expectedDate: string): Promise<{ ok: true } | { ok: false; reason: CancelReason }> {
  const job = await get<{ status: string; scheduled_date: string }>("SELECT status, scheduled_date FROM jobs WHERE id = ?", [entityId]);
  if (!job) return { ok: false, reason: "recipient_deleted" };
  if (job.status === "cancelled") return { ok: false, reason: "entity_cancelled" };
  if (job.scheduled_date !== expectedDate) return { ok: false, reason: "schedule_changed" };
  return { ok: true };
}

// ── Delivery attempt history + outbox state transitions ─────────────────

async function recordAttempt(
  notificationId: number, attemptNumber: number, status: "succeeded" | "failed",
  providerMessageId: string | null, errorCode: string, errorMessage: string
): Promise<void> {
  await run(
    `INSERT INTO notification_delivery_attempts
       (notification_id, attempt_number, status, provider_message_id, error_code, error_message, attempted_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [notificationId, attemptNumber, status, providerMessageId, errorCode, errorMessage]
  );
}

async function recordSuccess(id: number, attempts: number, providerMessageId: string): Promise<void> {
  await run(
    `UPDATE notification_outbox
     SET status = 'sent', provider_message_id = ?, sent_at = datetime('now'), last_error = '', attempts = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [providerMessageId, attempts, id]
  );
}

async function recordFailure(id: number, attempts: number, errorCode: string, errorMessage: string): Promise<"retry" | "failed"> {
  if (attempts >= MAX_ATTEMPTS) {
    await run(
      `UPDATE notification_outbox SET status = 'failed', attempts = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?`,
      [attempts, `${errorCode}: ${errorMessage}`, id]
    );
    return "failed";
  }
  const delayMinutes = RETRY_DELAY_MINUTES[attempts - 1];
  await run(
    `UPDATE notification_outbox
     SET status = 'pending', attempts = ?, last_error = ?, scheduled_for = datetime('now', ?), updated_at = datetime('now')
     WHERE id = ?`,
    [attempts, `${errorCode}: ${errorMessage}`, `+${delayMinutes} minutes`, id]
  );
  return "retry";
}

export type DispatchOutcome = "sent" | "retry" | "failed" | "cancelled" | "skipped";

/** The per-row pipeline. Caller MUST have already won `claimNotification()`
 *  for this id (status is 'sending') — this function does not claim. */
export async function dispatchOne(id: number, providers: Providers): Promise<DispatchOutcome> {
  const row = await get<OutboxRow>(
    `SELECT id, event_type, entity_type, entity_id, channel, recipient, template_key, payload, attempts, dedupe_key
     FROM notification_outbox WHERE id = ? AND status = 'sending'`,
    [id]
  );
  if (!row) return "skipped"; // lost the row somehow (shouldn't happen if caller just claimed it)

  const customerId = await resolveRecipientCustomerId(row.entity_type, row.entity_id);
  if (customerId === null) {
    await cancelNotification(id, "recipient_deleted");
    return "cancelled";
  }

  const eligibility = await recheckEligibility(row.channel, customerId);
  if (!eligibility.ok) {
    await cancelNotification(id, eligibility.reason);
    return "cancelled";
  }

  if (row.event_type === "job.appointment_reminder") {
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(row.payload) as Record<string, unknown>; } catch { /* fall through with {} */ }
    const expectedDate = typeof payload.scheduled_date === "string" ? payload.scheduled_date : "";
    const stillValid = await reminderStillValid(row.entity_id, expectedDate);
    if (!stillValid.ok) {
      await cancelNotification(id, stillValid.reason);
      return "cancelled";
    }
  }

  const attemptNumber = row.attempts + 1;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    await recordAttempt(id, attemptNumber, "failed", null, "invalid_payload", "Stored payload was not valid JSON");
    return recordFailure(id, attemptNumber, "invalid_payload", "Stored payload was not valid JSON");
  }

  // Phase 9.4 fix (P1): the provider call and the "record it" bookkeeping
  // used to share one try/catch, so a DB write failure AFTER a successful
  // send was indistinguishable from a send failure — the catch below would
  // call recordFailure(), which SCHEDULES A RETRY, guaranteeing a real
  // duplicate send on the next attempt even though the first one already
  // succeeded. Only the send itself is allowed to produce a retryable
  // "failed" outcome now; once the provider has confirmed acceptance, a
  // bookkeeping failure is never reinterpreted as a send failure — see the
  // Phase 9.4 report's "Uncertain Provider Outcome" section for the
  // residual (much narrower, disclosed) risk that remains: a crash in the
  // handful of statements between send() resolving and recordSuccess()
  // committing, which stale-claim reclaim (not a false retry) resolves.
  let providerMessageId: string;
  try {
    if (row.channel === "email") {
      if (!providers.email) throw new ProviderError("provider_not_configured", "Email provider is not configured");
      const content = renderEmail(row.template_key, payload);
      const result = await providers.email.send({
        to: row.recipient, subject: content.subject, html: content.html, text: content.text, idempotencyKey: row.dedupe_key,
      });
      providerMessageId = result.providerMessageId;
    } else {
      if (!providers.sms) throw new ProviderError("provider_not_configured", "SMS provider is not configured");
      const content = renderSms(row.template_key, payload);
      const result = await providers.sms.send({ to: row.recipient, body: content.text, idempotencyKey: row.dedupe_key });
      providerMessageId = result.providerMessageId;
    }
  } catch (err) {
    const { code, message } = classifyError(err);
    await recordAttempt(id, attemptNumber, "failed", null, code, message);
    return recordFailure(id, attemptNumber, code, message);
  }

  await recordAttempt(id, attemptNumber, "succeeded", providerMessageId, "", "");
  await recordSuccess(id, attemptNumber, providerMessageId);
  return "sent";
}

function classifyError(err: unknown): { code: string; message: string } {
  if (err instanceof TemplateError) return { code: "template_not_found", message: sanitizeErrorMessage(err.message) };
  if (err instanceof ProviderError) return { code: safeCode(err.code), message: sanitizeErrorMessage(err.message) };
  const message = err instanceof Error ? err.message : String(err);
  return { code: "unexpected_error", message: sanitizeErrorMessage(message) };
}

// ── Cycle orchestration ──────────────────────────────────────────────────

export interface DispatchCycleResult {
  reclaimed: number;
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  cancelled: number;
  skipped: number;
  /** Phase 9.4 — a row whose processing threw an exception we didn't
   *  expect (not a normal send failure, which is captured as `failed`/
   *  `retried` above). Counted, never silently dropped, so an anomaly is
   *  visible in the Cron result rather than invisibly stalling. */
  errored: number;
}

/** One full drain pass: reclaim stale claims, then attempt every currently
 *  due row up to the batch cap. Safe to call from multiple concurrent
 *  invocations (see `claimNotification()`) — each row is claimed by at most
 *  one caller regardless of how many `runDispatchCycle()` calls are racing.
 *  Phase 9.4 fix: each row's processing is now individually isolated — an
 *  unexpected exception from ONE row (e.g. a transient D1 error outside
 *  dispatchOne()'s own try/catch) no longer aborts the rest of this
 *  cycle's due rows; it did before this fix. */
export async function runDispatchCycle(providers: Providers, limit = DISPATCH_BATCH_SIZE): Promise<DispatchCycleResult> {
  const result: DispatchCycleResult = { reclaimed: 0, claimed: 0, sent: 0, retried: 0, failed: 0, cancelled: 0, skipped: 0, errored: 0 };
  result.reclaimed = await reclaimStaleSendingRows();

  const dueIds = await findDueNotificationIds(limit);
  for (const id of dueIds) {
    const claimed = await claimNotification(id);
    if (!claimed) continue; // another dispatcher already won this row
    result.claimed++;
    try {
      const outcome = await dispatchOne(id, providers);
      if (outcome === "sent") result.sent++;
      else if (outcome === "retry") result.retried++;
      else if (outcome === "failed") result.failed++;
      else if (outcome === "cancelled") result.cancelled++;
      else result.skipped++;
    } catch {
      // Row stays 'sending' — resolved by stale-claim reclaim next cycle,
      // never by silently continuing to loop over it here.
      result.errored++;
    }
  }
  return result;
}

// ── Day-before reminder scan ─────────────────────────────────────────────

/** Independent read of `_meta.timezone` — deliberately duplicated rather
 *  than importing `calendar-sync.ts`'s own private `getTimezone()`, which
 *  is explicitly protected this phase (Section 31: do not modify
 *  calendar-sync.ts/google-calendar.ts). Same query, same 'UTC' fallback —
 *  reuses the project's ALREADY-ESTABLISHED business-timezone convention
 *  (migration 0001's `_meta.timezone` row, seeded 'UTC', documented as
 *  "change it for your business's locale") rather than inventing a second
 *  one or guessing a BC timezone (see the Phase 9.2 report's "Timezone"
 *  section for the full reasoning — this is the resolution of Section 14's
 *  stop condition, not a bypass of it). */
export async function getBusinessTimezone(): Promise<string> {
  const row = await get<{ value: string }>("SELECT value FROM _meta WHERE key = 'timezone'");
  return row?.value || "UTC";
}

/** Pure calendar-day arithmetic in the given IANA timezone — never touches
 *  wall-clock hours, so DST transitions can't shift the result by an hour
 *  the way naive Date math could (same "pure wall-clock arithmetic"
 *  philosophy as calendar-sync.ts's own `addMinutes()`, independently
 *  reimplemented here for the same do-not-modify-that-file reason). */
export function businessDateOffset(tz: string, daysFromToday: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const y = Number(parts.find((p) => p.type === "year")!.value);
  const m = Number(parts.find((p) => p.type === "month")!.value);
  const d = Number(parts.find((p) => p.type === "day")!.value);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + daysFromToday);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

interface ReminderCandidate {
  id: number;
  identifier: string;
  customer_id: number;
  scheduled_date: string;
  scheduled_time: string;
}

export interface ReminderScanResult {
  targetDate: string;
  scanned: number;
  enqueued: number;
}

/** Scans for jobs scheduled on "tomorrow" (business timezone) and
 *  idempotently enqueues a reminder for each (dedupe key includes the
 *  target date — see notifications.ts's `enqueueAppointmentReminder()` doc
 *  comment for why no supersede mechanism is needed). Excludes cancelled
 *  AND completed jobs — completed wasn't explicitly named in the task's
 *  condition list, but reminding a customer about an appointment that has
 *  already happened is the same class of obviously-wrong send as
 *  reminding about a cancelled one; a small, disclosed judgment call, not
 *  an invented business rule. */
export async function enqueueDayBeforeReminders(): Promise<ReminderScanResult> {
  const tz = await getBusinessTimezone();
  const targetDate = businessDateOffset(tz, 1);

  const candidates = await query<ReminderCandidate>(
    `SELECT id, identifier, customer_id, scheduled_date, scheduled_time FROM jobs
     WHERE scheduled_date = ? AND status NOT IN ('cancelled', 'completed')`,
    [targetDate]
  );

  let enqueued = 0;
  for (const job of candidates) {
    const contact = await getCustomerContact(job.customer_id);
    if (!contact) continue;
    const results = await enqueueAppointmentReminder({
      jobId: job.id, jobIdentifier: job.identifier,
      customerId: job.customer_id, customerName: contact.name, customerEmail: contact.email, customerPhone: contact.phone,
      scheduledDate: job.scheduled_date, scheduledTime: job.scheduled_time,
    });
    if (results.email.enqueued || results.sms.enqueued) enqueued++;
  }
  return { targetDate, scanned: candidates.length, enqueued };
}

// ── Cloudflare Cron entry point ──────────────────────────────────────────

export interface CronCycleResult {
  reminders: ReminderScanResult;
  dispatch: DispatchCycleResult;
}

/** The one Cron path (Section 15): enqueue due time-based reminders, then
 *  drain due notification rows, in that order, in the same tick — this is
 *  what makes the reminder scan's "only current schedule governs" guarantee
 *  hold without any supersede logic (see `enqueueAppointmentReminder()`'s
 *  doc comment). */
export async function runCronCycle(env: NotificationProviderBindings): Promise<CronCycleResult> {
  const reminders = await enqueueDayBeforeReminders();
  const dispatch = await runDispatchCycle(buildProviders(env));
  return { reminders, dispatch };
}
