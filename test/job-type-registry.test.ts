import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  entryStatus, forwardTransitions, getJobTypeDefinition, isJobType, isTerminalStatus,
  JOB_TYPES, listJobTypeDefinitions, STATUS_LABELS, WORKFLOWS, type JobType,
} from "../src/server/workflow.js";
import { JOB_TYPE_LABELS, JOB_TYPE_OPTIONS } from "../src/client/job-type-labels.js";
import { applySchema, authHeaders, createCustomer, post, resetDatabase } from "./helpers.js";

// Phase 11.2 — the job-type/workflow registry is now the single authoritative
// source workflow.ts derives JobType/JOB_TYPES/isJobType/WORKFLOWS from (see
// workflow.ts's own header comment). These tests pin the exact pre-refactor
// behavior so the registry composition can never silently drift, and cover
// the accessor API/unknown-type safety requirements the Phase 11.2 task
// specified.

describe("job-type registry — Phase 11.2", () => {
  it("registers exactly the 3 expected job types, in the expected order", () => {
    expect(JOB_TYPES).toEqual(["STANDARD", "CLEANBC", "BC_HYDRO"]);
  });

  it("has unique job-type IDs", () => {
    expect(new Set(JOB_TYPES).size).toBe(JOB_TYPES.length);
  });

  it("resolves each job type to its exact pre-11.2 workflow sequence", () => {
    expect(WORKFLOWS.STANDARD).toEqual(["scheduled", "in_progress", "completed", "invoiced"]);
    expect(WORKFLOWS.CLEANBC).toEqual([
      "free_estimate", "application_pending", "eligibility_approved",
      "install_scheduled", "in_progress", "completed", "gov_portal_submitted",
    ]);
    expect(WORKFLOWS.BC_HYDRO).toEqual([
      "free_estimate", "install_scheduled", "in_progress", "completed", "gov_portal_submitted",
    ]);
  });

  it("getJobTypeDefinition/listJobTypeDefinitions agree with WORKFLOWS for every registered type", () => {
    for (const id of JOB_TYPES) {
      expect(getJobTypeDefinition(id).statusSequence).toEqual(WORKFLOWS[id]);
    }
    const listed = listJobTypeDefinitions();
    expect(listed.map((e) => e.id)).toEqual(JOB_TYPES);
    for (const entry of listed) {
      expect(entry.definition.statusSequence).toEqual(WORKFLOWS[entry.id]);
    }
  });

  it("entryStatus() matches each workflow's first status, unchanged from before 11.2", () => {
    expect(entryStatus("STANDARD")).toBe("scheduled");
    expect(entryStatus("CLEANBC")).toBe("free_estimate");
    expect(entryStatus("BC_HYDRO")).toBe("free_estimate");
  });

  it("isTerminalStatus is still derived correctly: invoiced (STANDARD) and gov_portal_submitted (CLEANBC/BC_HYDRO)", () => {
    expect(isTerminalStatus("invoiced")).toBe(true);
    expect(isTerminalStatus("gov_portal_submitted")).toBe(true);
    expect(isTerminalStatus("scheduled")).toBe(false);
    expect(isTerminalStatus("completed")).toBe(false);
  });

  it("rejects an unrecognized job type — no silent default, isJobType() returns false", () => {
    expect(isJobType("BOGUS")).toBe(false);
    expect(isJobType("standard")).toBe(false); // case-sensitive, no fuzzy matching
    expect(isJobType("")).toBe(false);
  });

  it("indexing WORKFLOWS with an unregistered key returns undefined, never a silent STANDARD fallback", () => {
    expect((WORKFLOWS as Record<string, readonly string[] | undefined>).BOGUS).toBeUndefined();
  });

  it("forwardTransitions returns no candidates for an unrecognized status in a real job type", () => {
    expect(forwardTransitions("STANDARD" as JobType, "not_a_real_status")).toEqual([]);
  });

  it("the registry is frozen — direct mutation of WORKFLOWS/JOB_TYPES does not corrupt the module singleton", () => {
    const before = JSON.stringify(WORKFLOWS);
    try {
      WORKFLOWS.STANDARD = ["hacked"];
    } catch {
      // Object.freeze on the underlying registry throws in strict-mode ESM; either
      // outcome (throw, or silent no-op) is acceptable — what matters is WORKFLOWS
      // itself is unaffected either way, asserted below.
    }
    expect(JSON.stringify(WORKFLOWS)).toBe(before);
  });

  it("STATUS_LABELS carries both Core's generic statuses and the BC module's program-specific statuses", () => {
    expect(STATUS_LABELS.scheduled).toBe("Scheduled");
    expect(STATUS_LABELS.cancelled).toBe("Cancelled");
    expect(STATUS_LABELS.eligibility_approved).toBe("Eligibility Approved");
    expect(STATUS_LABELS.gov_portal_submitted).toBe("Gov Portal Submitted");
  });

  it("client job-type mirror (job-type-labels.ts) stays in sync with the server registry", () => {
    // Server and client are separate bundles (see docs/PLATFORM-GENERALIZATION-AUDIT.md
    // Phase 11.1 addendum) — job-type-labels.ts is necessarily a second physical
    // declaration, not an import of workflow.ts. This test is the safety net that
    // keeps the two from silently drifting apart.
    expect([...JOB_TYPE_OPTIONS].sort()).toEqual([...JOB_TYPES].sort());
    for (const id of JOB_TYPES) {
      expect(Object.prototype.hasOwnProperty.call(JOB_TYPE_LABELS, id)).toBe(true);
    }
  });
});

describe("job-type registry — unknown-value API safety", () => {
  beforeAll(async () => {
    await applySchema();
  });
  beforeEach(async () => {
    await resetDatabase();
  });

  it("rejects job creation with an unsupported job_type — 400, not 500, not created, not silently defaulted", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const res = await post<{ error?: string }>("/api/jobs", {
      customer_id: customer.id,
      service_type_id: 1,
      scheduled_date: "2026-09-01",
      job_type: "BOGUS",
    }, auth);
    expect(res.response.status).toBe(400);
  });
});
