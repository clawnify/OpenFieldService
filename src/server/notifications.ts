import { get, run } from "./db.js";

/**
 * Phase 9.1 — NotificationService. Provider-independent outbox enqueue
 * ONLY — no EmailProvider/SmsProvider, no Cron dispatcher, no real
 * delivery exists yet (Phase 9.2). This module's entire job is: given a
 * business event that has ALREADY happened (an authoritative mutation has
 * already committed elsewhere), resolve the recipient's channel
 * eligibility and idempotently write a row to `notification_outbox`
 * (migration 0011, Phase 9.0). Nothing in this file calls out to the
 * network, and nothing in this file is a second workflow/business-rule
 * authority — every event-specific helper below is a thin wrapper around
 * one central `enqueueChannel()` primitive, called AFTER
 * transitionJob()/transitionLead()/issueInvoice()/recordPayment()/etc.
 * have already committed, from the route handlers in index.ts.
 */

export type NotificationChannel = "email" | "sms";
export type RecipientType = "customer" | "lead";

export type EnqueueSkipReason = "missing_recipient" | "channel_disabled" | "sms_not_opted_in" | "duplicate" | "unsupported_event";

export interface EnqueueResult {
  enqueued: boolean;
  notificationId?: number;
  reason?: EnqueueSkipReason;
}

/**
 * One central, deterministic dedupe-key builder — never scatter string
 * concatenation across route handlers. `discriminator` is the stable
 * business-event identity that distinguishes one legitimate occurrence of
 * this event from the next (e.g. a job_schedule_history row id for a
 * reschedule, since a job can be rescheduled many times) — NEVER a
 * timestamp generated at enqueue time, which would defeat idempotency by
 * making every retry look like a new event. For an event that can only
 * ever happen once per entity (job creation, invoice issuance — see the
 * event-specific helpers below for which ones qualify), the entity's own
 * id is itself a valid, stable discriminator.
 */
export function buildDedupeKey(parts: {
  entityType: string; entityId: number; eventType: string; discriminator: string | number; channel: NotificationChannel;
}): string {
  return `${parts.entityType}:${parts.entityId}:${parts.eventType}:${parts.discriminator}:${parts.channel}`;
}

interface PreferenceRow { email_enabled: number; sms_enabled: number; sms_consent_at: string | null }

const DEFAULT_PREFERENCES = { emailEnabled: true, smsEnabled: false, smsConsentAt: null as string | null };

/**
 * Phase 9.0 established email_enabled default=1 / sms_enabled default=0 as
 * COLUMN defaults, but most existing Customers/Leads have no
 * notification_preferences row at all yet (no backfill was done, none is
 * required). This resolves the SAME effective defaults for a recipient
 * with no row, so the two code paths ("has an explicit row" vs. "never
 * configured") produce identical eligibility — a real preference row only
 * ever OVERRIDES these, never introduces different default semantics.
 */
export async function resolvePreferences(
  recipientType: RecipientType, recipientId: number
): Promise<{ emailEnabled: boolean; smsEnabled: boolean; smsConsentAt: string | null }> {
  const row = recipientType === "customer"
    ? await get<PreferenceRow>("SELECT email_enabled, sms_enabled, sms_consent_at FROM notification_preferences WHERE customer_id = ?", [recipientId])
    : await get<PreferenceRow>("SELECT email_enabled, sms_enabled, sms_consent_at FROM notification_preferences WHERE lead_id = ?", [recipientId]);
  if (!row) return { ...DEFAULT_PREFERENCES };
  return { emailEnabled: row.email_enabled === 1, smsEnabled: row.sms_enabled === 1, smsConsentAt: row.sms_consent_at };
}

