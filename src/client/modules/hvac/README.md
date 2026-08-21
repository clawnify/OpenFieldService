# HVAC industry module (client) — reserved, no code yet

`src/client/job-type-labels.ts` was deliberately left in place rather than
moved here — see `src/client/modules/README.md` for why. It will move
here alongside Phase 11.2's server-side `JobType`/`WORKFLOWS` registry
extraction, once the label lookup can be keyed off the same data-driven
registry instead of a hardcoded union mirror.
