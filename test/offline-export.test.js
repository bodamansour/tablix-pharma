import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refusedForExport } from '../src/offline.js';

test('the refused-changes export preserves the receipt and leaves the PIN proof only in the retry queue', () => {
  const proof = crypto.randomUUID();
  const entries = [{ type: 'insert', payload: { table: 'pos_sales', row: { number: 'Test-1', cashier_token: proof } }, error: 'stock changed' }];
  const exported = refusedForExport(entries);
  assert.equal(JSON.stringify(exported).includes(proof), false);
  assert.deepEqual(exported, [{ type: 'insert', payload: { table: 'pos_sales', row: { number: 'Test-1' } }, error: 'stock changed' }]);
  assert.ok(entries[0].payload.row.cashier_token === proof);
});
