# Server modules

Industry and regional-program carve-outs from the Core server domain
(`src/server/*.ts`, outside this directory). Established in Phase 11.1 —
see `docs/PLATFORM-GENERALIZATION-AUDIT.md` for the full rationale, its
Phase 11.1 addendum (§21) for what did/didn't move and why, and its Phase
11.2 addendum (§22) for the data-driven job-type/workflow registry.

- **Core** = everything in `src/server/` outside this directory. Must
  never import from `modules/**`, with two documented exceptions:
  `src/server/index.ts` (the route-composition root, allowed to import
  every module) and `src/server/workflow.ts` (Phase 11.2 — allowed to
  import ONLY `modules/programs/bc/workflow-definitions.ts`'s pure data,
  to compose the job-type/workflow registry in the same module scope as
  the engine functions that consume it; see workflow.ts's own header
  comment).
- **`modules/hvac/`** = reserved for HVAC-industry-specific code. Still
  empty after Phase 11.2 — `STANDARD` (Core's own generic default job
  type) is not HVAC-specific, so there was nothing to move here; this
  directory remains reserved for genuinely HVAC-only code, should any
  emerge in a later phase.
- **`modules/programs/bc/`** = British Columbia rebate-program code
  (CleanBC, BC Hydro): `rebate.ts` (eligibility/audit business logic) and
  `workflow-definitions.ts` (Phase 11.2 — pure status-sequence/label data,
  no logic). May depend on Core. May depend on `modules/hvac/` only when
  genuinely necessary (not the reverse).

Run `pnpm run check:architecture` to verify these boundaries are still
respected — it's a plain Node script (not a vitest test; the Workers test
pool sandboxes away real filesystem access, so a scanning check can't live
inside `pnpm test` — see the script's own header comment).
