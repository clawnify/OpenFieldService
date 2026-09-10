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
  marketingEmail: ChannelPreferenceView;
  marketingSms: ChannelPreferenceView;
  marketingUnsubscribedAt: string | null;
}

interface PreferenceRow {
  id: number;
  email_enabled: number; email_consent_at: string | null; email_consent_source: string;
  sms_enabled: number; sms_consent_at: string | null; sms_consent_source: string;
  marketing_email_opt_in: number; marketing_email_consent_at: string | null; marketing_email_consent_source: string;
  marketing_sms_opt_in: number; marketing_sms_consent_at: string | null; marketing_sms_consent_source: string;
  marketing_unsubscribed_at: string | null;
  marketing_unsubscribe_token: string | null;
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
      marketingEmail: { enabled: false, consentAt: null, consentSource: "" },
      marketingSms: { enabled: false, consentAt: null, consentSource: "" },
      marketingUnsubscribedAt: null,
    };
  }
  return {
    hasRow: true,
    email: { enabled: row.email_enabled === 1, consentAt: row.email_consent_at, consentSource: row.email_consent_source },
    sms: { enabled: row.sms_enabled === 1, consentAt: row.sms_consent_at, consentSource: row.sms_consent_source },
    marketingEmail: { enabled: row.marketing_email_opt_in === 1, consentAt: row.marketing_email_consent_at, consentSource: row.marketing_email_consent_source },
    marketingSms: { enabled: row.marketing_sms_opt_in === 1, consentAt: row.marketing_sms_consent_at, consentSource: row.marketing_sms_consent_source },
    marketingUnsubscribedAt: row.marketing_unsubscribed_at,
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

// ── Phase 19D — marketing consent (separate tier, kept apart from the
// transactional updatePreferences() above rather than merged into it, to
// avoid risking regression to Phase 9's already-reviewed function) ──────

export interface MarketingPreferenceUpdateInput {
  emailOptIn?: boolean;
  smsOptIn?: boolean;
  consentSource?: string;
}

/**
 * Same consent-integrity policy as SMS above, applied to BOTH marketing
 * channels (unlike transactional email, which has no consent-capture
 * requirement at all): any not-currently-opted-in -> opted-in transition
 * for EITHER marketing_email_opt_in or marketing_sms_opt_in always demands
 * a fresh CONSENT_SOURCES value and always re-stamps a new consent_at —
 * old preserved consent is never silently reused to re-authorize a new
 * opt-in. Opting OUT (or an unrelated no-op re-affirm) never touches
 * consent metadata (preserved as historical record). A prior
 * marketing_unsubscribed_at is cleared only by a genuine fresh opt-in
 * (never by silently reusing it) — re-subscribing after an explicit
 * unsubscribe requires the same fresh-consent path as any other opt-in.
 */
export async function updateMarketingPreferences(
  recipientType: RecipientType, recipientId: number, input: MarketingPreferenceUpdateInput
): Promise<PreferencesView> {
  const existing = await getRow(recipientType, recipientId);
  const col = recipientColumn(recipientType);

  const nextEmailOptIn = input.emailOptIn ?? (existing ? existing.marketing_email_opt_in === 1 : false);
  const nextSmsOptIn = input.smsOptIn ?? (existing ? existing.marketing_sms_opt_in === 1 : false);
  const emailWasOptedIn = existing ? existing.marketing_email_opt_in === 1 : false;
  const smsWasOptedIn = existing ? existing.marketing_sms_opt_in === 1 : false;
  const capturingNewEmailConsent = input.emailOptIn === true && !emailWasOptedIn;
  const capturingNewSmsConsent = input.smsOptIn === true && !smsWasOptedIn;
  const capturingAnyNewConsent = capturingNewEmailConsent || capturingNewSmsConsent;

  if (capturingAnyNewConsent) {
    const source = input.consentSource?.trim();
    if (!source) throw new PreferenceUpdateError("consent_source_required", "A consent source is required to opt in to marketing communication");
    if (!(CONSENT_SOURCES as readonly string[]).includes(source)) {
      throw new PreferenceUpdateError("invalid_consent_source", `Consent source must be one of: ${CONSENT_SOURCES.join(", ")}`);
    }
  }

  if (!existing) {
    try {
      await run(
        `INSERT INTO notification_preferences
          (${col}, marketing_email_opt_in, marketing_email_consent_at, marketing_email_consent_source,
           marketing_sms_opt_in, marketing_sms_consent_at, marketing_sms_consent_source)
         VALUES (?, ?, ${capturingNewEmailConsent ? "datetime('now')" : "NULL"}, ?, ?, ${capturingNewSmsConsent ? "datetime('now')" : "NULL"}, ?)`,
        [
          recipientId, nextEmailOptIn ? 1 : 0, capturingNewEmailConsent ? input.consentSource!.trim() : "",
          nextSmsOptIn ? 1 : 0, capturingNewSmsConsent ? input.consentSource!.trim() : "",
        ]
      );
    } catch {
      return updateMarketingPreferences(recipientType, recipientId, input);
    }
  } else {
    const sets = ["marketing_email_opt_in = ?", "marketing_sms_opt_in = ?", "updated_at = datetime('now')"];
    const vals: unknown[] = [nextEmailOptIn ? 1 : 0, nextSmsOptIn ? 1 : 0];
    if (capturingNewEmailConsent) { sets.push("marketing_email_consent_at = datetime('now')", "marketing_email_consent_source = ?"); vals.push(input.consentSource!.trim()); }
    if (capturingNewSmsConsent) { sets.push("marketing_sms_consent_at = datetime('now')", "marketing_sms_consent_source = ?"); vals.push(input.consentSource!.trim()); }
    if (capturingAnyNewConsent) sets.push("marketing_unsubscribed_at = NULL");
    vals.push(recipientId);
    await run(`UPDATE notification_preferences SET ${sets.join(", ")} WHERE ${col} = ?`, vals);
  }

  return getPreferencesView(recipientType, recipientId);
}

/** The public, token-free "unsubscribe from marketing" action — sets both
 *  marketing opt-ins to 0 and stamps marketing_unsubscribed_at. Never
 *  touches the transactional email_enabled/sms_enabled toggle — a
 *  marketing unsubscribe must never silently suppress service/transactional
 *  communication (Section 7's explicit "transactional safety-critical
 *  messages must remain distinct from promotional suppression semantics"). */
export async function unsubscribeFromMarketing(recipientType: RecipientType, recipientId: number): Promise<void> {
  const existing = await getRow(recipientType, recipientId);
  const col = recipientColumn(recipientType);
  if (!existing) {
    await run(
      `INSERT INTO notification_preferences (${col}, marketing_email_opt_in, marketing_sms_opt_in, marketing_unsubscribed_at) VALUES (?, 0, 0, datetime('now'))`,
      [recipientId]
    ).catch(() => {});
    return;
  }
  await run(
    `UPDATE notification_preferences SET marketing_email_opt_in = 0, marketing_sms_opt_in = 0, marketing_unsubscribed_at = datetime('now'), updated_at = datetime('now') WHERE ${col} = ?`,
    [recipientId]
  );
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Lazily mints (or returns the existing) stable unsubscribe token for a
 *  recipient — embedded in every campaign send so the promotional-email
 *  opt-out required by CAN-SPAM/CASL is actually reachable by the customer,
 *  not just theoretically supported (Security/Code review finding, Phase
 *  19D: unsubscribeFromMarketing() existed with no public caller). Plain
 *  stored token, not hashed — see migration 0029's comment for why a lower
 *  security bar than the e-sign/follow-up bearer tokens is appropriate
 *  here. */
export async function getOrCreateUnsubscribeToken(recipientType: RecipientType, recipientId: number): Promise<string> {
  const existing = await getRow(recipientType, recipientId);
  if (existing?.marketing_unsubscribe_token) return existing.marketing_unsubscribe_token;
  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(24)));
  const col = recipientColumn(recipientType);
  if (!existing) {
    try {
      await run(`INSERT INTO notification_preferences (${col}, marketing_unsubscribe_token) VALUES (?, ?)`, [recipientId, token]);
      return token;
    } catch {
      return getOrCreateUnsubscribeToken(recipientType, recipientId); // lost an insert race — retry against the now-existing row
    }
  }
  await run(`UPDATE notification_preferences SET marketing_unsubscribe_token = ? WHERE ${col} = ?`, [token, recipientId]);
  return token;
}

/** Public: resolves a recipient from their unsubscribe token — used only by
 *  the public unsubscribe route, never by any authenticated admin/dispatcher
 *  flow (which already knows the recipient directly). */
export async function findRecipientByUnsubscribeToken(token: string): Promise<{ recipientType: RecipientType; recipientId: number } | null> {
  const row = await get<{ customer_id: number | null; lead_id: number | null }>(
    "SELECT customer_id, lead_id FROM notification_preferences WHERE marketing_unsubscribe_token = ?", [token]
  );
  if (!row) return null;
  if (row.customer_id) return { recipientType: "customer", recipientId: row.customer_id };
  if (row.lead_id) return { recipientType: "lead", recipientId: row.lead_id };
  return null;
}
