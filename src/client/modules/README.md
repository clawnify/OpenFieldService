# Client modules

Industry and regional-program carve-outs from the Core client domain
(`src/client/*.ts(x)` and `src/client/components/*.tsx`, outside this
directory). Established in Phase 11.1 — see
`docs/PLATFORM-GENERALIZATION-AUDIT.md` for the full rationale.

- **Core** = everything in `src/client/` outside this directory. Must
  never import from `modules/**`, with one exception: `src/client/app.tsx`
  (the route-composition root) is allowed to import every module.
- **`modules/hvac/`** = reserved for HVAC-industry-specific UI. Empty as
  of Phase 11.1 — `job-type-labels.ts` (the client-side mirror of
  `JobType`) was deliberately NOT moved here yet, since it labels ALL
  three job types including the generic `STANDARD` one and is tightly
  paired with the still-core-resident `JobType` union in
  `src/server/workflow.ts`; moving only the label file while the union it
  labels stays in Core would split a coupled pair across the boundary in
  a confusing half-migrated state. It moves together with the union in
  Phase 11.2.
- **`modules/programs/bc/`** = British Columbia rebate-program UI
  (`eligibility-tracker.tsx`).

Run `pnpm run check:architecture` (from the repo root) to verify these
boundaries are respected.
