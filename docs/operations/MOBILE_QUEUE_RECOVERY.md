# Mobile queue ownership and recovery

Implemented locally on 2026-11-26, based on main `1214702e7921529e82840551ece77befc3c61348`. This document does not assert that the mobile release has shipped.

## Account isolation

Pending writes and server-refused entries are stored together under `saydaliti.outbox.v2:<encoded API base>:<encoded user ID>`. Signing out clears the active in-memory queue but retains its stored entries. Signing in as another user cannot load or send the original user's queue. Account changes wait for an in-flight queue request before replacing credentials.

HTTP 401, 429, network errors and server errors leave entries pending. Permanent refusals are saved separately in the same account envelope, including across restarts. Malformed envelopes block writes and sending without replacing the original bytes.

## Legacy data: preserve, never infer ownership

The owner approved quarantine of legacy entries on 2026-11-26. The old unscoped `saydaliti.outbox` value is copied verbatim into a JSON array at `saydaliti.outbox.quarantine.v1`. The archive is read back before removing the old active key. Existing archive values are retained; exact duplicate raw payloads are not appended again. Damaged archives block migration and leave both originals untouched.

Nothing in quarantine is automatically sent, assigned to the next account, or deleted. Settings show an explanatory count only; unknown-account invoice contents are not exposed to the current user. There is deliberately no automatic restore button.

Manual recovery must preserve an independent copy first, establish the account and pharmacy from trusted records, and check each operation against server receipts to avoid duplicates. Do not directly copy quarantined entries into another account's queue. A reviewed recovery/import workflow remains future work.

SharedPreferences is the existing device-local store, not a transactional database or an independent backup. Clearing application data or uninstalling the app may remove these records. Do not use either operation as a troubleshooting step on a device with queued work.

## Validation

- Flutter suite: 32 passed, including eight queue/ownership regression tests.
- Flutter analyzer: no issues after removal of one redundant assertion.
- Covered: legacy quarantine, account/server separation, restart persistence, in-flight account changes, concurrent enqueue, corrupted data preservation, signout, and expired login.
- No physical Android device was connected for hardware validation. Camera, notification and device lifecycle tests remain outstanding.
- Worker code, production settings, secrets and `SEAL_BUDGET` were not changed by this patch.
