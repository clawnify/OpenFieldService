# Server modules

Industry and regional-program carve-outs from the Core server domain
(`src/server/*.ts`, outside this directory). Established in Phase 11.1 —
see `docs/PLATFORM-GENERALIZATION-AUDIT.md` for the full rationale and
`docs/PLATFORM-GENERALIZATION-AUDIT.md`'s Phase 11.1 addendum for what
did/didn't move and why.

- **Core** = everything in `src/server/` outside this directory. Must
  never import from `modules/**`, with one exception: `src/server/index.ts`
  (the route-composition root) is allowed to import every module — that's
  its job.
- **`modules/hvac/`** = reserved for HVAC-industry-specific code. Empty as
  of Phase 11.1 — nothing in the current codebase was safe to move here
  without also touching `workflow.ts`'s `JobType`/`WORKFLOWS` (deferred to
  Phase 11.2, since that's a real logic change, not a file move).
- **`modules/programs/bc/`** = British Columbia rebate-program code
  (CleanBC, BC Hydro). May depend on Core. May depend on `modules/hvac/`
  only when genuinely necessary (not the reverse).

Run `pnpm run check:architecture` to verify these boundaries are still
respected — it's a plain Node script (not a vitest test; the Workers test
pool sandboxes away real filesystem access, so a scanning check can't live
inside `pnpm test` — see the script's own header comment).
