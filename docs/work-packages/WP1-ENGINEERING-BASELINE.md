# WP1 — Engineering Baseline and Regression Harness

## Scope

WP1 establishes enforceable engineering checks around the existing product. It intentionally does not add or redesign product functionality. The baseline covers strict TypeScript, deterministic integration tests, TypeScript/Preact linting, CI, and tracked project documentation.

Starting repository state:

- Branch: `main`
- Starting commit: `28841beeec9187d989acc16d0902ab624be9fccc`
- Working tree: clean
- Package scripts: `dev` and `build` only
- Build: passing
- TypeScript: failing
- Tests: no framework, files, or script
- Lint: no framework, configuration, or script
- CI: `.github/workflows/sync-branches.yml` only synchronized `main` and `master`; it did not verify code
- Documentation: `.gitignore` ignored all of `docs/`, including `docs/PRODUCT-GAP-AUDIT.md`

## Original TypeScript failures

`corepack pnpm exec tsc --noEmit` produced 15 diagnostics in `src/server/index.ts`:

- One `TS2552` at line 4 because the Cloudflare `D1Database` runtime type was not part of the TypeScript project.
- Fourteen `TS2345` handler/response incompatibilities at the original lines 181, 240, 295, 439, 484, 522, 537, 577, 657, 678, 703, 778, 802, 884, and 979. These involved jobs, job detail, job creation, job notes, customers, customer lookups/detail/creation, technicians, technician lookups/creation, service types, schedule, and materials.

The response failures had one shared root cause: concrete OpenAPI response schemas were paired with query results declared as `Record<string, unknown>`. Hono correctly rejected those handlers because a generic record does not prove the required response fields exist.

## Changes

### TypeScript contracts

- Generated `worker-configuration.d.ts` using `wrangler types`, giving the project runtime and binding types derived from `wrangler.toml`.
- Included the generated declaration, test TypeScript, and Vitest configuration in `tsconfig.json` without weakening `strict` or other compiler checks.
- Derived database row types from the existing Zod/OpenAPI schemas with `z.infer` and applied them to database reads.
- Extracted the existing inline material response shape into `MaterialSchema` so the route contract and query row type share one definition.
- Added narrow internal row interfaces for checklist items and joined job materials.
- Added the non-emitting `typecheck` package script.

No `any`, `@ts-ignore`, `@ts-nocheck`, global strictness reduction, or response-schema removal was used.

### Regression tests

Vitest 4 with `@cloudflare/vitest-pool-workers` was selected because Cloudflare recommends its Workers integration and it executes the real Worker module against local Miniflare/D1 bindings. Tests do not use a remote Worker, production D1, credentials, or secrets.

`vitest.config.ts` reads the existing `src/server/schema.sql` into a test-only binding. `test/api.test.ts` applies it to the isolated D1 binding, resets data deterministically before every test, and makes HTTP requests through the Worker's exported `fetch` handler.

Baseline coverage includes:

1. Customer creation, search, update, detail, and service history.
2. Technician creation, update, list, and active lookup behavior.
3. Seeded service types and service-type CRUD.
4. Seeded materials and material catalog CRUD.
5. Job creation with existing customer-address and service price/duration defaults.
6. Job material attachment and joined job-detail response.
7. Invoice line, subtotal, tax, total, identifier, and detail behavior.
8. Schedule API inclusive filtering over an arbitrary 31-day range, proving the backend is not limited to seven days.

The suite has one test file and eight tests. Storage is local and isolated; tests are deterministic and non-interactive.

### Lint

- Added ESLint flat configuration using ESLint's recommended rules, typescript-eslint recommended rules, browser/Worker globals, and the React Hooks rules that also apply to Preact hooks.
- Added the `lint` package script.
- Removed four existing unused symbols identified by lint: `useState` and `Search` from `invoice-list.tsx`, `JobStatus` from `job-list.tsx`, and unused `technicianLookup` destructuring from `schedule-view.tsx`.

No broad safety-rule disable was added.

### CI

`.github/workflows/quality.yml` runs on pull requests and pushes to `main`/`master` using Node 22. It performs, in order:

1. `corepack pnpm install --frozen-lockfile`
2. `corepack pnpm run typecheck`
3. `corepack pnpm run test`
4. `corepack pnpm run lint`
5. `corepack pnpm run build`

The workflow has read-only repository permissions and requires no production credentials. It adds no deployment behavior. The existing branch-sync workflow is unchanged.

### Documentation tracking

- Removed the blanket `docs/` ignore rule rather than force-adding documentation.
- Added local Wrangler state and coverage output to `.gitignore`.
- `docs/PRODUCT-GAP-AUDIT.md` and this WP1 record are now normal tracked project files.

## Quality gates

The required local acceptance sequence is:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm run typecheck
corepack pnpm run test
corepack pnpm run lint
corepack pnpm run build
```

All five commands must pass before WP1 is complete. Test output must report one passing test file, eight passing tests, zero failures, and zero skipped tests.

## Deferred issues

The following audited problems remain intentionally deferred to later work packages:

- Migration, transaction, identifier-race, deletion/integrity, money, and timezone redesign.
- Authentication, RBAC, company isolation, and production security.
- Day/month calendar modes, schedule UX redesign, availability, conflicts, drag/drop, and recurrence generation.
- Reports/analytics.
- Properties/service locations, HVAC equipment, estimates/quotes, payments, and maintenance agreements.
- Broader frontend component/E2E/accessibility coverage beyond the WP1 backend-first regression baseline.
- OpenAPI invoice responses that currently use `z.any()`; replacing them requires a wider contract review and is not necessary to make the existing strict check pass.

No deferred functionality was implemented in WP1.
