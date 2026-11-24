import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/src/index.js';
import { runBatch, select } from '../worker/src/db.js';
import { migrated } from './helpers/d1-fake.js';

const request = (path, value, headers = {}) => new Request(`https://example.test${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Saydaliti': '1', ...headers }, body: JSON.stringify(value),
});

test('JSON API rejects a non-object body consistently', async () => {
  for (const path of ['/api/auth/signin', '/api/db', '/api/rpc/create_pharmacy']) {
    for (const value of [null, [], 1]) {
      const response = await worker.fetch(request(path, value), {});
      assert.equal(response.status, 400, path);
      assert.equal((await response.json()).error.code, 'PGRST102');
    }
  }
});

test('configured AI and payment routes preserve the body size rejection', async () => {
  const env = { ANTHROPIC_API_KEY: true, PAYMOB_SECRET_KEY: true, PAYMOB_PUBLIC_KEY: true, PAYMOB_INTEGRATION_IDS: true, PAYMOB_HMAC: true };
  for (const [path, cap] of [['/api/ai', 2 << 20], ['/api/ai/invoice', 8 << 20], ['/api/pay/webhook', 64 << 10]]) {
    const response = await worker.fetch(request(path, {}, { 'Content-Length': String(cap + 1) }), env);
    assert.equal(response.status, 413, path);
  }
  assert.equal((await worker.fetch(request('/api/pay/webhook', {}), env)).status, 200, 'unrelated webhook events are ignored');
});

test('data queries reject malformed filters and pagination and cap a valid page', async () => {
  const DB = migrated();
  const ctx = { user: { id: 'owner' }, roles: new Map([['p', 'owner']]) };
  const query = (q) => select(ctx, { DB }, { table: 'customers', cols: 'id', ...q });
  for (const q of [{ filters: null }, { filters: [null] }, { filters: [['id', 'eq']] }, { range: [2, 1] }, { limit: -1 }, { cols: ' , ' }]) {
    await assert.rejects(query(q), (err) => err.status === 400);
  }
  DB.exec(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 1001)
    INSERT INTO customers(id, pharmacy_id, name, kind, coverage_pct, active, created_at)
    SELECT CAST(n AS TEXT), 'p', 'test', 'person', 0, 1, '2026-01-01' FROM numbers`);
  assert.equal((await query({ limit: 2000 })).rows.length, 1000);
  assert.equal((await query({ range: [1000, 1001], order: { col: 'id' } })).rows.length, 1);
});

test('constraint errors give clients a stable message without database details', async () => {
  const env = { DB: { batch: async () => { throw new Error('NOT NULL constraint failed: private_table.private_column'); } } };
  await assert.rejects(runBatch(env, []), (err) => err.message === 'required value missing' && err.code === '23502');
});
