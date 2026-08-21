# HVAC industry module (server) — reserved, no code yet

No server file currently lives here. Phase 11.2 (see
`docs/PLATFORM-GENERALIZATION-AUDIT.md` §22) turned `src/server/workflow.ts`'s
`WORKFLOWS`/`JobType` into a registry composed from Core's own `STANDARD`
definition plus data contributed by `modules/programs/bc/` — but the
generic workflow *engine* (`forwardTransitions`, `transitionJob`, the
registry composition itself) stays in Core's `workflow.ts`, not here,
because the engine and the registry it closes over must share one module
scope (see workflow.ts's own header comment for the full reasoning). This
directory remains reserved for genuinely HVAC-industry-specific server
code, should any emerge in a later phase — there is currently none, since
`STANDARD` (Core's own default) is the only non-program job type and
nothing HVAC-specific has been identified beyond it.
