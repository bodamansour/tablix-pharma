# Six-item security review — 2026-11-25

Scope: `fix/invite-existing-member`, baseline `d88f340`. PR #90 had already been
merged before this request; current main `3fe6614` has the same tree as that
baseline. The remote feature branch was absent. This work is for the same branch
name only; no merge, deployment, workflow dispatch, force push, branch deletion,
production/staging load test, secret change, migration or SEAL_BUDGET change.

## Baseline and validation

- Initial `npm test` in the sandbox could not launch local workerd subprocesses.
- With subprocess permission: 351 passed, 2 failed, 54 skipped. Both failures
  were release-guard tests resolving Windows/WSL bash instead of Git Bash.
  Selecting installed Git Bash through PATH fixed the test environment, with no
  changes to the release guards or tests.
- Initial Worker suite: 55 passed, 1 failed, 1 skipped because the initial test
  invocation lacked SECRET_VALUES and WRANGLER_LOG. Final runs explicitly require
  the security test and pass ephemeral keys in memory to both Worker and tests.
- Worker build passed before changes and after changes.
- Final root `npm test`: 358 passed, 0 failed, 56 skipped (Worker-URL-dependent
  cases are executed separately below). Git Bash is first in PATH.
- Final Worker suite: 59 passed, 0 failed, 0 skipped, including the receipt-void
  test, both new limit tests and mandatory response/log secret-leak checks.
  Validation completed on 2026-11-25; report finalized on 2026-11-26.
- An earlier updated Worker run hit two transient local D1 "Failed to get session
  commit token" errors. A subsequent sequential run passed both new rate-limit
  tests but exposed accumulated password-reset source counters from earlier runs.
  A third run with a custom persistence path failed the existing audit test,
  which directly invokes D1 at its default path. Previous default local state was
  preserved as `worker/.wrangler/state-before-security-20261125`; final validation
  uses fresh local D1/R2 at the default path, real migrations, ephemeral
  test keys, and sequential test files. Failures were not hidden with retries in
  application code or weakened assertions.
- k6 is not installed. No k6 load test ran and no global tool was installed.
  Script syntax and the origin allowlist regression test passed.

## Commits and files (items 1–5)

| Item | Commit | Change and files |
| --- | --- | --- |
| 1 | `923073b` | Added malformed/unknown cashier-token regressions in `test/invite-cashier.test.js`. The requested behavior and missing/expired/wrong-account/employee/pharmacy tests already existed from `5dfb45d`, including `worker/src/index.js`, `worker/src/rpc.js`, `src/local-db.js`, `src/supabase-store.js` and `worker/test/api.test.mjs`. Sales remain accepted with `cashier_not_verified`; shifts and no-receipt return approvals require proof. |
| 2 | `e98be6a` | Atomic sliding-window limits: `worker/src/rate-limit.js`, `worker/src/index.js`, `test/request-limits.test.js`, `worker/test/rate-limits.test.mjs`. Counts requests, including refused writes; reads remain available. Separate per-account `pay:` and `db:` keys. |
| 3 | `9c08f27` | Pharmacy-wide failed-PIN counter plus existing account limit: `worker/src/rpc.js`, `test/pin-pharmacy-limit.test.js`, `worker/test/rate-limits.test.mjs`. Correct PINs do not add failures; even a correct PIN is refused with 429 while capped. Atomic failure bookkeeping prevents concurrent overruns. |
| 4 | `4f3667d` | `worker/.dev.vars.example`: empty values for all Worker/shared-job configuration reads, with bindings/internal values explained. `.dev.vars` remains ignored; `.dev.vars.example` is not ignored. Google secret is not read by this implementation. |
| 5 | `96dbe02` | `load/{smoke,load,spike,journey,target}.js`, `load/README.md`, `test/load-target.test.js`. Environment credentials, 2/5/25 VUs, p95 <800 ms, errors <1%, exact local/staging origins only, no redirects, production refused. |

## Item 6: local measurements, no caching added

Files: `load/measure-local.mjs` and this report. The measurement script is fixed
to loopback, generates credentials only in memory, creates synthetic data, makes
sequential reads and signs out. It leaves the synthetic fixture in local storage.
It never accesses production or staging. It is not part of automatic test discovery.

Fixture: 1000 sales, 1000 stock movements, two R2 snapshots with 5000 items each.
Queries mirror cashier sales loading and dashboard inventory/snapshot loading.
Each measurement is wall time including HTTP download and JSON parsing, one
first read followed by 20 samples, on local Wrangler/workerd. These are candidate
heavy app reads, not an exhaustive ranking of every application query.

| Read | Returned bytes | First ms | Median ms | p95 ms | Max ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1000 sales with lines and cashier/customer fields | 434803 | 42.96 | 46.68 | 61.04 | 71.35 |
| 1000 stock movements | 279913 | 42.47 | 46.07 | 54.23 | 80.63 |
| Latest two R2 snapshots (5000 items each) | 685721 | 47.68 | 46.27 | 51.44 | 66.26 |

Sales were slowest by p95 (61.04 ms). These numbers do not justify adding server
caching now. Keep current freshness semantics. If real telemetry later shows
latency problems, profile payload size, query plans and larger paginated ledgers
before deciding on cache scope/invalidation. This is not Cloudflare CPU, network
latency for customers, a concurrency benchmark, or evidence of production capacity.

## Needs decision / risks before any later merge

- Confirm 600 DB write requests per user per 10 minutes. This is a conservative
  initial choice, not proven against every offline backlog: the UI may sync one
  row per request, and a backlog over 600 needs retries after the window clears.
  This change does not add retry UX or alter sync conflict behavior.
- Confirm 10 payment-start requests per user per 15 minutes. Failed starts count
  as requests; the checkout integration itself was not called with real keys.
- Confirm 30 failed PINs per pharmacy per 15 minutes, alongside 20 per account.
  A member can temporarily deny PIN entry to the pharmacy by consuming the shared
  budget. This follows the owner's requested policy; correct PINs do not bypass it.
- PR #90 is already merged. Updating the recreated branch does not reopen it.
  A future PR/review is needed for these new commits; no new PR is created here.
- k6 execution and real-world capacity validation remain unperformed. No new
  background jobs or caching are introduced, and SEAL_BUDGET remains 150.