export interface EnqueueChannelInput {
  eventType: string;
  entityType: string;
  entityId: number;
  channel: NotificationChannel;
  recipientType: RecipientType;
  recipientId: number;
  /** The resolved email address or phone number, already looked up by the
   *  caller — this is what gets SNAPSHOTTED into notification_outbox.recipient.
   *  Never re-resolved later; if the Customer/Lead's contact info changes
   *  after this call, the already-queued row keeps the value that was
   *  correct when the business event happened. Phase 9.2's actual delivery
   *  must still re-check consent/preference eligibility before sending —
   *  this function only proves eligibility AT ENQUEUE TIME. */
  recipientContact: string;
  templateKey: string;
  /** Minimal rendered-template context ONLY — never a full Customer/Lead/
   *  Job/Invoice row. Each event-specific helper below selects exactly the
   *  fields its template needs. */
  payload: Record<string, unknown>;
  /** The stable business-event identity — see buildDedupeKey()'s doc. */
  discriminator: string | number;
  /** Omit for an immediate send (defaults to the column's own
   *  datetime('now')). Reminder-style future scheduling is Phase 9.2's
   *  concern — no current caller in this phase sets this. */
  scheduledFor?: string;
}

/**
 * THE one central enqueue primitive. Resolves recipient contact presence,
 * preference/consent eligibility, and performs the atomic idempotent
 * insert — `INSERT ... ON CONFLICT(dedupe_key) DO NOTHING`, never a
 * SELECT-then-INSERT (that would reintroduce the exact race the Phase 9.0
 * UNIQUE constraint exists to prevent). Never throws for a normal
 * "don't send" outcome (missing contact info, a disabled channel, missing
 * SMS consent, or a genuine duplicate) — those are ordinary, expected
 * results, returned via `reason`, not exceptions. A genuinely unexpected
 * error (e.g. a database error) DOES throw — callers are responsible for
 * treating notification enqueue as best-effort/non-fatal to whatever
 * authoritative business operation triggered it (see the `safeEnqueue()`
 * wrapper used by every call site in index.ts).
 */
export async function enqueueChannel(input: EnqueueChannelInput): Promise<EnqueueResult> {
  if (!input.recipientContact || !input.recipientContact.trim()) {
    return { enqueued: false, reason: "missing_recipient" };
  }

  const prefs = await resolvePreferences(input.recipientType, input.recipientId);
  if (input.channel === "email" && !prefs.emailEnabled) {
    return { enqueued: false, reason: "channel_disabled" };
  }
  if (input.channel === "sms") {
    // Explicit opt-in AND consent evidence required — the mere presence of
    // a phone number, or sms_enabled alone without a recorded consent
    // timestamp, is never sufficient (Phase 9.0's approved policy).
    if (!prefs.smsEnabled || !prefs.smsConsentAt) {
      return { enqueued: false, reason: "sms_not_opted_in" };
    }
  }

  const dedupeKey = buildDedupeKey({
    entityType: input.entityType, entityId: input.entityId, eventType: input.eventType,
    discriminator: input.discriminator, channel: input.channel,
  });

  const columns = ["event_type", "entity_type", "entity_id", "channel", "recipient", "template_key", "payload", "dedupe_key"];
  const values: unknown[] = [
    input.eventType, input.entityType, input.entityId, input.channel,
    input.recipientContact, input.templateKey, JSON.stringify(input.payload), dedupeKey,
  ];
  if (input.scheduledFor) { columns.push("scheduled_for"); values.push(input.scheduledFor); }

  const result = await run(
    `INSERT INTO notification_outbox (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ON CONFLICT(dedupe_key) DO NOTHING`,
    values
  );

  if (result.changes === 0) return { enqueued: false, reason: "duplicate" };
  return { enqueued: true, notificationId: Number(result.lastInsertRowid) };
}

export interface EnqueueEventInput {
  eventType: string;
  entityType: string;
  entityId: number;
  recipientType: RecipientType;
  recipientId: number;
  email: string;
  phone: string;
  templateKey: string;
  payload: Record<string, unknown>;
  discriminator: string | number;
  /** Defaults to attempting both channels — each is independently
   *  eligibility-checked and enqueued, so "email works, SMS doesn't" (or
   *  vice versa) is the normal case, not a partial failure. */
  channels?: NotificationChannel[];
}

/** Event-specific helpers below all funnel through this — attempts every
 *  requested channel independently via enqueueChannel(). */
