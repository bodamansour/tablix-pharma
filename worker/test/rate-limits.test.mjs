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

test('different accounts cannot bypass the pharmacy PIN limit', { skip: !BASE }, async () => {
  const account = async () => {
    let token;
    const call = async (name, args) => {
      const r = await fetch(BASE + name, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Saydaliti': '1', 'X-Want-Token': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(args) });
      return { status: r.status, ...await r.json() };
    };
    const r = await call('/api/auth/signup', { email: `pin-${crypto.randomUUID()}@test.local`, password: crypto.randomUUID() });
    assert.equal(r.error, null); token = r.data.access_token;
    return (name, args) => call('/api/rpc/' + name, args);
  };
  const owner = await account(), device = await account();
  const p = (await owner('create_pharmacy', { p_name: 'PIN limit fixture' })).data;
  await owner('add_employee', { p_pharmacy: p, p_name: 'Cashier', p_pin: '4821' });
  const invite = (await owner('create_invite', { p_pharmacy: p, p_role: 'device' })).data;
  assert.equal((await device('join_pharmacy', { p_code: invite })).data, p);
  for (let i = 0; i < 30; i++) assert.equal((await (i % 2 ? device : owner)('cashier_pin', { p_pharmacy: p, p_pin: '0000' })).status, 200);
  assert.equal((await device('cashier_pin', { p_pharmacy: p, p_pin: '0000' })).status, 429);
  assert.equal((await owner('cashier_pin', { p_pharmacy: p, p_pin: '4821' })).status, 429);
});
