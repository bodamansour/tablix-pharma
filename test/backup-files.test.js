// Server backups keep the uploaded stock snapshots as separate encrypted files next to the backup, one at a
// time, so a pharmacy with large snapshots fits the Worker's memory (production backups failed with
// exceededMemory with four 63,000-item snapshots). A restore reads them back and checks them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrated } from './helpers/d1-fake.js';
import { runBackup, decryptBackup, loadBlobFiles, restoreInto, verifyRestore, RETAIN } from '../worker/src/backup.js';

const KEY = 'test-backup-key-0123456789abcdef-xyz';
const P = 'p-files', B = 'b-1';
function bucket() {
  const m = new Map();
  const bytes = (v) => (typeof v === 'string' ? new TextEncoder().encode(v) : new Uint8Array(v));
  return {
    map: m,
    async put(k, v) { m.set(k, bytes(v)); return {}; },
    async get(k) { const b = m.get(k); return b ? { text: async () => new TextDecoder().decode(b), arrayBuffer: async () => b.slice().buffer } : null; },
    async delete(keys) { for (const k of [].concat(keys)) m.delete(k); },
    async list({ prefix = '' } = {}) { return { objects: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }; },
  };
}
function setup(snaps = 2) {
  const DB = migrated(), FILES = bucket();
  DB.raw.exec(`INSERT INTO pharmacies (id, name, timezone, settings, created_at) VALUES ('${P}', 'صيدلية', 'Africa/Cairo', '{}', '2026-01-01');
    INSERT INTO branches (id, pharmacy_id, name, created_at) VALUES ('${B}', '${P}', 'الرئيسي', '2026-01-01');`);
  for (let i = 1; i <= snaps; i++) {
    DB.raw.prepare('INSERT INTO snapshots (id, pharmacy_id, branch_id, created_at, item_count) VALUES (?, ?, ?, ?, ?)').run(i, P, B, `2026-10-2${i}T00:00:00Z`, 3000);
    const items = Array.from({ length: 3000 }, (_, k) => ({ code: `C${i}-${k}`, name: `صنف ${k}`, qty: k % 7 }));
    FILES.map.set(`snapshots/${i}.json`, new TextEncoder().encode(JSON.stringify({ items })));
  }
  return { env: { DB, FILES, BACKUP_KEY: KEY }, DB, FILES };
}

test('the snapshots go into their own encrypted files; the backup lists them with checksums', async () => {
  const { env, FILES } = setup(2);
  const b = await runBackup(env, P, { source: 'daily' });
  const dump = JSON.parse(await decryptBackup(env, P, (await FILES.get(b.key)).arrayBuffer ? await (await FILES.get(b.key)).arrayBuffer() : null));
  assert.deepEqual(dump.blobs, {}, 'not inside the backup');
  assert.deepEqual(dump.blob_files.map((f) => [f.name, f.key]), [['snapshots/1.json', `${b.key}.f0`], ['snapshots/2.json', `${b.key}.f1`]]);
  const raw = new TextDecoder().decode(FILES.map.get(`${b.key}.f0`));
  assert.ok(raw.startsWith('SDBK2') && !raw.includes('صنف'), 'encrypted');
  await assert.rejects(decryptBackup(env, 'another-pharmacy', await (await FILES.get(`${b.key}.f0`)).arrayBuffer()));
});

test('a restore reads the files back, checks them, and the restored pharmacy matches', async () => {
  const src = setup(2);
  const b = await runBackup(src.env, P);
  const dump = JSON.parse(await decryptBackup(src.env, P, await (await src.FILES.get(b.key)).arrayBuffer()));
  const full = await loadBlobFiles(src.env, P, dump);
  assert.equal(Object.keys(full.blobs).length, 2);
  const dst = { DB: migrated(), FILES: bucket(), BACKUP_KEY: KEY };
  await restoreInto(dst, full);
  const v = await verifyRestore(dst, full);
  assert.deepEqual(v.problems, []);
  assert.equal(v.ok, true);
  // A changed or missing file is refused.
  const bent = src.FILES.map.get(`${b.key}.f1`); bent[bent.length - 3] ^= 1;
  await assert.rejects(loadBlobFiles(src.env, P, dump));
  src.FILES.map.delete(`${b.key}.f1`);
  await assert.rejects(loadBlobFiles(src.env, P, dump), /missing/);
});

test('keeping the newest backups deletes the old ones\' files too; a failed backup leaves none', async () => {
  const { env, FILES, DB } = setup(1);
  for (let i = 0; i < RETAIN + 2; i++) await runBackup(env, P);
  const files = [...FILES.map.keys()].filter((k) => k.startsWith(`backups/${P}/`));
  assert.equal(files.filter((k) => k.endsWith('.sdbk')).length, RETAIN);
  assert.equal(files.filter((k) => /\.sdbk\.f\d+$/.test(k)).length, RETAIN);
  const put = FILES.put;
  FILES.put = async (k, v) => { if (k.endsWith('.sdbk')) throw new Error('write failed'); return put(k, v); };
  await assert.rejects(runBackup(env, P));
  FILES.put = put;
  assert.equal([...FILES.map.keys()].filter((k) => /\.sdbk\.f\d+$/.test(k)).length, RETAIN, 'the failed backup\'s file was removed');
  assert.equal(DB.raw.prepare("SELECT count(*) AS n FROM backups WHERE status = 'failed'").get().n, 1);
});
