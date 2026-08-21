import { get, run } from "../../../db.js";

/**
 * Phase 11.3 — the BC rebate program's customer profile (house size,
 * primary heating source, household composition/income), extracted off the
 * generic `customers` table (see migrations/0014) into this module's own
 * 1:1 `bc_rebate_customer_profiles` table. This file is the single
 * authoritative storage layer for that data — rebate.ts consumes it for
 * eligibility computation but does not touch storage itself, and index.ts's
 * customer create/update routes are the only writers.
 *
 * Optional per customer, exactly as it was as blank/null `customers`
 * columns before this phase ("do not assume these fields apply to every
 * customer" — the original Phase 3 design intent, preserved): a customer
 * with no rebate-track data on file simply has no row here.
 */

export interface CustomerRebateProfile {
  house_size: number | null;
  primary_heating_source: string;
  number_of_adults: number | null;
  number_of_children: number | null;
  household_income: number | null;
}

interface CustomerRebateProfileJoinRow extends CustomerRebateProfile {
  customer_id: number;
}

/** Returns `customerId`'s rebate profile, or `null` only when the customer
 *  itself doesn't exist. A customer that exists but has no profile row on
 *  file (never a rebate-track customer, or converted from a Lead) returns
 *  the same all-blank shape a legacy blank `customers` row always did —
 *  never a false "not found." */
export async function getCustomerRebateProfile(customerId: number): Promise<CustomerRebateProfile | null> {
  const row = await get<CustomerRebateProfileJoinRow>(
    `SELECT c.id as customer_id,
            p.house_size, COALESCE(p.primary_heating_source, '') as primary_heating_source,
            p.number_of_adults, p.number_of_children, p.household_income
     FROM customers c
     LEFT JOIN bc_rebate_customer_profiles p ON p.customer_id = c.id
     WHERE c.id = ?`,
    [customerId]
  );
  if (!row) return null;
  return {
    house_size: row.house_size ?? null,
    primary_heating_source: row.primary_heating_source ?? "",
    number_of_adults: row.number_of_adults ?? null,
    number_of_children: row.number_of_children ?? null,
    household_income: row.household_income ?? null,
  };
}

/** Creates or updates `customerId`'s rebate profile row — the single
 *  authoritative write path (see index.ts's createCustomer/updateCustomer,
 *  the only two callers). Callers only invoke this when the incoming
 *  request actually touches at least one rebate field; `profile` must
 *  already be the full EFFECTIVE state (existing values merged with the
 *  request's changes), not just the fields present in one partial PUT. */
export async function upsertCustomerRebateProfile(customerId: number, profile: CustomerRebateProfile): Promise<void> {
  await run(
    `INSERT INTO bc_rebate_customer_profiles
       (customer_id, house_size, primary_heating_source, number_of_adults, number_of_children, household_income, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(customer_id) DO UPDATE SET
       house_size = excluded.house_size,
       primary_heating_source = excluded.primary_heating_source,
       number_of_adults = excluded.number_of_adults,
       number_of_children = excluded.number_of_children,
       household_income = excluded.household_income,
       updated_at = excluded.updated_at`,
    [
      customerId, profile.house_size, profile.primary_heating_source,
      profile.number_of_adults, profile.number_of_children, profile.household_income,
    ]
  );
}

/** SQL fragment (joined against a `customers c` query) that overrides the
 *  legacy, no-longer-written `customers` rebate columns with this table's
 *  authoritative values — reused verbatim by every read call site that
 *  still needs to return a full Customer shape (listCustomers, getCustomer,
 *  the post-Lead-conversion customer fetch) so the public API response
 *  shape is completely unchanged by this phase's storage move. Column
 *  order matters: these must be selected AFTER `c.*` so they win when the
 *  driver builds the row object from duplicate column names. */
export const CUSTOMER_REBATE_PROFILE_JOIN =
  `LEFT JOIN bc_rebate_customer_profiles crp ON crp.customer_id = c.id`;
export const CUSTOMER_REBATE_PROFILE_OVERRIDE_COLUMNS =
  `crp.house_size, COALESCE(crp.primary_heating_source, '') as primary_heating_source,
   crp.number_of_adults, crp.number_of_children, crp.household_income`;
