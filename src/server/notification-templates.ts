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
