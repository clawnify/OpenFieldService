import { get, run } from "./db.js";

/**
 * Phase 9.3 — read/update surface for `notification_preferences`
 * (Phase 9.0's schema, Phase 9.1's `resolvePreferences()` eligibility
 * logic — this module is the UI-facing counterpart, not a second source of
 * truth). Every mutation here is admin/dispatcher-only, confirmation-gated
 * client-side, and never accepts a client-supplied consent timestamp — the
 * database itself stamps `datetime('now')` for any NEW consent capture,
 * exactly like every other timestamp column in this schema.
 */

export type RecipientType = "customer" | "lead";

/** No approved source catalog existed anywhere in Serena/the codebase
 *  before this phase (migration 0011's own comment: "the set of valid
 *  sources isn't an approved business decision yet, and inventing one here
 *  would be exactly the 'do not implement legal/compliance logic in SQL'
 *  [instruction]"). Per this phase's explicit instruction to use "the
 *  smallest business-safe set" when none is approved, and record the
 *  decision — this is that decision, recorded here and in Serena
 *  (mem:phase9/notifications-architecture-audit). */
export const CONSENT_SOURCES = ["phone", "in_person", "web", "written", "other"] as const;
export type ConsentSource = typeof CONSENT_SOURCES[number];

export interface ChannelPreferenceView {
  enabled: boolean;
  consentAt: string | null;
  consentSource: string;
}

export interface PreferencesView {
  hasRow: boolean;
  email: ChannelPreferenceView;
  sms: ChannelPreferenceView;
}

interface PreferenceRow {
  id: number;
  email_enabled: number; email_consent_at: string | null; email_consent_source: string;
  sms_enabled: number; sms_consent_at: string | null; sms_consent_source: string;
}

function recipientColumn(recipientType: RecipientType): "customer_id" | "lead_id" {
  return recipientType === "customer" ? "customer_id" : "lead_id";
}

async function getRow(recipientType: RecipientType, recipientId: number): Promise<PreferenceRow | undefined> {
  return get<PreferenceRow>(
    `SELECT * FROM notification_preferences WHERE ${recipientColumn(recipientType)} = ?`, [recipientId]
  );
}

function toView(row: PreferenceRow | undefined): PreferencesView {
  if (!row) {
    // Matches notifications.ts's resolvePreferences() DEFAULT_PREFERENCES
    // exactly — "never configured" and "explicitly configured to the
    // default" must present identically, not as an error state.
    return {
      hasRow: false,
      email: { enabled: true, consentAt: null, consentSource: "" },
      sms: { enabled: false, consentAt: null, consentSource: "" },
    };
  }
  return {
    hasRow: true,
    email: { enabled: row.email_enabled === 1, consentAt: row.email_consent_at, consentSource: row.email_consent_source },
    sms: { enabled: row.sms_enabled === 1, consentAt: row.sms_consent_at, consentSource: row.sms_consent_source },
  };
}

export async function getPreferencesView(recipientType: RecipientType, recipientId: number): Promise<PreferencesView> {
  return toView(await getRow(recipientType, recipientId));
}

export type PreferenceUpdateErrorCode = "consent_source_required" | "invalid_consent_source";