export async function enqueueEvent(input: EnqueueEventInput): Promise<Record<NotificationChannel, EnqueueResult>> {
  const channels = input.channels ?? (["email", "sms"] as NotificationChannel[]);
  const results = {} as Record<NotificationChannel, EnqueueResult>;
  for (const channel of channels) {
    results[channel] = await enqueueChannel({
      eventType: input.eventType, entityType: input.entityType, entityId: input.entityId,
      channel, recipientType: input.recipientType, recipientId: input.recipientId,
      recipientContact: channel === "email" ? input.email : input.phone,
      templateKey: input.templateKey, payload: input.payload, discriminator: input.discriminator,
    });
  }
  return results;
}

/** Best-effort wrapper — mirrors syncJobToAllConnectedUsers()'s own
 *  "never throws" contract exactly. A genuinely unexpected error from
 *  enqueueEvent() (a real DB error, not an ordinary skip reason) is
 *  swallowed here so a notification-enqueue problem can never roll back
 *  or falsely fail the authoritative business mutation that already
 *  committed before this was called. Ordinary skip reasons never reach
 *  this catch at all — they're a normal return value. */
export async function safeEnqueue(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    // swallowed deliberately — see the doc comment above, same convention
    // as generateInvoiceForJob()'s best-effort call in transitionJobRoute.
  }
}

// ── Contact/discriminator resolution helpers ────────────────────────────
// Pure reads against tables this module does not own — never a write, so
// this does not create a second authority over Job/Invoice/Payment data,
// it only observes the result of an already-committed authoritative write
// long enough to build a stable dedupe discriminator.

export async function getCustomerContact(customerId: number): Promise<{ name: string; email: string; phone: string } | null> {
  const row = await get<{ name: string; email: string; phone: string }>(
    "SELECT name, email, phone FROM customers WHERE id = ?", [customerId]
  );
  return row ?? null;
}

/** The job_schedule_history row this update just wrote — read back rather
 *  than returned by recordScheduleHistory() (scheduler architecture is
 *  explicitly protected this phase; this is a read-only, additive lookup,
 *  not a modification to it). */
export async function latestScheduleHistoryId(jobId: number): Promise<number | null> {
  const row = await get<{ id: number }>("SELECT id FROM job_schedule_history WHERE job_id = ? ORDER BY id DESC LIMIT 1", [jobId]);
  return row?.id ?? null;
}

/** The job_status_history row for this specific transition to `toStatus` —
 *  read back rather than returned by transitionJob() (workflow.ts is
 *  explicitly protected this phase). Scoped to `to_status = ?` so a job
 *  that reaches the same status more than once (e.g. completed after a
 *  cancel+reopen) still resolves the CORRECT, most recent occurrence, not
 *  an unrelated earlier one. */
export async function latestStatusHistoryId(jobId: number, toStatus: string): Promise<number | null> {
  const row = await get<{ id: number }>(
    "SELECT id FROM job_status_history WHERE job_id = ? AND to_status = ? ORDER BY id DESC LIMIT 1", [jobId, toStatus]
  );
  return row?.id ?? null;
}

export async function latestPaymentId(invoiceId: number): Promise<number | null> {
  const row = await get<{ id: number }>("SELECT id FROM payments WHERE invoice_id = ? ORDER BY id DESC LIMIT 1", [invoiceId]);
  return row?.id ?? null;
}

// ── Event-specific helpers ───────────────────────────────────────────────
// Each is a thin wrapper over enqueueEvent() — no business logic of its
// own beyond selecting the minimal payload fields and the correct stable
// discriminator for that event type. See mem:phase9/notifications-architecture-audit
// for why each discriminator choice is safe (job.id alone for
// once-per-entity events; a specific history/payment row id for events
// that can recur).

export interface JobContactInfo {
  jobId: number; jobIdentifier: string;
  customerId: number; customerName: string; customerEmail: string; customerPhone: string;
}

/** Job creation is a once-per-job event — job.id alone is a safe, stable
 *  discriminator (a job is never "created" twice). */
