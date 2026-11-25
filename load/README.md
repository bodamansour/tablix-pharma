# Local load tests

Requires an already installed k6. Do not install global tools for this review.
Start the local Worker and prepare a synthetic account, pharmacy and catalog first.
Set `BASE_URL=http://127.0.0.1:8787`, `TEST_EMAIL`, `TEST_PASSWORD`, and
`TEST_PHARMACY_ID` in the process environment using your local secret manager.
Never put credentials on the command line, in this file, in a transcript, or in Git.
The scripts do not create an account. Use a dedicated test account without MFA.

From the repository root, in PowerShell:

```powershell
$env:BASE_URL = 'http://127.0.0.1:8787'
# TEST_EMAIL, TEST_PASSWORD and TEST_PHARMACY_ID must already be in the environment.
k6 run load/smoke.js
k6 run load/load.js
k6 run load/spike.js
```

Smoke: 2 users for 1 minute. Average: 5 users for 5 minutes.
Spike: ramp from 5 to 25 users (5x) in 10 seconds, hold 1 minute, then stop.
Sign-in happens once in setup, then every iteration reads public config, catalog
data, and the public app page. Teardown signs out the shared test session.
These are HTTP journeys, not JavaScript/browser rendering measurements.

Pass: `http_req_duration p(95)<800` milliseconds, `http_req_failed rate<0.01`,
and over 99% of checks pass. A failed threshold makes k6 exit nonzero.
Inspect request counts, p95, error rate and checks, not only average duration.
Never enable HTTP debug logging: it can reveal credentials or session tokens.

Safety: the exact production host and all unrecognized hosts are refused before
the first request. Only loopback HTTP origins and the exact HTTPS staging origin
are recognized; redirects are disabled on every request. Staging is a supported
future target, **not authorized for this review**. Run only locally. No production
or staging load tests have been requested or performed.
