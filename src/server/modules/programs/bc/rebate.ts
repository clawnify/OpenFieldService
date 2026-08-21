import { query, run } from "../../../db.js";
import { getSettingValue } from "../../../settings.js";
import type { JobType } from "../../../workflow.js";
import type { CustomerRebateProfile } from "./customer-profile.js";

/**
 * Rebate eligibility calculator and audit trail. Layered entirely on top of
 * Phase 1's Global Settings (thresholds) and Phase 2's workflow engine (the
 * eligibility_code/eligibility_code_expiry gate on the "eligibility_approved"
 * transition, unchanged) — this module does not touch transition validation.
 * Customer rebate-profile storage itself lives in ./customer-profile.ts
 * (Phase 11.3) — this file only computes eligibility from a profile handed
 * to it, it never queries `customers`/`bc_rebate_customer_profiles` directly.
 *
 * No threshold value is ever hardcoded here. Every comparison reads its limit
 * via getSettingValue(); an unconfigured key means "cannot evaluate this
 * criterion," reported as such, never silently skipped or defaulted.
 */

export interface RebateCriterion {
  key: string;
  label: string;
  /** null = the governing threshold isn't configured in Global Settings yet —
   *  distinct from `false` (configured, and the customer doesn't meet it). */
  satisfied: boolean | null;
  detail: string;
}

export interface RebateEligibilityResult {
  job_type: JobType;
  /** null if the job type has no rebate criteria (STANDARD) or any criterion
   *  couldn't be evaluated (a threshold isn't configured yet). */
  allowed: boolean | null;
  criteria: RebateCriterion[];
  thresholds_used: Record<string, number | null>;
}

async function houseSizeCriterion(
  organizationId: number, profile: CustomerRebateProfile, asOf: string | undefined, key: string, used: Record<string, number | null>
): Promise<RebateCriterion> {
  const max = await getSettingValue<number>(organizationId, key, asOf);
  used[key] = max;
  if (max === null) {
    return { key: "house_size", label: "House size within program limit", satisfied: null, detail: `${key} is not configured in Global Settings` };
  }
  if (profile.house_size === null) {
    return { key: "house_size", label: "House size within program limit", satisfied: false, detail: "Customer house size is not on file" };
  }
  const satisfied = profile.house_size <= max;
  return {
    key: "house_size", label: "House size within program limit", satisfied,
    detail: `${profile.house_size} sq ft (limit ${max} sq ft)`,
  };
}

async function incomeCriterion(
  organizationId: number, profile: CustomerRebateProfile, asOf: string | undefined, key: string, used: Record<string, number | null>
): Promise<RebateCriterion> {
  const max = await getSettingValue<number>(organizationId, key, asOf);
  used[key] = max;
  if (max === null) {
    return { key: "household_income", label: "Household income within program limit", satisfied: null, detail: `${key} is not configured in Global Settings` };
  }
  if (profile.household_income === null) {
    return { key: "household_income", label: "Household income within program limit", satisfied: false, detail: "Customer household income is not on file" };
  }
  const satisfied = profile.household_income <= max;
  return {
    key: "household_income", label: "Household income within program limit", satisfied,
    detail: `$${profile.household_income.toLocaleString()} (limit $${max.toLocaleString()})`,
  };
}

/** Phase 11.3 — registry-based program dispatch, owned entirely by this BC
 *  module: each entry's `buildCriteria` is the ONLY place a program's own
 *  criteria are assembled, replacing the previous inline
 *  `if (jobType === "CLEANBC") ... else if (jobType === "BC_HYDRO")` chain.
 *  A job type with no entry here (STANDARD, or any future non-rebate job
 *  type) safely yields zero criteria — never a crash, and never a silent
 *  fallback onto another program's rules. Frozen: this module is the only
 *  place a program may ever be registered. */
const REBATE_PROGRAM_REGISTRY: Readonly<Partial<Record<JobType, {
  buildCriteria(organizationId: number, profile: CustomerRebateProfile, asOf: string | undefined, used: Record<string, number | null>): Promise<RebateCriterion[]>;
}>>> = Object.freeze({
  CLEANBC: {
    async buildCriteria(organizationId, profile, asOf, used) {
      return Promise.all([
        houseSizeCriterion(organizationId, profile, asOf, "CLEANBC_MAX_HOUSE_SIZE", used),
        incomeCriterion(organizationId, profile, asOf, "CLEANBC_MAX_HOUSEHOLD_INCOME", used),
      ]);
    },
  },
  BC_HYDRO: {
    async buildCriteria(organizationId, profile, asOf, used) {
      return Promise.all([incomeCriterion(organizationId, profile, asOf, "BC_HYDRO_MAX_HOUSEHOLD_INCOME", used)]);
    },
  },
});

/** Computes (does not persist) whether a customer's rebate profile currently
 *  appears eligible for `jobType`'s program, per whatever thresholds are
 *  configured (for `organizationId`) as of `asOf` (default now). Pass a past
 *  ISO timestamp to reproduce a historical evaluation exactly as it was
 *  computed at the time — see recordEligibilityCheck() for the persisted/
 *  audited version of this. */
