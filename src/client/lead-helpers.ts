/**
 * Phase 8.4 — pure Lead UI helpers, dependency-free (no Preact import) so
 * they're independently unit-testable, same precedent as navigation.ts.
 */

/** Given a NEW referral_source selection and the CURRENT referral_name/
 *  referred_by_customer_id, returns the correctly cleared state — the same
 *  "clear the now-invalid conditional field on source change" rule
 *  create-customer.tsx/customer-detail.tsx already use for Customers,
 *  extracted here so the Lead forms (which need identical behavior) don't
 *  re-derive it inline. The server enforces this independently too
 *  (resolveReferralAttribution, reused unmodified for Leads since Phase
 *  8.2) — this only keeps the UI from showing/submitting a stale value. */
export function resolveReferralFieldsOnSourceChange(
  newSource: string,
  current: { referralName: string; referredById: number | null }
): { referralName: string; referredById: number | null } {
  return {
    referralName: newSource === "Referral" ? current.referralName : "",
    referredById: newSource === "Existing Customer" ? current.referredById : null,
  };
}

export interface LeadListFilters {
  page: number;
  limit: number;
  search: string;
  status: string;
  assignedUserId: string;
}

/** Builds the GET /api/leads query string — a pure function so the exact
 *  set of params sent is independently testable without a fetch mock. */
export function buildLeadListQuery(filters: LeadListFilters): string {
  const params = new URLSearchParams({ page: String(filters.page), limit: String(filters.limit) });
  if (filters.search) params.set("search", filters.search);
  if (filters.status) params.set("status", filters.status);
  if (filters.assignedUserId) params.set("assigned_user_id", filters.assignedUserId);
  return params.toString();
}

/** Business-friendly summary of a conversion result — used instead of
 *  showing the raw {created: boolean} the API returns. */
export function summarizeConversionResult(created: boolean): string {
  return created
    ? "A new customer record was created."
    : "An existing matching customer record was reused.";
}
