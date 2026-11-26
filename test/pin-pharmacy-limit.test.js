import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrated, fakeR2 } from './helpers/d1-fake.js';
import { RPC } from '../worker/src/rpc.js';

async function fixture() {
  const env = { DB: migrated(), FILES: fakeR2(), PIN_PEPPER: crypto.randomUUID() };
  const owner = { user: { id: 'owner' }, roles: new Map() };
  const p = await RPC.create_pharmacy(env, owner, { p_name: 'Local PIN test' });
  owner.roles.set(p, 'owner');
  await RPC.add_employee(env, owner, { p_pharmacy: p, p_name: 'Cashier', p_pin: '4821' });
  const actor = id => ({ user: { id }, roles: new Map([[p, 'device']]) });
  const pin = (id, value) => RPC.cashier_pin(env, actor(id), { p_pharmacy: p, p_pin: value });
  return { env, p, pin };
}

test('thirty failed PINs across accounts block the pharmacy, including correct PINs, until expiry', async () => {
  const { env, p, pin } = await fixture();
  for (let i = 0; i < 35; i++) assert.equal((await pin('good', '4821')).length, 1);
  assert.equal((await env.DB.prepare('SELECT count(*) AS n FROM auth_attempts WHERE k = ?').bind(`pin:${p}`).first()).n, 0);
  for (let i = 0; i < 30; i++) assert.deepEqual(await pin(`user-${i}`, '0000'), []);
  await assert.rejects(pin('user-31', '0000'), e => e.status === 429);
  await assert.rejects(pin('good', '4821'), e => e.status === 429);
  await env.DB.prepare('UPDATE auth_attempts SET at = ? WHERE k = ?').bind(new Date(Date.now() - 900001).toISOString(), `pin:${p}`).run();
  assert.equal((await pin('good', '4821')).length, 1);
});

test('the account limit remains twenty and concurrent failures cannot exceed the pharmacy cap', async () => {
  const { env, p, pin } = await fixture();
  for (let i = 0; i < 20; i++) await pin('one-account', '0000');
  await assert.rejects(pin('one-account', '4821'), e => e.status === 429);
  const batch = env.DB.batch.bind(env.DB); let tail = Promise.resolve();
  env.DB.batch = list => { const result = tail.then(() => batch(list)); tail = result.catch(() => {}); return result; };
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => pin(`other-${i}`, '0000')));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 10);
  for (const r of results.filter(r => r.status === 'rejected')) assert.equal(r.reason.status, 429);
  assert.equal((await env.DB.prepare('SELECT count(*) AS n FROM auth_attempts WHERE k = ?').bind(`pin:${p}`).first()).n, 30);
  assert.equal((await env.DB.prepare('SELECT count(*) AS n FROM pin_attempts').first()).n, 30);
  const other = await fixture();
  assert.equal((await other.pin('good', '4821')).length, 1);
});
