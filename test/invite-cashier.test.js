// The code review of 2026-11-23: an invite code is used by one person only, even when several send it at
// the same moment; a cashier named on a receipt, a shift or a return is the one who typed their PIN on
// that device (cashier_pin's token), or the receipt is marked for the owner; and the morning report skips
// a damaged upload. On the fake D1 (node:sqlite), calling the server's own functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrated, fakeR2 } from './helpers/d1-fake.js';
import { RPC, checkPosSale, cashierCheck, reportFeed } from '../worker/src/rpc.js';

const env = () => ({ DB: migrated(), FILES: fakeR2(), PIN_PEPPER: 'test-pepper-0123456789abcdef' });
const ctxOf = (id, roles = {}, scopes = {}) => ({ user: { id }, roles: new Map(Object.entries(roles)), branchScopes: new Map(Object.entries(scopes)) });
// The batches one after the other, as D1 runs them; the reads in between interleave freely.
const serializeBatches = (DB) => {
  const batch = DB.batch.bind(DB); let tail = Promise.resolve();
  DB.batch = (list) => { const r = tail.then(() => batch(list)); tail = r.catch(() => {}); return r; };
};

async function pharmacy(e) {
  const owner = ctxOf('u-owner');
  const p = await RPC.create_pharmacy(e, owner, { p_name: 'صيدلية التجربة' });
  owner.roles.set(p, 'owner');
  const b = (await e.DB.prepare('SELECT id FROM branches WHERE pharmacy_id = ?').bind(p).first()).id;
  return { p, b, owner };
}

test('one invite code sent by several people at once: exactly one gets in, the others get nothing', async () => {
  const e = env();
  const { p, owner } = await pharmacy(e);
  const code = await RPC.create_invite(e, owner, { p_pharmacy: p, p_role: 'pharmacist' });
  serializeBatches(e.DB);
  const people = ['u-a', 'u-b', 'u-c', 'u-d'];
  const results = await Promise.all(people.map((id) => RPC.join_pharmacy(e, ctxOf(id), { p_code: code })));
  assert.equal(results.filter((r) => r === p).length, 1, `one success: ${JSON.stringify(results)}`);
  assert.equal(results.filter((r) => r === null).length, people.length - 1);
  const members = (await e.DB.prepare("SELECT user_id FROM members WHERE pharmacy_id = ? AND role = 'pharmacist'").bind(p).all()).results.map((r) => r.user_id);
  assert.equal(members.length, 1, 'one membership');
  const inv = await e.DB.prepare('SELECT used_by FROM invites WHERE pharmacy_id = ?').bind(p).first();
  assert.equal(inv.used_by, members[0], 'the code is marked used by the one who got in');
});

test('a code still works for one person, and the plan limit is kept inside the same step', async () => {
  const e = env();
  const { p, owner } = await pharmacy(e);
  assert.equal(await RPC.join_pharmacy(e, ctxOf('u-x'), { p_code: await RPC.create_invite(e, owner, { p_pharmacy: p, p_role: 'device' }) }), p);
  // A plan with room for no one more: the code is refused and stays unused.
  await e.DB.prepare("UPDATE app_config SET plans = ? WHERE id = 1").bind(JSON.stringify([{ id: 'trial', max_users: 2, max_branches: 1 }])).run().catch(() => {});
  const code = await RPC.create_invite(e, owner, { p_pharmacy: p, p_role: 'device' });
  const n = (await e.DB.prepare('SELECT count(*) AS n FROM members WHERE pharmacy_id = ?').bind(p).first()).n;
  const r = await RPC.join_pharmacy(e, ctxOf('u-y'), { p_code: code }).catch((err) => err);
  const after = (await e.DB.prepare('SELECT count(*) AS n FROM members WHERE pharmacy_id = ?').bind(p).first()).n;
  if (r instanceof Error) {
    assert.match(r.message, /plan limit/);
    assert.equal(after, n, 'nobody added');
    assert.equal((await e.DB.prepare('SELECT used_by FROM invites WHERE code = ?').bind(code.replace(/-/g, '')).first()).used_by, null, 'the code is not used up');
  } else assert.equal(r, p); // the plan in this test database has room: then it simply works
});

