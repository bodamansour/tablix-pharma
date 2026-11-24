# Staging Environment (isolated, synthetic data only)

Created 2026-11-03 with the owner's approval (staging only; no production deploy, secrets, migrations or backups).

## 1. Resource inventory

The staging resources live on the **same Cloudflare account** as production; that is the only thing they share.

| | Production (not touched) | Staging |
|---|---|---|
| Worker | `tablix` (`https://tablix.tablixpharma.workers.dev`) | `tablix-staging` (`https://tablix-staging.tablixpharma.workers.dev`) |
| D1 | `saydaliti`, `3cf7edd2-1642-428b-bf1b-973f71d93529` | `saydaliti-staging`, `0ba7c0dd-645e-453e-9999-a316a828e175` (EEUR) |
| R2 | `saydaliti-files` | `saydaliti-files-staging` |
| Worker secrets provisioned by this workflow | — | `BACKUP_KEY` and `AUDIT_SEAL_KEY` from GitHub staging secrets, plus a staging `PIN_PEPPER` generated at deploy time |
| Cron | `0 6 * * *`, `15 * * * *`, `30 1 * * *` | `*/30 * * * *` for backups and `15 * * * *` for audit seals |
| Deploy credential | GitHub `CLOUDFLARE_API_TOKEN` (manual release only) | GitHub `CLOUDFLARE_STAGING_API_TOKEN` (separate token, revocable on its own; to live in the `staging` environment) |
| Throwaway | — | D1 `saydaliti-staging-sqlcheck`, `20c6fee5-0723-4a70-b328-c58734473c1b`: used once to run the Worker's exact SQL on real D1 (synthetic rows). Can be deleted at any time; I didn't delete it without your say-so. |

Unrelated resources on the same account (`mosaed-cloud*` Workers, `mosaed-files*` buckets) are not used or touched.

## 2. How isolation is enforced

**Configuration.** `worker/wrangler.toml` `[env.staging]` defines its own Worker name, D1 and R2 bindings. Wrangler doesn't inherit bindings per environment, so staging can't silently fall back to production's.

**The guard** (`worker/scripts/staging-guard.mjs`). It fails closed: any doubt stops the job before wrangler runs. Production's identifiers are fixed inside the guard, so editing `wrangler.toml` can't move the target.

