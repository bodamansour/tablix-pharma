import { ApiError, nowIso } from './db.js';

// Sliding-window counters on the existing (k, at) index. Reserve in one statement:
// concurrent requests cannot both consume the last place in the window.
export async function limitRequest(env, user, prefix, max, minutes) {
  if (!user) throw new ApiError('not signed in', '42501', 401);
  const key = `${prefix}:${user.id}`, at = nowIso();
  const since = new Date(Date.now() - minutes * 60000).toISOString();
  const result = await env.DB.prepare(`INSERT INTO auth_attempts (k, at)
    SELECT ?, ? WHERE (SELECT count(*) FROM auth_attempts WHERE k = ? AND at > ?) < ?`)
    .bind(key, at, key, since, max).run();
  if (result.meta.changes !== 1) throw new ApiError('Too many requests. Please try again later.', 'over_request_rate_limit', 429);
  await env.DB.prepare('DELETE FROM auth_attempts WHERE k = ? AND at <= ?').bind(key, since).run();
}