export async function enqueueAppointmentConfirmation(
  job: JobContactInfo & { scheduledDate: string; scheduledTime: string }
): Promise<Record<NotificationChannel, EnqueueResult>> {
  return enqueueEvent({
    eventType: "job.appointment_confirmation", entityType: "job", entityId: job.jobId,
    recipientType: "customer", recipientId: job.customerId, email: job.customerEmail, phone: job.customerPhone,
    templateKey: "appointment_confirmation_v1",
    payload: { customer_name: job.customerName, job_identifier: job.jobIdentifier, scheduled_date: job.scheduledDate, scheduled_time: job.scheduledTime },
    discriminator: job.jobId,
  });
}

/** A job can be rescheduled many times — the discriminator MUST be the
 *  specific job_schedule_history row id for THIS reschedule, not job.id
 *  alone (which would collapse every reschedule of the same job into one
 *  dedupe key and silently drop every reschedule after the first). */
export async function enqueueAppointmentRescheduled(
  job: JobContactInfo & { oldDate: string; oldTime: string; newDate: string; newTime: string; scheduleHistoryId: number }
): Promise<Record<NotificationChannel, EnqueueResult>> {
  return enqueueEvent({
    eventType: "job.appointment_rescheduled", entityType: "job", entityId: job.jobId,
    recipientType: "customer", recipientId: job.customerId, email: job.customerEmail, phone: job.customerPhone,
    templateKey: "appointment_rescheduled_v1",
    payload: {
      customer_name: job.customerName, job_identifier: job.jobIdentifier,
      old_date: job.oldDate, old_time: job.oldTime, new_date: job.newDate, new_time: job.newTime,
    },
    discriminator: job.scheduleHistoryId,
  });
}

/** A job can legitimately be cancelled more than once (cancel -> reopen ->
 *  cancel again) — same reasoning as reschedule, uses the specific
 *  job_status_history row id for THIS cancellation. */
export async function enqueueAppointmentCancelled(
  job: JobContactInfo & { statusHistoryId: number }
): Promise<Record<NotificationChannel, EnqueueResult>> {
  return enqueueEvent({
    eventType: "job.appointment_cancelled", entityType: "job", entityId: job.jobId,
    recipientType: "customer", recipientId: job.customerId, email: job.customerEmail, phone: job.customerPhone,
    templateKey: "appointment_cancelled_v1",
    payload: { customer_name: job.customerName, job_identifier: job.jobIdentifier },
    discriminator: job.statusHistoryId,
  });
}

/** Same reasoning as cancellation — a job can reach "completed" more than
 *  once via cancel+reopen, so this uses the specific job_status_history
 *  row id for THIS completion, not job.id alone. */
export async function enqueuePostJobSurvey(
  job: JobContactInfo & { statusHistoryId: number }
): Promise<Record<NotificationChannel, EnqueueResult>> {
  return enqueueEvent({
    eventType: "job.post_job_survey", entityType: "job", entityId: job.jobId,
    recipientType: "customer", recipientId: job.customerId, email: job.customerEmail, phone: job.customerPhone,
    templateKey: "post_job_survey_v1",
    payload: { customer_name: job.customerName, job_identifier: job.jobIdentifier },
    discriminator: job.statusHistoryId,
    channels: ["email"], // a survey is not an urgent/time-sensitive SMS-worthy event — email only, per this phase's own "don't assume every event needs both channels" instruction
  });
}

/** "Technician on the way" (Section 19) is a manual, repeatable action —
 *  there is no history table recording it (a new one is explicitly out of
 *  this phase's scope). Dedupe is scoped to the calendar day it was
 *  triggered (server-computed, never client-supplied) rather than job.id
 *  alone (which would make the event a one-time-ever action, wrong for a
 *  job that could legitimately be visited more than once) or a raw
 *  enqueue-time timestamp (which the task explicitly forbids as a
 *  uniqueness component, since it would defeat idempotency for genuine
 *  retries within the same action). This is a deliberate, documented
 *  judgment call — see mem:phase9/notifications-architecture-audit — not
 *  an inferred detail. */
