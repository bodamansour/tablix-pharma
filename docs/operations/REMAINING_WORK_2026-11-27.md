# Follow-up verification — 2026-11-27

Base: `1214702e7921529e82840551ece77befc3c61348`. Changes prepared on `fix/account-session-safety`; no production deployment performed during this follow-up.

## Implemented

- Mobile queues belong to a user and API server. Logout preserves pending/refused work. Unknown-owner legacy data remains quarantined, as explicitly approved by the owner. See [recovery procedure and limits](MOBILE_QUEUE_RECOVERY.md).
- Password login checks the validated hash again when issuing the session. Legacy password rehash uses compare-and-set, so it cannot overwrite a concurrent reset.
- Password change updates the hash, revokes old sessions and issues its replacement in one conditional transaction. A stale check leaves the newer password and sessions untouched; an insertion failure rolls everything back.
- Signup insertion conflicts return the existing account-conflict error. Signout lookup failures no longer return false success.
- Android PR builds cannot access the release signing step. Only main can sign/publish, and missing signing configuration fails publication instead of encouraging uninstalling an app with unsent work.

## Validation

- Root JavaScript tests: 357 passed. After the Android workflow change, its six release tests passed, including one newly added signing guard test.
- Worker local runtime: 59 passed; test keys generated in memory. Worker stopped afterward.
- Mobile: 32 passed and analyzer clean in the previous verification of the unchanged mobile implementation.
- Physical device discovery: no Android device connected. No APK installed, app data removed, or production transaction created.

## Actual Cloudflare CPU observation

Read-only GraphQL query restricted to `tablix-staging`, 2026-11-26 10:43:43 UTC through 2026-11-27 10:43:43 UTC. Exact response: [STAGING_CPU_2026-11-27.json](STAGING_CPU_2026-11-27.json).

72 cron invocations, all reported success, zero errors. CPU p50: 80,947 microseconds (80.947 ms); p99: 177,154 microseconds (177.154 ms). Units verified from Cloudflare GraphQL schema descriptions. Deployed Worker version: `1164ae55-24f3-421a-a4ed-796a86129b97`.

This is aggregate cron telemetry from the existing staging deployment, not a benchmark of this unmerged patch, not a per-row cost, and not an isolated sealing measurement. It does not prove that application-level seal/backup operations succeeded, because handled errors may still yield successful invocations. `SEAL_BUDGET` remains unchanged at 150.

## Still requires work or user resources

Follow-up telemetry separated the two schedules: 48 backup invocations had CPU median 96 ms and p99 177 ms; 24 hourly sealing/reminder invocations had median 1 ms and p99 2 ms. All outcomes were `ok`. Application summaries showed all 24 seals had zero pharmacies and zero rows to seal. This is an idle sealing measurement, not a loaded sealing benchmark.

The latest sampled backup-health alert checked 383 tenants and reported 20 with a good backup older than 36 hours. At five tenants every 30 minutes, a complete sweep requires 77 runs, or 38.5 hours. This patch proposes changing staging backups to every 20 minutes (about 25 hours 40 minutes for the same population). Batch size remains five; the exact schedule allowlist and isolation tests are updated together. Production schedules and `SEAL_BUDGET` are unchanged. 37 staging guard/isolation tests passed. This increases staging backup invocations from 48 to 72 per day; it is not deployed, and actual freshness must be checked after a full sweep. If the fixture population keeps growing, this fixed schedule will need revisiting. Evidence: [STAGING_CRON_2026-11-27.json](STAGING_CRON_2026-11-27.json), with no tenant identifiers.

- Review/build this patch in CI, then explicitly approve the concrete merge/release. A merge touching mobile automatically triggers its main APK release workflow.
- Test camera, offline lifecycle, account switching, updates preserving data, and notifications on a physical phone. Never uninstall to work around a signature mismatch.
- Run a loaded synthetic sealing benchmark and verify backup freshness after deploying the proposed staging cadence. The current idle measurement does not close that benchmark item.
- Production Google/email configuration remains incomplete; owner confirmed no owned domain. Android Google OAuth client and signing-certificate setup remain outstanding.
- Paymob/WhatsApp external account setup and provider tests, and the deferred Anthropic OCR activation, are not completed here.
- Manual review/import of unknown-owner queue records, refused-shift receipt reconciliation, full snapshot validation, and Electron unavailable-OS-encryption behavior remain separate follow-ups; none is silently enabled by this patch.
