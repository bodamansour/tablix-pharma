import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.WORKER_URL;
test('payment starts and database writes are capped per account in the real Worker', { skip: !BASE }, async () => {
  let token;
  const call = async (path, body) => {
    const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Saydaliti': '1', 'X-Want-Token': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const signup = await call('/api/auth/signup', { email: `limits-${crypto.randomUUID()}@test.local`, password: crypto.randomUUID() });
  assert.equal(signup.body.error, null);
  token = signup.body.data.access_token;
  for (let i = 0; i < 10; i++) assert.notEqual((await call('/api/pay/start', {})).status, 429);
  assert.equal((await call('/api/pay/start', {})).status, 429);
  const p = (await call('/api/rpc/create_pharmacy', { p_name: 'Local rate test' })).body.data;
  const write = { op: 'upsert', table: 'catalog_items', ignoreDuplicates: true, rows: { id: crypto.randomUUID(), pharmacy_id: p, code: 'rate', name: 'Local fixture', price: 1 } };
  for (let i = 0; i < 600; i++) assert.equal((await call('/api/db', write)).status, 201, `write ${i + 1}`);
  assert.equal((await call('/api/db', write)).status, 429);
  assert.equal((await call('/api/db', { op: 'select', table: 'catalog_items', cols: 'id', filters: [['pharmacy_id', 'eq', p]] })).status, 200);
});