**One config file only.**
- Every Wrangler call the guard makes passes `--config <absolute path of worker/wrangler.toml>`. That path is worked out from the guard's own location, not the current folder. With an explicit `--config`, Wrangler doesn't search for a config file and doesn't follow redirects.
- The guard also refuses to run, in every mode, while any of these exists:
  - a `wrangler.json`, a `wrangler.jsonc` or a `.wrangler/deploy/config.json` in `worker/` or any parent folder;
  - a `.env` or `.env.local` in `worker/`.

  Without `--config`, Wrangler would prefer such a file over `worker/wrangler.toml` (reproduced with a root `wrangler.json` naming production's Worker, database and bucket).

**Schedules.**
- `[env.staging.triggers]` must hold exactly `*/30 * * * *` and `15 * * * *`.
- `BACKUP_CRON` must match the backup schedule, and `MORNING_CRON` must differ from it.
- The scheduled handler returns after starting backups. The hourly schedule runs audit sealing. Staging strips outside service credentials and permits outbound requests only to Google's public signing keys.

| Mode | What it checks |
|---|---|
| `config` (no credentials) | `[env.staging]` must name Worker `tablix-staging` with `workers_dev` only and no routes, D1 `saydaliti-staging`, R2 `saydaliti-files-staging`, the staging `SITE_URL` and the approved staging Google Client ID. The guard refuses production identifiers, preview IDs and unreviewed bindings. |
| `remote` (read-only, before any write) | • The token is active (its expiry is printed; a warning if it has none).<br>• The token sees **exactly one** account, and it is `CLOUDFLARE_STAGING_ACCOUNT_ID`. D1 UUIDs are globally unique, so finding the staging UUID there pins the account.<br>• The account in `CLOUDFLARE_STAGING_ACCOUNT_ID` holds D1 `0ba7c0dd-…` named `saydaliti-staging` and the bucket `saydaliti-files-staging`.<br>• Wrangler resolves the `DB` binding to that same UUID.<br>• It then writes a marker for this commit (no secrets in it). |
| `run -- <args>` (every Wrangler call) | Rechecks `wrangler.toml` and adds `--env staging`. The allowlist permits only the reviewed operations in `worker/scripts/staging-guard.mjs`. The exact write forms are `deploy`, `d1 migrations apply DB --remote`, and `secret put` for `BACKUP_KEY`, `PIN_PEPPER` or `AUDIT_SEAL_KEY`. Writes require the `remote` check on the same commit. |
| `schedules` | Reads the staging Worker's cron schedules and requires both `*/30 * * * *` and `15 * * * *`. |

The guard never reads the production token, and it never sends a request about a production resource.

**Tests.** `test/staging-guard.test.js` (refusal cases) and `test/staging-isolation.test.js` run in `npm test` and in the staging workflow's `preflight` job. They fail if:
- the workflow names a secret outside its staging allowlist, or falls back to another secret;
- it can be triggered by anything other than a manual run or the request file;
- the `deploy` job lacks `needs: preflight`, `environment: staging` or the owner/branch condition;
- any wrangler or Cloudflare API call bypasses the guard;
- untrusted input is pasted into a shell line.

**Data.** The test suites and the backup check create **synthetic** accounts and pharmacies only. The backup check accepts only `https://tablix-staging.<sub>.workers.dev`.

**What the guard cannot do.** A Cloudflare API token with Workers Scripts / D1 / R2 **Edit** applies to the whole account; Cloudflare doesn't scope those permissions to single resources. The staging token could therefore technically change production if it were used outside this workflow. The guard prevents that inside the workflow. Outside it, the protection is keeping the token only in the `staging` GitHub environment, giving it an expiry, and (strongest) a separate Cloudflare account for staging.

## 3. Owner setup (one time; done by the owner, by hand)

1. **Cloudflare API token** (done, per the owner): Custom token.
   - Permissions: Account · Workers Scripts · Edit; Account · D1 · Edit; Account · Workers R2 Storage · Edit; Account · Account Settings · Read; User · User Details · Read.
   - Account resources: **only** this account. Expiry: recommended (e.g. 30–90 days).
   - Optional: Client IP filtering is not practical with GitHub-hosted runners.
2. **GitHub environment `staging`:** Settings → Environments → New environment `staging`.
   - **Required reviewers:** yourself. Each run then waits for your click.
   - **Deployment branches:** selected branches, `main`.
   - **Environment secrets:** store `CLOUDFLARE_STAGING_API_TOKEN`, `STAGING_BACKUP_KEY` and `STAGING_AUDIT_SEAL_KEY` here. Keep these in the protected environment so jobs receive them only after the environment admits the job.
   - **Environment variable:** `CLOUDFLARE_STAGING_ACCOUNT_ID`, the 32-character account id (Cloudflare dashboard → any page → Account ID). It isn't secret; the guard uses it to prove the token reaches the staging database in that account.
3. **The staging backup key, made on your own computer:**
   - `openssl rand -base64 48` (macOS/Linux), or in PowerShell 7: `[Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(48))`. That gives 64 characters and 384 random bits. The Worker needs at least 32 characters; it uses the text as HKDF input.
   - Don't use `Get-Random`: it isn't a cryptographic generator. An earlier version of this page suggested it; a key made that way should be replaced.
   - Store it in the GitHub `staging` secret `STAGING_BACKUP_KEY`. Generate a separate value of at least 32 characters for `STAGING_AUDIT_SEAL_KEY`. The workflow passes them to the Worker through standard input as `BACKUP_KEY` and `AUDIT_SEAL_KEY`.
   - **Keep an offline copy:** your password manager, plus a printed or written copy in a sealed envelope stored separately from the computer. Without it, staging backups can't be opened (by design).

**Key rotation:** make a new key, put the new one in `STAGING_BACKUP_KEY` and the old one in a Worker secret `BACKUP_KEYS_OLD` (comma-separated). Old backups stay readable (tested). Keep the old key's offline copy until its backups have expired (14 per pharmacy).

## 4. Running it (only after the owner's approval)

**Deploy:** only from a manual run, Actions → Cloudflare staging validation → Run workflow (branch `main`, type `STAGING`).

**Preflight only:** changing `.github/staging-run` on `main` runs the credential-free `preflight` job; `deploy` is skipped.

**Job `preflight`** (no secrets): isolation and guard tests, then `staging-guard config`.

**Job `deploy`** (runs after `preflight`, waits for the `staging` environment reviewer; owner only; branch `main` only).

**Secrets.** No secret is set for the whole job. `CLOUDFLARE_STAGING_API_TOKEN` is given only to the steps that run the guard: the settings check, the remote proof, migrations, deploy, Worker secrets, the D1 checks and the schedules check. It is never given to `npm ci`, the build, Playwright, the test suites or the backup-check script. `test/staging-isolation.test.js` enforces this.

**Backup check: three steps, so the script never holds the token.**
1. `staging-backup-check.mjs prepare` (no secrets): makes a synthetic pharmacy and a backup on the staging Worker, then writes the two ids to `worker/.staging-backup/request.json`.
2. `staging-guard.mjs fetch-backup` (the token, nothing else in the step):
   - reads that request, which must be exactly two UUIDs in a plain file inside a plain folder;
   - looks up the backup's R2 key with one `SELECT` on the staging D1;
   - accepts the key only in the exact form the Worker makes for that pharmacy and backup;
   - downloads it with the only R2 read the guard allows: that key, from the remote staging bucket, into the fixed file `worker/.staging-backup/backup.sdbk`;
   - checks the header and size, and records the SHA-256.
3. `staging-backup-check.mjs verify` (only `STAGING_BACKUP_KEY`):
   - reads only that fixed file; it must be a plain file whose SHA-256 matches what the guard recorded;
   - checks it can't be opened with the wrong key, as the wrong pharmacy or with a changed byte;
   - restores it into an empty **local** database and verifies the result.

   The script refuses to run at all if a Cloudflare token is in its environment.

Steps:
1. Settings present (names only).
2. `staging-guard remote` (read-only proof).
3. Migrations.
4. Deploy.
5. Staging Worker secrets.
6. Health check.
7. Real-D1 checks: trigger and tables.
8. Cron schedules.
9. All API, stock, backup and browser suites against the staging Worker.
10. The backup check on Cloudflare: make a backup (no secrets) → guarded download from R2 → open it → refuse wrong key, wrong pharmacy and a changed byte → restore into a separate, empty **local** database → verify (no Cloudflare access).

Reports are uploaded as the `staging-reports` artifact.

## 5. Verification

Use the staging run's `staging-reports` artifact for the deployed commit's migration, API, browser and backup results. The [13 November staging run](https://github.com/bodamansour/tablix-pharma/actions/runs/43610986926) is a previous passing example.

## 6. Cleaning up (when staging is no longer needed; needs your approval)

The staging cleanup inventory includes Worker `tablix-staging`, D1 databases `saydaliti-staging` and `saydaliti-staging-sqlcheck`, R2 bucket `saydaliti-files-staging`, the GitHub staging secrets and the staging Cloudflare token.
