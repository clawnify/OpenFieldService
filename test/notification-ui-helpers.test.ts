import { describe, expect, it } from "vitest";
import {
  businessFriendlyStatusMessage, channelLabel, describeSchedule, emailPreferenceSummary, eventTypeLabel,
  formatNotificationDateTime, NOTIFICATION_STATUS_LABELS, parseServerTimestamp, smsConsentSummary,
} from "../src/client/notification-status.js";

// 28. status labels
describe("status labels", () => {
  it("maps every known outbox status to a business-friendly label", () => {
    expect(NOTIFICATION_STATUS_LABELS.pending).toBe("Pending");
    expect(NOTIFICATION_STATUS_LABELS.sending).toBe("Sending");
    expect(NOTIFICATION_STATUS_LABELS.sent).toBe("Sent");
    expect(NOTIFICATION_STATUS_LABELS.failed).toBe("Failed");
    expect(NOTIFICATION_STATUS_LABELS.cancelled).toBe("Cancelled");
  });

  it("maps known event types to business language, and falls back safely for unknown ones", () => {
    expect(eventTypeLabel("job.appointment_confirmation")).toBe("Appointment Confirmation");
    expect(eventTypeLabel("invoice.issued")).toBe("Invoice Issued");
    expect(eventTypeLabel("invoice.sent")).toBe("Invoice Sent");
    expect(eventTypeLabel("payment.receipt")).toBe("Receipt Emailed");
    expect(eventTypeLabel("some.unknown.event")).toBe("some.unknown.event");
  });

  it("maps channels to business language", () => {
    expect(channelLabel("email")).toBe("Email");
    expect(channelLabel("sms")).toBe("Text Message");
  });
});

// 29. business-friendly failure message
describe("businessFriendlyStatusMessage", () => {
  it("describes a failed email delivery without exposing raw internals", () => {
    const msg = businessFriendlyStatusMessage("failed", 3, "email", "provider_rejected_request: sanitized detail");
    expect(msg).toContain("Email");
    expect(msg).toContain("3 attempt");
    expect(msg).not.toContain("provider_rejected_request");
    expect(msg).not.toMatch(/HTTP|500|stack/i);
  });

  it("describes a failed SMS delivery", () => {
    const msg = businessFriendlyStatusMessage("failed", 1, "sms", "provider_network_error: x");
    expect(msg).toContain("SMS");
    expect(msg).toContain("1 attempt");
  });

  it("describes a cancelled notification via its safe reason", () => {
    expect(businessFriendlyStatusMessage("cancelled", 0, "sms", "cancelled: consent_revoked")).toMatch(/consent/i);
    expect(businessFriendlyStatusMessage("cancelled", 0, "email", "cancelled: channel_disabled")).toMatch(/turned off/i);
    expect(businessFriendlyStatusMessage("cancelled", 0, "email", "cancelled: recipient_deleted")).toMatch(/deleted/i);
  });

  it("falls back to a generic safe message for an unrecognized cancel reason", () => {
    const msg = businessFriendlyStatusMessage("cancelled", 0, "email", "cancelled: some_future_reason");
    expect(msg).toBeTruthy();
    expect(msg).not.toContain("some_future_reason");
  });

  it("returns null for sent/pending/sending — nothing to explain", () => {
    expect(businessFriendlyStatusMessage("sent", 1, "email", "")).toBeNull();
    expect(businessFriendlyStatusMessage("pending", 0, "email", "")).toBeNull();
    expect(businessFriendlyStatusMessage("sending", 1, "email", "")).toBeNull();
  });
});

// 30. date/time formatting
describe("date/time formatting", () => {
  it("parses a SQLite datetime('now')-shaped string as UTC, not local time", () => {
    const d = parseServerTimestamp("2026-06-15 12:00:00");
    expect(d).not.toBeNull();
    expect(d!.getUTCHours()).toBe(12);
    expect(d!.getUTCFullYear()).toBe(2026);
  });

  it("returns null for a null/empty input rather than throwing", () => {
    expect(parseServerTimestamp(null)).toBeNull();
    expect(parseServerTimestamp("")).toBeNull();
  });

  it("formatNotificationDateTime never throws and never returns raw ISO junk for missing values", () => {
    expect(formatNotificationDateTime(null)).toBe("—");
    expect(typeof formatNotificationDateTime("2026-06-15 12:00:00")).toBe("string");
  });

  it("describeSchedule never implies a sent state before delivery", () => {
    const future = new Date(Date.now() + 6 * 3600_000);
    const futureStr = future.toISOString().slice(0, 19).replace("T", " ");
    expect(describeSchedule("pending", futureStr)).toMatch(/^Scheduled for/);
    expect(describeSchedule("sent", futureStr)).toBe(""); // only meaningful for pending
    expect(describeSchedule("pending", null)).toBe("Pending");
  });
});

// 31. preference effective-state helper
describe("emailPreferenceSummary", () => {
  it("shows the effective default state (not an error) when no row exists yet", () => {
    const summary = emailPreferenceSummary({ enabled: true, consentAt: null, consentSource: "" }, false);
    expect(summary.label).toBe("Enabled");
    expect(summary.detail).toMatch(/default/i);
  });

  it("shows an explicit disabled state distinctly from the no-row default", () => {
    const summary = emailPreferenceSummary({ enabled: false, consentAt: null, consentSource: "" }, true);
    expect(summary.label).toBe("Disabled");
    expect(summary.detail).not.toMatch(/default/i);
  });
});

// 32. SMS consent-state helper
describe("smsConsentSummary", () => {
  it("distinguishes 'not enabled' from 'enabled with recorded consent'", () => {
    const notEnabled = smsConsentSummary({ enabled: false, consentAt: null, consentSource: "" });
    expect(notEnabled.label).toBe("Not Enabled");
    expect(notEnabled.warning).toBe(false);

    const enabled = smsConsentSummary({ enabled: true, consentAt: "2026-01-01 00:00:00", consentSource: "phone" });
    expect(enabled.label).toBe("Enabled");
    expect(enabled.detail).toMatch(/phone/);
    expect(enabled.warning).toBe(false);
  });

  it("flags the corrupted/legacy 'enabled but no consent' state as a warning, never as fully eligible", () => {
    const corrupted = smsConsentSummary({ enabled: true, consentAt: null, consentSource: "" });
    expect(corrupted.warning).toBe(true);
    expect(corrupted.detail).toMatch(/not eligible/i);
  });

  it("never infers consent from a phone number or the enabled flag alone", () => {
    // enabled=true + consentAt=null must NEVER produce warning=false — this
    // is the exact anti-inference guarantee Section 6 requires.
    const result = smsConsentSummary({ enabled: true, consentAt: null, consentSource: "" });
    expect(result.warning).toBe(true);
  });
});
