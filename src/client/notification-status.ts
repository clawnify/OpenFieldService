/**
 * Phase 9.3 — pure, dependency-free notification display helpers (no
 * Preact import), same "extract client logic into a plain .ts module for
 * direct unit testing" precedent as navigation.ts (Phase 6) / lead-status.ts
 * (Phase 8.4). Mirrors src/server/notification-dispatcher.ts's real
 * outbox state machine and cancellation reasons for DISPLAY PURPOSES ONLY —
 * the server remains the sole source of truth for what actually happened;
 * this file only decides how to phrase it.
 */

export const NOTIFICATION_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  sending: "Sending",
  sent: "Sent",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const NOTIFICATION_STATUS_COLORS: Record<string, string> = {
  pending: "#6b7280",
  sending: "#3b82f6",
  sent: "#16a34a",
  failed: "#dc2626",
  cancelled: "#9ca3af",
};

export const NOTIFICATION_EVENT_LABELS: Record<string, string> = {
  "job.appointment_confirmation": "Appointment Confirmation",
  "job.appointment_rescheduled": "Appointment Rescheduled",
  "job.appointment_cancelled": "Appointment Cancelled",
  "job.appointment_reminder": "Day-Before Reminder",
  "job.technician_on_the_way": "Technician On The Way",
  "job.post_job_survey": "Post-Job Survey",
  "invoice.issued": "Invoice Issued",
  "payment.received": "Payment Received",
  "invoice.sent": "Invoice Sent",
  "payment.receipt": "Receipt Emailed",
};

export function eventTypeLabel(eventType: string): string {
  return NOTIFICATION_EVENT_LABELS[eventType] || eventType;
}

export const NOTIFICATION_CHANNEL_LABELS: Record<string, string> = {
  email: "Email",
  sms: "Text Message",
};

export function channelLabel(channel: string): string {
  return NOTIFICATION_CHANNEL_LABELS[channel] || channel;
}

/** The server stores every timestamp as SQLite's `datetime('now')` output
 *  ("YYYY-MM-DD HH:MM:SS", always UTC, never a `Z` suffix or `T`
 *  separator) — the same format/UTC convention documented in
 *  mem:risks/google-calendar-sync-race's "ISO-vs-SQLite-datetime-format
 *  gotcha." `new Date("YYYY-MM-DD HH:MM:SS")` is parsed as LOCAL time by
 *  most JS engines, silently shifting the displayed time by the browser's
 *  UTC offset — this normalizes to a real UTC-aware ISO string first. */
export function parseServerTimestamp(value: string | null): Date | null {
  if (!value) return null;
  const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatNotificationDateTime(value: string | null): string {
  const d = parseServerTimestamp(value);
  return d ? d.toLocaleString() : "—";
}

/** Section 21 — never imply a sent state before delivery. A future
 *  `scheduled_for` is shown as "Scheduled for <date/time>", not as if it
 *  already happened; "just now"-scale due times read as "Pending" rather
 *  than a confusing near-past scheduled time. */
export function describeSchedule(status: string, scheduledFor: string | null): string {
  if (status !== "pending") return "";
  const d = parseServerTimestamp(scheduledFor);
  if (!d) return "Pending";
  const diffMs = d.getTime() - Date.now();
  if (diffMs <= 60_000) return "Pending";
  return `Scheduled for ${d.toLocaleString()}`;
}

const CANCEL_REASON_MESSAGES: Record<string, string> = {
  consent_revoked: "SMS consent was withdrawn before this message could be sent.",
  channel_disabled: "This notification channel was turned off before the message could be sent.",
  recipient_deleted: "The related record was deleted before this message could be sent.",
  entity_cancelled: "The appointment was cancelled before this reminder could be sent.",
  schedule_changed: "The appointment's date changed before this reminder could be sent.",
};

/** Business-friendly presentation of a failed/cancelled row — never the raw
 *  `last_error` string (which may read like `"provider_rejected_request:
 *  ..."` or `"cancelled: consent_revoked"`), never an HTTP status code,
 *  never provider-internal detail. Returns null for any other status
 *  (nothing to explain). */
export function businessFriendlyStatusMessage(
  status: string, attempts: number, channel: string, lastError: string
): string | null {
  if (status === "cancelled") {
    const reason = lastError.replace(/^cancelled:\s*/, "").trim();
    return CANCEL_REASON_MESSAGES[reason] || "This message was cancelled before it could be sent.";
  }
  if (status === "failed") {
    const channelWord = channel === "sms" ? "SMS" : "Email";
    return `${channelWord} delivery failed after ${attempts} attempt${attempts === 1 ? "" : "s"}. Our team has been notified.`;
  }
  return null;
}

// ── Preference display helpers ───────────────────────────────────────────

export interface ChannelPreferenceView {
  enabled: boolean;
  consentAt: string | null;
  consentSource: string;
}

/** Section 5 — email is operational/default-on; "no row yet" must present
 *  as the effective enabled state with explanatory text, never as an error
 *  or a blank. */
export function emailPreferenceSummary(pref: ChannelPreferenceView, hasRow: boolean): { label: string; detail: string } {
  const label = pref.enabled ? "Enabled" : "Disabled";
  if (!hasRow) return { label, detail: "Using the default operational email setting." };
  if (pref.enabled) return { label, detail: "Receiving operational email updates." };
  return { label, detail: "Operational email updates are turned off for this recipient." };
}

export interface SmsConsentSummary {
  label: string;
  detail: string;
  /** True when sms_enabled=1 but no valid consent_at exists — the
   *  corrupted/legacy-data case Section 6 explicitly requires the UI to
   *  flag rather than present as fully eligible. */
  warning: boolean;
}

/** Section 6 — "SMS Enabled" and "SMS Consent Recorded" are DISTINCT
 *  facts, never conflated. Real eligibility (matching the server's own
 *  dispatch-time re-check) is enabled AND a valid consentAt — never
 *  inferred from a phone number or the enabled flag alone. */
export function smsConsentSummary(pref: ChannelPreferenceView): SmsConsentSummary {
  if (!pref.enabled) {
    return { label: "Not Enabled", detail: "SMS notifications require recorded consent before they can be enabled.", warning: false };
  }
  if (!pref.consentAt) {
    return { label: "Enabled — Consent Missing", detail: "SMS is marked enabled, but no consent was recorded. Treat as NOT eligible until consent is captured.", warning: true };
  }
  return {
    label: "Enabled",
    detail: `Consent recorded ${formatNotificationDateTime(pref.consentAt)}${pref.consentSource ? ` via ${pref.consentSource.replace("_", " ")}` : ""}.`,
    warning: false,
  };
}
