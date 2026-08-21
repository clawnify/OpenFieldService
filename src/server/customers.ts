import { get } from "./db.js";

/**
 * Customer referral attribution — validated server-side regardless of what
 * the client's conditional form UI does or doesn't send, per the standing
 * "UI is not a security/validation boundary" rule already applied to every
 * other domain in this app.
 *
 * The rule, for both create and edit:
 *   referral_source === "Referral"          -> referral_name required (non-empty),
 *                                               referred_by_customer_id forced null
 *   referral_source === "Existing Customer" -> referred_by_customer_id required,
 *                                               must reference a real customer,
 *                                               must not equal the customer's own id,
 *                                               referral_name forced ""
 *   anything else (including "")            -> both fields forced to their
 *                                               empty/null state, regardless
 *                                               of what was sent — this is
 *                                               what prevents stale
 *                                               conditional data from a
 *                                               prior referral_source value
 *                                               from lingering on the row.
 */

export class CustomerValidationError extends Error {}

export interface ReferralInput {
  referral_source?: string;
  referral_name?: string;
  referred_by_customer_id?: number | null;
}

export interface ReferralExisting {
  referral_source: string;
  referral_name: string;
  referred_by_customer_id: number | null;
}

export interface ResolvedReferral {
  referral_source: string;
  referral_name: string;
  referred_by_customer_id: number | null;
}

/**
 * Computes the correct, validated final state of the 3 referral fields.
 *
 * `existing` is only relevant for an UPDATE where the caller didn't send
 * every referral field in this particular PATCH — the EFFECTIVE
 * referral_source (existing, unless this call also changes it) governs
 * validation, not just whatever happened to be in this one request. Pass
 * `null` for a brand-new customer (nothing to fall back to).
 *
 * `selfId` is the customer's own id for an UPDATE (to reject self-referral)
 * or `null` for a CREATE (a not-yet-existing customer can never self-refer).
 */
export async function resolveReferralAttribution(
  organizationId: number,
  input: ReferralInput,
  existing: ReferralExisting | null,
  selfId: number | null
): Promise<ResolvedReferral> {
  const referralSource = input.referral_source !== undefined ? input.referral_source : (existing?.referral_source ?? "");

  if (referralSource === "Referral") {
    const name = (input.referral_name !== undefined ? input.referral_name : (existing?.referral_name ?? "")).trim();
    if (!name) {
      throw new CustomerValidationError("Referral Name is required when Referral Source is \"Referral\"");
    }
    return { referral_source: referralSource, referral_name: name, referred_by_customer_id: null };
  }

  if (referralSource === "Existing Customer") {
    const referredById = input.referred_by_customer_id !== undefined
      ? input.referred_by_customer_id
      : (existing?.referred_by_customer_id ?? null);
    if (referredById === null) {
      throw new CustomerValidationError("Referred By Customer is required when Referral Source is \"Existing Customer\"");
    }
    if (selfId !== null && referredById === selfId) {
      throw new CustomerValidationError("A customer cannot be recorded as their own referrer");
    }
    // Phase 11.5: organization-scoped — a customer in another organization
    // must be treated as nonexistent for referral-attribution purposes,
    // same as every other cross-tenant lookup in this codebase, so a
    // customer can never be recorded as referred by (and therefore never
    // display the name of) a customer belonging to a different organization.
    const referring = await get<{ id: number }>(
      "SELECT id FROM customers WHERE id = ? AND organization_id = ?", [referredById, organizationId]
    );
    if (!referring) {
      throw new CustomerValidationError("The selected referring customer does not exist");
    }
    return { referral_source: referralSource, referral_name: "", referred_by_customer_id: referredById };
  }

  // Any other source (including blank/unset) — no attribution data allowed,
  // and any stale value from a previously-selected "Referral"/"Existing
  // Customer" source is explicitly cleared here, not just left alone.
  return { referral_source: referralSource, referral_name: "", referred_by_customer_id: null };
}
