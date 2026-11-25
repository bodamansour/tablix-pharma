// Synthetic data only; fixed loopback URL, no redirects, credentials kept in memory.
// Run with a local Worker already listening: node load/measure-local.mjs
import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:8787';
let token;
async function call(path, body) {
  const response = await fetch(base + path, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', 'X-Saydaliti': '1', 'X-Want-Token': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const text = await response.text(), result = JSON.parse(text);
  assert.ok(response.ok && !result.error, `Local fixture request failed (${response.status})`);
  return { data: result.data, bytes: Buffer.byteLength(text) };
}
const signup = await call('/api/auth/signup', { email: `measure-${crypto.randomUUID()}@test.local`, password: crypto.randomUUID() });
token = signup.data.access_token;
try {
  const p = (await call('/api/rpc/create_pharmacy', { p_name: 'Local read benchmark' })).data;
  const select = (table, cols, extra = {}) => ({ op: 'select', table, cols, filters: [['pharmacy_id', 'eq', p]], ...extra });
  const b = (await call('/api/db', select('branches', 'id'))).data[0].id;
  const now = new Date().toISOString();
  const moves = Array.from({ length: 1000 }, (_, i) => ({ id: crypto.randomUUID(), pharmacy_id: p, branch_id: b, code: `M${i}`, qty: 100, kind: 'count', happened_at: now }));
  const sales = Array.from({ length: 1000 }, (_, i) => ({ id: crypto.randomUUID(), pharmacy_id: p, branch_id: b, number: `BENCH-${i}`, sold_at: now, kind: 'sale', lines: [{ code: `M${i}`, qty: 1, price: 10 }], total: 10, paid: 10 }));
  for (const [table, rows] of [['stock_moves', moves], ['pos_sales', sales]]) {
    for (let i = 0; i < rows.length; i += 100) await call('/api/db', { op: 'insert', table, rows: rows.slice(i, i + 100) });
  }
  const snapshot = { items: Array.from({ length: 5000 }, (_, i) => ({ code: `M${i}`, name: `Synthetic item ${i}`, stock: 100, price: 10 })) };
  for (let i = 0; i < 2; i++) await call(`/api/snapshot?pharmacy=${p}&branch=${b}&items=5000&at=${encodeURIComponent(new Date(Date.now() + i).toISOString())}`, snapshot);
  const reads = [
    ['cashier sales page', select('pos_sales', 'id, branch_id, number, sold_at, kind, lines, total, discount, paid, payment, customer_id, credit, claim_no, return_of, note, employee_id, employee_name, shift_id, delivery_fee, delivery_to', { order: { col: 'sold_at', asc: false }, limit: 1000 })],
    ['dashboard stock movements page', select('stock_moves', 'id, branch_id, code, qty, kind, expiry, cost, ref, note, happened_at, created_at, person', { order: { col: 'happened_at', asc: false }, limit: 1000 })],
    ['dashboard latest two R2 snapshots', select('snapshots', 'created_at, data', { filters: [['pharmacy_id', 'eq', p], ['branch_id', 'eq', b]], order: { col: 'created_at', asc: false }, limit: 2 })],
  ];
  const output = [];
  for (const [name, query] of reads) {
    const start = performance.now(), first = await call('/api/db', query), firstMs = performance.now() - start;
    assert.equal(first.data.length, name.includes('snapshots') ? 2 : 1000);
    const times = [];
    for (let i = 0; i < 20; i++) { const t = performance.now(); await call('/api/db', query); times.push(performance.now() - t); }
    times.sort((a, b) => a - b);
    output.push({ name, rows: first.data.length, bytes: first.bytes, firstMs: +firstMs.toFixed(2), medianMs: +((times[9] + times[10]) / 2).toFixed(2), p95Ms: +times[18].toFixed(2), maxMs: +times[19].toFixed(2), samples: 20 });
  }
  console.log(JSON.stringify({ at: new Date().toISOString(), runtime: 'local wrangler/workerd', note: 'HTTP wall time including response download and JSON parse; sequential reads, not Cloudflare CPU or production capacity', fixture: { sales: 1000, stockMoves: 1000, snapshots: 2, itemsPerSnapshot: 5000 }, reads: output }, null, 2));
} finally {
  await call('/api/auth/signout', {});
}
