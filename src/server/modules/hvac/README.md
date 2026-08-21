# HVAC industry module (server) — reserved, no code yet

No server file currently lives here. `jobs.job_type`'s HVAC/rebate-program
values (`CLEANBC`, `BC_HYDRO`) and their `WORKFLOWS` sequences are still
defined in core `src/server/workflow.ts`, tightly coupled to the generic
workflow *engine* that also lives there. Splitting the *data* (which job
types/statuses exist) from the *engine* (the state-machine mechanics) is
real logic work, not a file move — reserved for Phase 11.2 ("Extract
`job_type`/`WORKFLOWS` into a data-driven registry").

See `docs/PLATFORM-GENERALIZATION-AUDIT.md` sections 4, 10, and 11 for the
full analysis of why this wasn't moved in Phase 11.1.
