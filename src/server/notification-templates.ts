/**
 * Phase 9.2 — provider-independent template rendering, keyed by
 * `notification_outbox.template_key`. Not a CMS: a fixed switch over the
 * template keys Phase 9.0/9.1/9.2 actually produce, rendering straight from
 * the already-minimal `payload` JSON (never a full Customer/Job/Invoice
 * row — that discipline was already enforced at enqueue time, this module
 * just trusts it). Deliberately no internal DB ids in any output string —
 * every field read below is a human-facing value (name/identifier/date/
 * time/amount), never `job.id`/`customer_id`/etc.
 */

export class TemplateError extends Error {
  constructor(templateKey: string) {
    super(`No template registered for template_key "${templateKey}"`);
  }
}

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

export interface SmsContent {
  text: string;
}

type Payload = Record<string, unknown>;

function str(payload: Payload, key: string, fallback = ""): string {
  const v = payload[key];
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

/** Cents -> "$X.YY" — a small local formatter, not a dependency on the
 *  client's `src/client/money.ts` (server code never imports client code
 *  in this project). Same integer-cents convention, same output shape. */
function formatCents(payload: Payload, key: string): string {
  const v = payload[key];
  const cents = typeof v === "number" ? v : 0;
  return `$${(cents / 100).toFixed(2)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function emailWrap(greeting: string, bodyLines: string[]): { text: string; html: string } {
  const text = [greeting, "", ...bodyLines].join("\n");
  const html = `<p>${escapeHtml(greeting)}</p>` + bodyLines.map((l) => `<p>${escapeHtml(l)}</p>`).join("");
  return { text, html };
}

const EMAIL_TEMPLATES: Record<string, (p: Payload) => EmailContent> = {
  appointment_confirmation_v1: (p) => {
    const name = str(p, "customer_name", "there");
    const job = str(p, "job_identifier");
    const date = str(p, "scheduled_date");
    const time = str(p, "scheduled_time");
    const { text, html } = emailWrap(`Hi ${name},`, [
      `Your appointment (${job}) is confirmed for ${date} at ${time}.`,
      "We look forward to seeing you.",
    ]);
    return { subject: `Appointment confirmed — ${date}`, text, html };
  },
  appointment_rescheduled_v1: (p) => {
    const name = str(p, "customer_name", "there");
    const job = str(p, "job_identifier");
    const newDate = str(p, "new_date");
    const newTime = str(p, "new_time");
    const oldDate = str(p, "old_date");
    const oldTime = str(p, "old_time");
    const { text, html } = emailWrap(`Hi ${name},`, [
      `Your appointment (${job}) has been rescheduled from ${oldDate} ${oldTime} to ${newDate} ${newTime}.`,
    ]);
    return { subject: `Appointment rescheduled — ${newDate}`, text, html };
  },
  appointment_cancelled_v1: (p) => {
    const name = str(p, "customer_name", "there");
    const job = str(p, "job_identifier");
    const { text, html } = emailWrap(`Hi ${name},`, [
      `Your appointment (${job}) has been cancelled. Contact us if you'd like to rebook.`,
    ]);
    return { subject: "Appointment cancelled", text, html };
  },
  technician_on_the_way_v1: (p) => {
    const name = str(p, "customer_name", "there");
    const job = str(p, "job_identifier");
    const tech = str(p, "technician_name", "Your technician");
    const { text, html } = emailWrap(`Hi ${name},`, [`${tech} is on the way for your appointment (${job}).`]);
    return { subject: "Your technician is on the way", text, html };
  },
  invoice_issued_v1: (p) => {
    const name = str(p, "customer_name", "there");
    const invoice = str(p, "invoice_identifier");
    const total = formatCents(p, "total_cents");
    const { text, html } = emailWrap(`Hi ${name},`, [`Invoice ${invoice} for ${total} has been issued.`]);
    return { subject: `Invoice ${invoice} issued`, text, html };
  },
  payment_received_v1: (p) => {
    const name = str(p, "customer_name", "there");
    const invoice = str(p, "invoice_identifier");
    const amount = formatCents(p, "amount_cents");
    const { text, html } = emailWrap(`Hi ${name},`, [`We've received your payment of ${amount} for invoice ${invoice}. Thank you.`]);
    return { subject: `Payment received — ${invoice}`, text, html };
  },
  post_job_survey_v1: (p) => {
    const name = str(p, "customer_name", "there");
    const job = str(p, "job_identifier");
    const { text, html } = emailWrap(`Hi ${name},`, [
      `Thanks for choosing us for ${job}. We'd love your feedback on how we did.`,
    ]);
    return { subject: "How did we do?", text, html };
  },
  appointment_reminder_v1: (p) => {
    const name = str(p, "customer_name", "there");
    const job = str(p, "job_identifier");
    const date = str(p, "scheduled_date");
    const time = str(p, "scheduled_time");
    const { text, html } = emailWrap(`Hi ${name},`, [`Reminder: your appointment (${job}) is tomorrow, ${date} at ${time}.`]);
    return { subject: `Reminder: appointment tomorrow — ${date}`, text, html };
  },
  // Phase 19C — 60/30/14-day maintenance Agreement renewal reminder.
  // `milestone_days` is a plain informational number (e.g. "60"), never
  // used for anything beyond display — the actual dedupe/idempotency
  // guarantee comes from notifications.ts's dedupe_key (entity+milestone),
  // not from anything in this template.
  maintenance_renewal_reminder_v1: (p) => {
    const name = str(p, "customer_name", "there");
    const plan = str(p, "plan_name");
    const agreement = str(p, "agreement_identifier");
    const expires = str(p, "expires_date");
    const days = str(p, "milestone_days");
    const { text, html } = emailWrap(`Hi ${name},`, [
      `Your ${plan} maintenance agreement (${agreement}) is coming up for renewal in about ${days} days, on ${expires}.`,
      "No action is needed if you'd like your plan to continue as-is — otherwise, please contact us to discuss your renewal options.",
    ]);
    return { subject: `Your maintenance plan renews in ${days} days`, text, html };
  },
  contract_signed_copy_v1: (p) => {
    const name = str(p, "signer_name", "there");
    const contract = str(p, "contract_identifier");
    const { text, html } = emailWrap(`Hi ${name},`, [
      `Thank you for signing Contract ${contract}. A copy of the fully signed agreement is attached for your records.`,
      "If you have any questions, please contact us.",
    ]);
    return { subject: `Your signed contract — ${contract}`, text, html };
  },
  // Phase 13B (Section 6/7/33) — the explicit "Send Invoice" action, fired
  // only when an office user deliberately triggers delivery (never
  // automatically on issue — see the Core Business Rule in
  // recalculateStatus/issueInvoiceRoute's own comments). `pay_url` is
  // present only when online payment is enabled AND a payment link was
  // generated alongside the send — absent, the email simply omits the Pay
  // Online line rather than showing a dead/misleading link (Section 33:
  // "If provider unavailable: Invoice email still sends, Pay Online
  // omitted/disabled safely").
  invoice_sent_v1: (p) => {
    const name = str(p, "customer_name", "there");
    const invoice = str(p, "invoice_identifier");
    const total = formatCents(p, "total_cents");
    const dueDate = str(p, "due_date");
    const payUrl = str(p, "pay_url");
    const lines = [
      `Your invoice ${invoice} for ${total} is attached.`,
      dueDate ? `Payment is due by ${dueDate}.` : "",
    ].filter(Boolean);
    if (payUrl) lines.push(`Pay online: ${payUrl}`);
    const { text, html } = emailWrap(`Hi ${name},`, lines);
    return { subject: `Invoice ${invoice} from ${str(p, "company_name", "us")}`, text, html };
  },
  // Phase 13B (Section 21-24) — explicit-or-automatic Receipt email
  // (manual payments: explicit opt-in only; online payments: automatic —
  // see financial.ts#processPaymentWebhookEvent's caller in index.ts).
  payment_receipt_v1: (p) => {
    const name = str(p, "customer_name", "there");
    const invoice = str(p, "invoice_identifier");
    const amount = formatCents(p, "amount_cents");
    const { text, html } = emailWrap(`Hi ${name},`, [
      `Your receipt for a payment of ${amount} on invoice ${invoice} is attached. Thank you.`,
    ]);
    return { subject: `Receipt for your payment — ${invoice}`, text, html };
  },
  // Phase 19D — the delayed, stateful satisfaction follow-up (distinct
  // from Phase 9's immediate, one-way post_job_survey_v1 above — that one
  // still fires unchanged at the moment of completion; this one fires
  // days later via retention-automation.ts and links to a real response
  // page). response_url is empty when APP_PUBLIC_URL is unconfigured —
  // never a broken/fabricated link (see getAppPublicUrl's doc comment).
  follow_up_request_v1: (p) => {
    const name = str(p, "customer_name", "there");
    const url = str(p, "response_url");
    const lines = [
      "We'd love to know how your recent service went.",
      url ? `Please take a moment to let us know: ${url}` : "Please reply to this email or give us a call to let us know.",
    ];
    const { text, html } = emailWrap(`Hi ${name},`, lines);
    return { subject: "How did we do?", text, html };
  },
  // Phase 19D — seasonal/retention campaign send. subject/body are
  // admin-authored free text — routed through emailWrap()'s existing
  // escapeHtml(), never rendered as raw HTML (Section 29's explicit
  // "no unsafe arbitrary script/HTML execution" rule).
  campaign_send_v1: (p) => {
    const subject = str(p, "subject", "An update from us");
    const body = str(p, "body");
    const ctaLink = str(p, "ctaLink");
    const unsubscribeUrl = str(p, "unsubscribeUrl");
    const lines = [
      body, ctaLink || "",
      unsubscribeUrl ? `No longer want these emails? Unsubscribe: ${unsubscribeUrl}` : "",
    ].filter(Boolean);
    const { text, html } = emailWrap("Hi,", lines);
    return { subject, text, html };
  },
};