export async function evaluateRebateEligibility(
  organizationId: number, jobType: JobType, profile: CustomerRebateProfile, asOf?: string
): Promise<RebateEligibilityResult> {
  const thresholdsUsed: Record<string, number | null> = {};
  const program = REBATE_PROGRAM_REGISTRY[jobType];
  const criteria = program ? await program.buildCriteria(organizationId, profile, asOf, thresholdsUsed) : [];
  const allowed = criteria.length === 0 || criteria.some((c) => c.satisfied === null)
    ? null
    : criteria.every((c) => c.satisfied);
  return { job_type: jobType, allowed, criteria, thresholds_used: thresholdsUsed };
}

export interface RebateAuditRow {
  id: number;
  job_id: number;
  event_type: "eligibility_check" | "code_updated" | "expiry_updated";
  actor_user_id: number | null;
  details: string;
  created_at: string;
}

/** Computes AND persists an eligibility check as an auditable event — this is
 *  the historically-reproducible record: `details` snapshots both the customer
 *  profile used and the resolved threshold values at the moment of the check,
 *  so a later Global Settings change can never alter what this row says
 *  happened. */
export async function recordEligibilityCheck(
  organizationId: number, jobId: number, actorId: number, jobType: JobType, profile: CustomerRebateProfile
): Promise<RebateEligibilityResult> {
  const result = await evaluateRebateEligibility(organizationId, jobType, profile);
  await run(
    "INSERT INTO job_rebate_audit (job_id, event_type, actor_user_id, details) VALUES (?, 'eligibility_check', ?, ?)",
    [jobId, actorId, JSON.stringify({ profile, result })]
  );
  return result;
}

export async function recordEligibilityFieldChange(
  jobId: number, actorId: number, field: "code" | "expiry", oldValue: string, newValue: string
): Promise<void> {
  await run(
    "INSERT INTO job_rebate_audit (job_id, event_type, actor_user_id, details) VALUES (?, ?, ?, ?)",
    [jobId, field === "code" ? "code_updated" : "expiry_updated", actorId, JSON.stringify({ old: oldValue, new: newValue })]
  );
}

export async function getJobRebateAudit(jobId: number): Promise<RebateAuditRow[]> {
  return query<RebateAuditRow>(
    "SELECT * FROM job_rebate_audit WHERE job_id = ? ORDER BY created_at DESC, id DESC", [jobId]
  );
}

export type EligibilityCodeStatus = "expiring_soon" | "expired" | "active" | "submitted";

export interface EligibilityCodeRow {
  id: number;
  identifier: string;
  status: string;
  eligibility_code: string;
  eligibility_code_expiry: string;
  customer_name: string | null;
  technician_name: string | null;
  // Exposed only so the route layer (index.ts) can apply technician
  // ownership scoping (mem:risks/technician-job-read-scoping) — not
  // rendered in the client UI, which never displayed a raw id here anyway.
  technician_id: number | null;
  code_status: EligibilityCodeStatus;
  days_remaining: number | null;
}

/** Every CleanBC job with an eligibility code, classified into
 *  active/expiring_soon/expired/submitted. The expiring_soon/active split only
 *  happens if CLEANBC_ELIGIBILITY_WARNING_DAYS is configured — otherwise every
 *  non-expired, non-submitted code is reported "active" and the caller is told
 *  via `warningDaysConfigured: false` to prompt for configuration rather than
 *  silently guessing a warning window. */
export async function listEligibilityCodes(organizationId: number): Promise<{ rows: EligibilityCodeRow[]; warningDaysConfigured: boolean }> {
  const warningDays = await getSettingValue<number>(organizationId, "CLEANBC_ELIGIBILITY_WARNING_DAYS");
  const jobs = await query<{
    id: number; identifier: string; status: string; eligibility_code: string; eligibility_code_expiry: string;
    customer_name: string | null; technician_name: string | null; technician_id: number | null;
  }>(
    `SELECT j.id, j.identifier, j.status, j.eligibility_code, j.eligibility_code_expiry,
            c.name as customer_name, t.name as technician_name, j.technician_id as technician_id
     FROM jobs j
     LEFT JOIN customers c ON j.customer_id = c.id
     LEFT JOIN technicians t ON j.technician_id = t.id
     WHERE j.organization_id = ? AND j.job_type = 'CLEANBC' AND j.eligibility_code != ''
     ORDER BY j.eligibility_code_expiry ASC`,
    [organizationId]
  );
  const now = Date.now();
  const rows: EligibilityCodeRow[] = jobs.map((j) => {
    if (j.status === "gov_portal_submitted") {
      return { ...j, code_status: "submitted", days_remaining: null };
    }
    const expiryMs = new Date(j.eligibility_code_expiry).getTime();
    const daysRemaining = Number.isNaN(expiryMs) ? null : Math.ceil((expiryMs - now) / (1000 * 60 * 60 * 24));
    let codeStatus: EligibilityCodeStatus = "active";
    if (daysRemaining !== null && daysRemaining < 0) codeStatus = "expired";
    else if (daysRemaining !== null && warningDays !== null && daysRemaining <= warningDays) codeStatus = "expiring_soon";
    return { ...j, code_status: codeStatus, days_remaining: daysRemaining };
  });
  return { rows, warningDaysConfigured: warningDays !== null };
}

