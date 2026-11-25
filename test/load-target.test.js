import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeBase } from '../load/target.js';
test('load tests accept exact test origins and reject production, credentials and host lookalikes', () => {
  for (const base of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787', 'https://tablix-staging.tablixpharma.workers.dev']) assert.equal(safeBase(base), base);
  for (const base of ['', 'https://tablix.tablixpharma.workers.dev', 'http://tablix.tablixpharma.workers.dev', 'http://localhost.evil.test', 'http://localhost@evil.test', 'http://localhost:0', 'http://localhost:99999', 'http://localhost/path', 'http://localhost?redirect=prod', 'https://tablix-staging.tablixpharma.workers.dev.evil.test']) assert.throws(() => safeBase(base), /refused/);
});
