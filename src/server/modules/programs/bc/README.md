# BC regional-program module (server)

`rebate.ts` — CleanBC / BC Hydro eligibility calculator and audit trail
(moved here unchanged from `src/server/rebate.ts` in Phase 11.1; zero
logic change, only its own `db.js`/`settings.js`/`workflow.js` import
paths were updated for the new depth). Imported by the composition root
(`src/server/index.ts`) only.

Depends on Core (`db.js`, `settings.js`, the `JobType` type from
`workflow.js`) — correct direction. Every real threshold value is read
from Global Settings at call time; nothing here hardcodes a government
dollar/square-footage/day figure (see the file's own top-of-file comment).