const SMS_TEMPLATES: Record<string, (p: Payload) => SmsContent> = {
  appointment_confirmation_v1: (p) =>
    ({ text: `Appointment ${str(p, "job_identifier")} confirmed for ${str(p, "scheduled_date")} at ${str(p, "scheduled_time")}.` }),
  appointment_rescheduled_v1: (p) =>
    ({ text: `Appointment ${str(p, "job_identifier")} moved to ${str(p, "new_date")} ${str(p, "new_time")}.` }),
  appointment_cancelled_v1: (p) => ({ text: `Appointment ${str(p, "job_identifier")} has been cancelled.` }),
  technician_on_the_way_v1: (p) => ({ text: `${str(p, "technician_name", "Your technician")} is on the way for ${str(p, "job_identifier")}.` }),
  invoice_issued_v1: (p) => ({ text: `Invoice ${str(p, "invoice_identifier")} for ${formatCents(p, "total_cents")} has been issued.` }),
  payment_received_v1: (p) => ({ text: `Payment of ${formatCents(p, "amount_cents")} received for invoice ${str(p, "invoice_identifier")}. Thank you.` }),
  post_job_survey_v1: (p) => ({ text: `Thanks for choosing us for ${str(p, "job_identifier")}! We'd love your feedback.` }),
  appointment_reminder_v1: (p) => ({ text: `Reminder: appointment ${str(p, "job_identifier")} tomorrow, ${str(p, "scheduled_date")} at ${str(p, "scheduled_time")}.` }),
  maintenance_renewal_reminder_v1: (p) => ({ text: `Your ${str(p, "plan_name")} maintenance plan (${str(p, "agreement_identifier")}) renews in ~${str(p, "milestone_days")} days, on ${str(p, "expires_date")}.` }),
  follow_up_request_v1: (p) => {
    const url = str(p, "response_url");
    return { text: `We'd love your feedback on your recent service.${url ? ` ${url}` : " Please give us a call."}` };
  },
  campaign_send_v1: (p) => {
    const unsubscribeUrl = str(p, "unsubscribeUrl");
    const body = str(p, "body").slice(0, 240);
    return { text: unsubscribeUrl ? `${body} Unsubscribe: ${unsubscribeUrl}` : body };
  },
};

export function renderEmail(templateKey: string, payload: Payload): EmailContent {
  const fn = EMAIL_TEMPLATES[templateKey];
  if (!fn) throw new TemplateError(templateKey);
  return fn(payload);
}

export function renderSms(templateKey: string, payload: Payload): SmsContent {
  const fn = SMS_TEMPLATES[templateKey];
  if (!fn) throw new TemplateError(templateKey);
  return fn(payload);
}
