# HVAC industry module (client) — reserved, no code yet

`src/client/job-type-labels.ts` was deliberately left in place rather than
moved here — see `src/client/modules/README.md` for why. Phase 11.2 (see
`docs/PLATFORM-GENERALIZATION-AUDIT.md` §22) made the server's `JobType`
registry-derived, but did **not** relocate `job-type-labels.ts`: the
server/client bundle boundary means the client's `JobType` mirror can
never import the server's registry, so there is nothing for this file to
move alongside. Instead, `test/job-type-registry.test.ts` automatically
verifies the two stay in sync. This file remains reserved for genuinely
HVAC-industry-specific client code, should any emerge in a later phase.
