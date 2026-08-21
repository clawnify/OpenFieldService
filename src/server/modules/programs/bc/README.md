# BC regional-program module (server)

`rebate.ts` — CleanBC / BC Hydro eligibility calculator and audit trail
(moved here unchanged from `src/server/rebate.ts` in Phase 11.1; zero
logic change, only its own `db.js`/`settings.js`/`workflow.js` import
paths were updated for the new depth). Imported by the composition root
(`src/server/index.ts`) only.

`workflow-definitions.ts` — added in Phase 11.2. Pure status-sequence and
status-label DATA for CLEANBC/BC_HYDRO, no business logic. Imported by
`../../../workflow.js` (Core) only — that file is a documented, narrow
exception to the "Core never imports modules/**" rule (see its own header
comment and `docs/PLATFORM-GENERALIZATION-AUDIT.md` §22), needed because
Core's job-type/workflow registry must be composed in the same module
scope as the engine functions that consume it.

Depends on Core (`db.js`, `settings.js`, the `JobType` type from
`workflow.js`) — correct direction. Every real threshold value is read
from Global Settings at call time; nothing here hardcodes a government
dollar/square-footage/day figure (see `rebate.ts`'s own top-of-file
comment).