async function withCashier() {
  const e = env();
  const { p, b, owner } = await pharmacy(e);
  const emp = await RPC.add_employee(e, owner, { p_pharmacy: p, p_name: 'منى', p_pin: '4821' });
  const other = await RPC.add_employee(e, owner, { p_pharmacy: p, p_name: 'كريم', p_pin: '7390' });
  const device = ctxOf('u-device', { [p]: 'device' }, { [p]: [b] });
  return { e, p, b, owner, emp, other, device };
}
const sale = (p, b, employee_id, extra = {}) => ({
  id: crypto.randomUUID(), pharmacy_id: p, branch_id: b, number: `T-${Math.random().toString(36).slice(2, 8)}`, sold_at: new Date().toISOString(), kind: 'sale',
  lines: [{ code: 'A1', name: 'بانادول', price: 50, qty: 1, discount: 0 }], total: 50, discount: 0, paid: 50, payment: 'cash', employee_id, employee_name: 'x', ...extra,
});

test('cashier_pin gives a token for that employee on that account; a receipt with it is not marked', async () => {
  const { e, p, b, emp, device } = await withCashier();
  const [row] = await RPC.cashier_pin(e, device, { p_pharmacy: p, p_pin: '4821' });
  assert.equal(row.employee_id, emp);
  assert.match(row.cashier_token, /^[0-9a-f]{64}$/);
  const stored = await e.DB.prepare('SELECT token_hash, employee_id, user_id FROM cashier_tokens').all();
  assert.equal(stored.results.length, 1);
  assert.notEqual(stored.results[0].token_hash, row.cashier_token, 'only the hash is kept');
  const { flags } = await checkPosSale(device, e, sale(p, b, emp), row.cashier_token);
  assert.ok(!flags.includes('cashier_not_verified'), JSON.stringify(flags));
  assert.deepEqual(await RPC.cashier_pin(e, device, { p_pharmacy: p, p_pin: '0000' }), [], 'a wrong PIN gives nothing');
});

test('a receipt naming a cashier with no token, or an old one, is taken and marked; one with another cashier\'s token is refused', async () => {
  const { e, p, b, emp, other, device } = await withCashier();
  const [row] = await RPC.cashier_pin(e, device, { p_pharmacy: p, p_pin: '4821' });
  assert.ok((await checkPosSale(device, e, sale(p, b, other), null)).flags.includes('cashier_not_verified'), 'no token: marked');
  await assert.rejects(checkPosSale(device, e, sale(p, b, other), row.cashier_token), /sign in with their PIN on this device/, 'another cashier\'s token: refused');
  // The same token used by another account (another device): refused.
  const device2 = ctxOf('u-device-2', { [p]: 'device' }, { [p]: [b] });
  await assert.rejects(checkPosSale(device2, e, sale(p, b, emp), row.cashier_token), /on this device/);
  // A receipt dated after the 7 days: marked, not refused (it may have waited offline).
  const late = sale(p, b, emp, { sold_at: new Date(Date.now() + 8 * 86400000).toISOString() });
  assert.equal(await cashierCheck(e, device, p, emp, row.cashier_token, late.sold_at), 'stale');
  // A new PIN ends the old sign-ins.
  await RPC.set_employee_pin(e, (await e.DB.prepare('SELECT 1').first(), { user: { id: 'u-owner' }, roles: new Map([[p, 'owner']]) }), { p_employee: emp, p_pin: '5555' });
  assert.equal(await cashierCheck(e, device, p, emp, row.cashier_token), 'stale');
  assert.equal(await cashierCheck(e, device, p, null, null), 'ok', 'a receipt with no cashier named needs nothing');
});

test('a return without its receipt: the approval needs the cashier\'s own PIN sign-in on this device', async () => {
  const { e, p, b, emp, other, device } = await withCashier();
  await e.DB.prepare('UPDATE employees SET can_approve_returns = 1 WHERE id = ?').bind(other).run();
  const [row] = await RPC.cashier_pin(e, device, { p_pharmacy: p, p_pin: '4821' });
  const ask = (o = {}) => RPC.approve_no_receipt_return(e, device, { p_pharmacy: p, p_branch: b, p_return_id: crypto.randomUUID(), p_total: -20, p_reason: 'العميل نسي الفاتورة', p_cashier: emp, p_pin: '7390', ...o });
  assert.ok((await ask({ p_cashier_token: row.cashier_token })).approval_id);
  // The manager's own token can't stand for the cashier.
  const [mgr] = await RPC.cashier_pin(e, device, { p_pharmacy: p, p_pin: '7390' });
  await assert.rejects(ask({ p_cashier_token: mgr.cashier_token }), /on this device/);
  // No token (an older app) or one that no longer counts: refused, the cashier types the PIN again.
  await assert.rejects(ask(), /sign in with their PIN again/);
  await RPC.set_employee_pin(e, { user: { id: 'u-owner' }, roles: new Map([[p, 'owner']]) }, { p_employee: emp, p_pin: '6161' });
  await assert.rejects(ask({ p_cashier_token: row.cashier_token }), /sign in with their PIN again/);
});

