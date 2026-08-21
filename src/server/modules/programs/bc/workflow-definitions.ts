/**
 * Phase 11.2 — pure workflow-SHAPE data for the BC regional programs
 * (CleanBC, BC Hydro). No business logic lives here — see rebate.ts in this
 * same module for eligibility/dispatch behavior, which is unchanged by this
 * file and still owned by Phase 11.3's future extraction. This file exists
 * solely so Core's job-type/workflow registry (../../../workflow.js) can
 * compose CLEANBC/BC_HYDRO's status sequence and status labels from data
 * that physically lives in the BC module, rather than as literals inline in
 * Core. See workflow.ts's own header comment for why Core is allowed to
 * import this one file (a narrowly-scoped composition-root exception).
 */

export const BC_PROGRAM_JOB_TYPES = {
  CLEANBC: {
    statusSequence: [
      "free_estimate", "application_pending", "eligibility_approved",
      "install_scheduled", "in_progress", "completed", "gov_portal_submitted",
    ],
    // Phase 11.3 — moved out of Core's transitionJob(), which previously
    // hardcoded the literal status name "eligibility_approved". Only
    // CLEANBC requires an eligibility code/expiry to reach this status;
    // BC_HYDRO has no such status in its own sequence at all.
    eligibilityCodeGateStatus: "eligibility_approved",
  },
  BC_HYDRO: {
    statusSequence: ["free_estimate", "install_scheduled", "in_progress", "completed", "gov_portal_submitted"],
  },
};

export const BC_PROGRAM_STATUS_LABELS: Record<string, string> = {
  free_estimate: "Free Estimate",
  application_pending: "Application Pending",
  eligibility_approved: "Eligibility Approved",
  install_scheduled: "Install Scheduled",
  gov_portal_submitted: "Gov Portal Submitted",
};
