// Loaded with --import by the staging runs (worker/test/*.mjs, e2e/*.e2e.mjs, scripts/staging-backup-check.mjs).
// Node's fetch keeps connections open and sends the next request on one it already has. After a long request
// (a backup takes 7-10 s), Cloudflare sometimes closes that connection just as the next request goes out: the
// request never reaches the Worker (it is not in the Worker's logs), and the test fails with a bare
// "fetch failed" (staging, 2026-11-19, twice). Here the cause is printed, and a request that failed that way,
// on a connection closed before any answer, is sent once more. Any other network error, or a second
// failure, still fails the test.
const realFetch = globalThis.fetch;
const CLOSED = /UND_ERR_SOCKET|UND_ERR_CLOSED|ECONNRESET|EPIPE/;

globalThis.fetch = async (input, init) => {
  try {
    return await realFetch(input, init);
  } catch (e) {
    const c = e?.cause, code = String(c?.code || ''), why = String(c?.message || e?.message || '');
    const where = `${init?.method || 'GET'} ${typeof input === 'string' ? input : input?.url}`;
    console.error(`[net] ${where} failed: ${code} ${why}`);
    const closed = CLOSED.test(code) || /other side closed|socket hang up/i.test(why);
    const replayable = init?.body == null || typeof init.body === 'string';
    if (!(e instanceof TypeError) || !closed || !replayable) throw e;
    console.error(`[net] ${where}: the connection was closed before an answer; sending it once more`);
    return realFetch(input, init);
  }
};
