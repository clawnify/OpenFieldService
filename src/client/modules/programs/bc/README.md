# BC regional-program module (client)

`eligibility-tracker.tsx` — the CleanBC / BC Hydro eligibility-code
tracker page (moved here unchanged from
`src/client/components/eligibility-tracker.tsx` in Phase 11.1; zero
logic/behavior change, only its own relative import paths were updated
for the new depth). Imported by the composition root (`src/client/app.tsx`)
only — routed to for the admin/dispatcher "Eligibility Tracker" nav item.

Depends on Core (`context`, `auth-context`, `api`,
`components/status-badge`, `types`) — correct direction.