export async function enqueueOnTheWay(
  job: JobContactInfo & { technicianName: string; triggeredOnDate: string }
): Promise<Record<NotificationChannel, EnqueueResult>> {
  return enqueueEvent({
    eventType: "job.technician_on_the_way", entityType: "job", entityId: job.jobId,
    recipientType: "customer", recipientId: job.customerId, email: job.customerEmail, phone: job.customerPhone,
    templateKey: "technician_on_the_way_v1",
    payload: { customer_name: job.customerName, job_identifier: job.jobIdentifier, technician_name: job.technicianName },
    discriminator: job.triggeredOnDate,
  });
}

/** Day-before reminder (Phase 9.2) — deliberately NOT tied to a
 *  job_schedule_history row. The discriminator is the target
 *  `scheduledDate` itself: the Cron scan (see notification-dispatcher.ts)
 *  re-reads `jobs.scheduled_date` fresh on every run and only ever enqueues
 *  a reminder for whatever date is CURRENTLY "tomorrow" for that job, so a
 *  reschedule is reflected automatically at the next scan — no supersede
 *  mechanism is needed (this is exactly why Phase 9.1 deferred the reminder
 *  to this scan-at-dispatch-time design instead of pre-scheduling one at
 *  reschedule time). Two scans landing on the same target date for the same
 *  job (including a genuinely duplicate Cron execution) produce the same
 *  dedupe key -> idempotent. Allows both channels (unlike survey/invoice/
 *  payment) since a next-day appointment reminder is a legitimate
 *  SMS-worthy, time-sensitive event when the customer has opted in. */
export async function enqueueAppointmentReminder(
  job: JobContactInfo & { scheduledDate: string; scheduledTime: string }
): Promise<Record<NotificationChannel, EnqueueResult>> {
  return enqueueEvent({
    eventType: "job.appointment_reminder", entityType: "job", entityId: job.jobId,
    recipientType: "customer", recipientId: job.customerId, email: job.customerEmail, phone: job.customerPhone,
    templateKey: "appointment_reminder_v1",
    payload: { customer_name: job.customerName, job_identifier: job.jobIdentifier, scheduled_date: job.scheduledDate, scheduled_time: job.scheduledTime },
    discriminator: job.scheduledDate,
  });
}

export interface InvoiceContactInfo {
  invoiceId: number; invoiceIdentifier: string;
  customerId: number; customerName: string; customerEmail: string; customerPhone: string;
}

/** An invoice can only ever move to "issued" once — issueInvoice() itself
 *  rejects issuing anything but a draft — so invoice.id alone is a safe,
 *  stable discriminator. */
export async function enqueueInvoiceIssued(
  invoice: InvoiceContactInfo & { totalCents: number }
): Promise<Record<NotificationChannel, EnqueueResult>> {
  return enqueueEvent({
    eventType: "invoice.issued", entityType: "invoice", entityId: invoice.invoiceId,
    recipientType: "customer", recipientId: invoice.customerId, email: invoice.customerEmail, phone: invoice.customerPhone,
    templateKey: "invoice_issued_v1",
    payload: { customer_name: invoice.customerName, invoice_identifier: invoice.invoiceIdentifier, total_cents: invoice.totalCents },
    discriminator: invoice.invoiceId,
    channels: ["email"], // an invoice is not SMS-worthy by default — email only
  });
}

/** Multiple payments can exist per invoice — the discriminator MUST be the
 *  specific payment's own id, not invoice.id (which would collapse every
 *  payment on the same invoice into one dedupe key). entityType is
 *  "payment", not "invoice" — a payment is its own entity with its own id,
 *  even though the recipient (the Customer) is resolved via the invoice. */
export async function enqueuePaymentReceived(
  invoice: InvoiceContactInfo & { paymentId: number; amountCents: number }
): Promise<Record<NotificationChannel, EnqueueResult>> {
  return enqueueEvent({
    eventType: "payment.received", entityType: "payment", entityId: invoice.paymentId,
    recipientType: "customer", recipientId: invoice.customerId, email: invoice.customerEmail, phone: invoice.customerPhone,
    templateKey: "payment_received_v1",
    payload: { customer_name: invoice.customerName, invoice_identifier: invoice.invoiceIdentifier, amount_cents: invoice.amountCents },
    discriminator: invoice.paymentId,
    channels: ["email"],
  });
}
