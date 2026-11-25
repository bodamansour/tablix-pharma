// Exact origins only: no credentials, path, arbitrary subdomain, or redirect target.
export function safeBase(value) {
  const base = String(value || '').replace(/\/$/, '');
  if (base === 'https://tablix-staging.tablixpharma.workers.dev') return base;
  const local = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/.exec(base);
  if (local && (!local[2] || (+local[2] >= 1 && +local[2] <= 65535))) return base;
  throw new Error('Load test refused: BASE_URL must be a loopback HTTP origin or the exact HTTPS Tablix staging origin. Production is forbidden.');
}
