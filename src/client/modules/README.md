# Client modules

Industry and regional-program carve-outs from the Core client domain
(`src/client/*.ts(x)` and `src/client/components/*.tsx`, outside this
directory). Established in Phase 11.1 — see
`docs/PLATFORM-GENERALIZATION-AUDIT.md` for the full rationale, its Phase
11.1 addendum (§21), and its Phase 11.2 addendum (§22).

- **Core** = everything in `src/client/` outside this directory. Must
  never import from `modules/**`, with one exception: `src/client/app.tsx`
  (the route-composition root) is allowed to import every module.
- **`modules/hvac/`** = reserved for HVAC-industry-specific UI. Still empty
  after Phase 11.2 — `job-type-labels.ts` (the client-side mirror of
  `JobType`) stays in Core permanently, not just deferred: the
  server/client bundle boundary means it can never import the server's
  registry (`src/server/workflow.ts`), so there is nothing for it to move
  "alongside." Phase 11.2 instead added `test/job-type-registry.test.ts`,
  which imports both this file's `JOB_TYPE_OPTIONS`/`JOB_TYPE_LABELS` and
  the server's `JOB_TYPES` and asserts they match — an automated
  consistency check in place of a shared source file.
- **`modules/programs/bc/`** = British Columbia rebate-program UI
  (`eligibility-tracker.tsx`).

Run `pnpm run check:architecture` (from the repo root) to verify these
boundaries are respected.