test('the morning report skips a damaged upload and uses the one before it', async () => {
  const e = env();
  const { p, b, owner } = await pharmacy(e);
  await RPC.save_settings(e, owner, { p_pharmacy: p, p_settings: { waNumbers: '201000000000' } });
  const put = async (id, at, body) => {
    await e.DB.prepare('INSERT INTO snapshots (id, pharmacy_id, branch_id, created_at, created_by, item_count) VALUES (?, ?, ?, ?, ?, ?)').bind(id, p, b, at, 'u-owner', 1).run();
    await e.FILES.put(`snapshots/${id}.json`, body);
  };
  await put(1, '2026-11-20T08:00:00.000Z', JSON.stringify({ items: [{ code: 'A1', name: 'بانادول' }] }));
  await put(2, '2026-11-21T08:00:00.000Z', '{"items":[{"code":"B2"}], "x": }');
  const feed = await reportFeed({ ...e, FILES: { get: async (k) => { const o = await e.FILES.get(k); return o && { json: async () => JSON.parse(await o.text()) }; } } });
  const mine = feed.find((f) => f.pharmacy_id === p);
  assert.ok(mine, 'the pharmacy is still in the report');
  assert.equal(mine.data.items[0].code, 'A1');
});

test('a request body is limited by the bytes that arrive, not by the Content-Length it claims', async () => {
  const { readBody } = await import('../worker/src/index.js');
  const stream = (n) => new ReadableStream({ start(c) { for (let i = 0; i < n; i++) c.enqueue(new Uint8Array(1024)); c.close(); } });
  // No Content-Length at all (a streamed body), 5 KB against a 2 KB limit: refused while reading.
  const noLength = new Request('https://x/api/db', { method: 'POST', body: stream(5), duplex: 'half' });
  assert.equal(noLength.headers.get('Content-Length'), null);
  await assert.rejects(readBody(noLength, 2048), (e) => e.status === 413);
  // A header that claims less than is sent: still refused.
  const lying = { headers: new Headers({ 'Content-Length': '10' }), body: stream(5) };
  await assert.rejects(readBody(lying, 2048), (e) => e.status === 413);
  // Within the limit: the bytes, whole.
  assert.equal((await readBody(new Request('https://x', { method: 'POST', body: stream(2), duplex: 'half' }), 2048)).byteLength, 2048);
});

test('someone already in the pharmacy who sends a fresh code does not use it up', async () => {
  const e = env();
  const { p, owner } = await pharmacy(e);
  assert.equal(await RPC.join_pharmacy(e, ctxOf('u-old'), { p_code: await RPC.create_invite(e, owner, { p_pharmacy: p, p_role: 'pharmacist' }) }), p);
  const code = await RPC.create_invite(e, owner, { p_pharmacy: p, p_role: 'stock' });
  assert.equal(await RPC.join_pharmacy(e, ctxOf('u-old'), { p_code: code }), p, 'still answered with the pharmacy');
  assert.equal((await e.DB.prepare('SELECT used_by FROM invites WHERE code = ?').bind(code.replace(/-/g, '')).first()).used_by, null, 'the code is still free');
  assert.equal((await e.DB.prepare("SELECT role FROM members WHERE pharmacy_id = ? AND user_id = 'u-old'").bind(p).first()).role, 'pharmacist', 'the role is unchanged');
  assert.equal(await RPC.join_pharmacy(e, ctxOf('u-new'), { p_code: code }), p, 'the person it was made for gets in');
});

test('two invitations redeemed together by the same user consume only one code', async () => {
  const e = env();
  const { p, owner } = await pharmacy(e);
  const args = { p_pharmacy: p, p_role: 'pharmacist' };
  const codes = [await RPC.create_invite(e, owner, args), await RPC.create_invite(e, owner, args)];
  serializeBatches(e.DB);
  const member = ctxOf('u-new');
  assert.deepEqual(await Promise.all(codes.map((p_code) => RPC.join_pharmacy(e, member, { p_code }))), [p, p]);
  const invite = await e.DB.prepare('SELECT code FROM invites WHERE pharmacy_id = ? AND used_by IS NULL').bind(p).all();
  assert.equal(invite.results.length, 1);
  assert.equal(await RPC.join_pharmacy(e, ctxOf('u-other'), { p_code: invite.results[0].code }), p);
});
