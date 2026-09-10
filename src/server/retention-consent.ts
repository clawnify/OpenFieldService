import { get } from "./db.js";
import { resolvePreferences, type NotificationChannel } from "./notifications.js";

/**
 * Phase 19D — the ONE central eligibility check every retention/marketing
 * outbound path (follow-up, review request, seasonal campaign) must call
 * before enqueueing anything. Read-only and side-effect-free by design —
 * this is what powers BOTH the audience preview (Section 27, which must
 * show suppression without sending anything) and the real send path
 * (which calls this same function first, then `enqueueChannel()` with the
 * matching `purpose`), so the two can never disagree about who is
 * eligible. Mirrors `enqueueChannel()`'s own preference-check logic
 * exactly (notifications.ts) rather than duplicating a second, divergent
 * interpretation of consent.
 */

export type SuppressionReason =
  | "no_contact" | "channel_disabled" | "sms_not_opted_in"
  | "marketing_not_opted_in" | "marketing_unsubscribed" | "customer_not_found";

export interface EligibilityResult {
  eligible: boolean;
  reason?: SuppressionReason;
  contact?: string;
}

interface CustomerContactRow { email: string; phone: string }

async function getContact(customerId: number): Promise<CustomerContactRow | null> {
  return (await get<CustomerContactRow>("SELECT email, phone FROM customers WHERE id = ?", [customerId])) ?? null;
}

/** Service-adjacent tier (post-job follow-up, review request, maintenance-
 *  plan offer) — gated by the EXISTING transactional email_enabled/
 *  sms_enabled toggle, same precedent as every other Phase 9 event type.
 *  No new consent is invented for something the customer already
 *  controls via their existing notification preferences. */
export async function checkServiceEligibility(customerId: number, channel: NotificationChannel): Promise<EligibilityResult> {
  const contact = await getContact(customerId);
  if (!contact) return { eligible: false, reason: "customer_not_found" };
  const value = channel === "email" ? contact.email : contact.phone;
  if (!value || !value.trim()) return { eligible: false, reason: "no_contact" };

  const prefs = await resolvePreferences("customer", customerId);
  if (channel === "email" && !prefs.emailEnabled) return { eligible: false, reason: "channel_disabled" };
  if (channel === "sms" && (!prefs.smsEnabled || !prefs.smsConsentAt)) return { eligible: false, reason: "sms_not_opted_in" };
  return { eligible: true, contact: value };
}

/** Marketing tier (seasonal campaigns, referral-promo content) — gated by
 *  the SEPARATE, default-OFF marketing_email_opt_in/marketing_sms_opt_in
 *  consent, never the transactional toggle. A prior explicit
 *  marketing_unsubscribed_at always blocks, even if an opt-in flag was
 *  somehow left on (defense in depth against a stale/inconsistent row). */
export async function checkMarketingEligibility(customerId: number, channel: NotificationChannel): Promise<EligibilityResult> {
  const contact = await getContact(customerId);
  if (!contact) return { eligible: false, reason: "customer_not_found" };
  const value = channel === "email" ? contact.email : contact.phone;
  if (!value || !value.trim()) return { eligible: false, reason: "no_contact" };

  const prefs = await resolvePreferences("customer", customerId);
  if (prefs.marketingUnsubscribedAt) return { eligible: false, reason: "marketing_unsubscribed" };
  if (channel === "email" && !prefs.marketingEmailOptIn) return { eligible: false, reason: "marketing_not_opted_in" };
  if (channel === "sms" && !prefs.marketingSmsOptIn) return { eligible: false, reason: "marketing_not_opted_in" };
  return { eligible: true, contact: value };
}
