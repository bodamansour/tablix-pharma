import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrated, fakeR2 } from './helpers/d1-fake.js';
import { limitRequest } from '../worker/src/rate-limit.js';
import worker from '../worker/src/index.js';
import { sha256 } from '../worker/src/auth.js';

test('request counters are atomic, independent per account and expire at the window boundary', async () => {
  const env = { DB: migrated() }, user = { id: 'rate-user' };
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => limitRequest(env, user, 'pay', 10, 15)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 10);
  for (const r of results.filter(r => r.status === 'rejected')) assert.equal(r.reason.status, 429);
  await limitRequest(env, { id: 'other' }, 'pay', 10, 15);
  await limitRequest(env, user, 'db', 600, 10);
  await env.DB.prepare('UPDATE auth_attempts SET at = ? WHERE k = ?').bind(new Date(Date.now() - 900001).toISOString(), 'pay:rate-user').run();
  await limitRequest(env, user, 'pay', 10, 15);
  await assert.rejects(limitRequest(env, null, 'pay', 10, 15), e => e.status === 401);
});

test('HTTP routes enforce pay and all DB write limits while reads remain available', async () => {
  const env = { DB: migrated(), FILES: fakeR2() }, token = 'a'.repeat(64), at = new Date().toISOString();
  await env.DB.prepare('INSERT INTO users (id, email, pw_hash, created_at) VALUES (?, ?, ?, ?)').bind('u-rate', 'rate@test.invalid', 'unused', at).run();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(await sha256(token), 'u-rate', at, '2099-01-01T00:00:00.000Z').run();
  const call = (path, body) => worker.fetch(new Request(`http://localhost${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env, {});
  for (let i = 0; i < 10; i++) assert.notEqual((await call('/api/pay/start', {})).status, 429);
  assert.equal((await call('/api/pay/start', {})).status, 429);
  // Invalid/forbidden writes count too; otherwise they would provide an unlimited DB-work bypass.
  for (let i = 0; i < 600; i++) assert.notEqual((await call('/api/db', { op: 'insert', table: 'users', rows: [] })).status, 429);
  for (const op of ['insert', 'upsert', 'update', 'delete']) assert.equal((await call('/api/db', { op, table: 'users', rows: [] })).status, 429);
  assert.equal((await call('/api/db', { op: 'select', table: 'app_config', cols: 'price_month' })).status, 200);
});
