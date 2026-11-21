// The staging runs' fetch wrapper (worker/test/net.mjs): a request on a connection closed before any
// answer is sent once more; any other failure is not hidden.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const closed = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });

test('a request lost on a closed connection is sent once more; other failures still fail', async () => {
  const calls = [];
  let plan = [];
  globalThis.fetch = async (u, init) => { calls.push(u); const next = plan.shift(); if (next instanceof Error) throw next; return next; };
  await import('../worker/test/net.mjs');
  const err = console.error; console.error = () => {};
  try {
    plan = [closed(), new Response('ok')];
    assert.equal(await (await fetch('https://x/api/a', { method: 'POST', body: '{}' })).text(), 'ok');
    assert.equal(calls.length, 2);
    plan = [closed(), closed()];
    await assert.rejects(fetch('https://x/api/b', { method: 'POST', body: '{}' }), /fetch failed/, 'twice is a real failure');
    plan = [Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) })];
    await assert.rejects(fetch('https://x/api/c'), /fetch failed/, 'not a closed connection');
    plan = [closed()];
    await assert.rejects(fetch('https://x/api/d', { method: 'POST', body: new Uint8Array([1]) }), /fetch failed/, 'a body that cannot be sent twice');
  } finally { console.error = err; }
});