export class PreferenceUpdateError extends Error {
  code: PreferenceUpdateErrorCode;
  constructor(code: PreferenceUpdateErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface PreferenceUpdateInput {
  emailEnabled?: boolean;
  smsEnabled?: boolean;
  smsConsentSource?: string;
}

/**
 * Phase 9.4 — consent policy FINALIZED (was a disclosed-but-open
 * interpretation after Phase 9.3; audited and locked here per that
 * phase's own explicit instruction not to leave it ambiguous):
 *
 * - Enable SMS (any transition from not-currently-enabled to enabled,
 *   including the very first enable AND every re-enable after a prior
 *   disable) ALWAYS requires a fresh `smsConsentSource` and ALWAYS
 *   re-stamps a new, server-generated `sms_consent_at` — even if a valid
 *   consent timestamp survives from before the disable. Old preserved
 *   consent is NEVER treated as sufficient to silently re-authorize a new
 *   enable action; per this phase's explicit reasoning, silently reusing
 *   old historical consent as current is a real consent-integrity risk
 *   ("do not automatically reuse old consent indefinitely unless
 *   explicitly approved" — no such approval exists). This reverses Phase
 *   9.3's original "reuse preserved consent on re-enable" interpretation.
 * - Disable SMS — or leaving it unchanged — never touches consent
 *   metadata (Section 12/Phase 9.3: preserve historical consent, never
 *   erase the fact that consent once existed — this part is unchanged).
 * - Re-affirming `smsEnabled: true` against an ALREADY-enabled row with a
 *   corrupted/legacy `consent_at IS NULL` state ALSO requires a fresh
 *   consent capture (not just a genuine false->true transition) — the
 *   fix below deliberately checks "no currently-valid consent" in
 *   addition to "not currently enabled," so the Phase 9.3 corrupted-data
 *   guard is preserved and, if anything, strengthened.
 * - Email has no consent-capture requirement anywhere in this schema/
 *   architecture (operational, default-on) — its consent_at/consent_source
 *   columns exist but nothing in Phase 9.0-9.4 ever populates them, so
 *   there is nothing to preserve or lose there.
 */
export async function updatePreferences(
  recipientType: RecipientType, recipientId: number, input: PreferenceUpdateInput
): Promise<PreferencesView> {
  const existing = await getRow(recipientType, recipientId);
  const col = recipientColumn(recipientType);

  const nextEmailEnabled = input.emailEnabled ?? (existing ? existing.email_enabled === 1 : true);
  const nextSmsEnabled = input.smsEnabled ?? (existing ? existing.sms_enabled === 1 : false);
  const wasEnabledBefore = existing ? existing.sms_enabled === 1 : false;
  const hasValidConsentBefore = (existing?.sms_consent_at ?? null) !== null;
  // Fresh consent required whenever this request explicitly enables SMS AND
  // (it wasn't already enabled, OR it was enabled but lacked valid consent).
  // Deliberately NOT gated on "no row at all" alone — an already-enabled,
  // already-consented row must NOT be forced through consent capture again
  // on an unrelated edit (e.g. toggling email) that merely re-sends the
  // current smsEnabled value.
  const capturingNewConsent = input.smsEnabled === true && (!wasEnabledBefore || !hasValidConsentBefore);

  if (capturingNewConsent) {
    const source = input.smsConsentSource?.trim();
    if (!source) throw new PreferenceUpdateError("consent_source_required", "A consent source is required to enable SMS notifications");
    if (!(CONSENT_SOURCES as readonly string[]).includes(source)) {
      throw new PreferenceUpdateError("invalid_consent_source", `Consent source must be one of: ${CONSENT_SOURCES.join(", ")}`);
    }
  }

  if (!existing) {
    try {
      await run(
        `INSERT INTO notification_preferences (${col}, email_enabled, sms_enabled, sms_consent_at, sms_consent_source)
         VALUES (?, ?, ?, ${capturingNewConsent ? "datetime('now')" : "NULL"}, ?)`,
        [recipientId, nextEmailEnabled ? 1 : 0, nextSmsEnabled ? 1 : 0, capturingNewConsent ? input.smsConsentSource!.trim() : ""]
      );
    } catch {
      // Lost an insert race against a concurrent first-time preference edit
      // for the same recipient — same catch-and-adopt pattern as
      // generateInvoiceForJob() (financial.ts) / tryClaimSync()
      // (calendar-sync.ts): the partial UNIQUE index is the real guard,
      // this just retries as an update against the now-existing row.
      return updatePreferences(recipientType, recipientId, input);
    }
  } else if (capturingNewConsent) {
    await run(
      `UPDATE notification_preferences
       SET email_enabled = ?, sms_enabled = ?, sms_consent_at = datetime('now'), sms_consent_source = ?, updated_at = datetime('now')
       WHERE ${col} = ?`,
      [nextEmailEnabled ? 1 : 0, nextSmsEnabled ? 1 : 0, input.smsConsentSource!.trim(), recipientId]
    );
  } else {
    await run(
      `UPDATE notification_preferences SET email_enabled = ?, sms_enabled = ?, updated_at = datetime('now') WHERE ${col} = ?`,
      [nextEmailEnabled ? 1 : 0, nextSmsEnabled ? 1 : 0, recipientId]
    );
  }

  return getPreferencesView(recipientType, recipientId);
}
