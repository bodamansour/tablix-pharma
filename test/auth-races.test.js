import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrated } from './helpers/d1-fake.js';
import { signUp, signIn, changePassword } from '../worker/src/auth.js';
import worker from '../worker/src/index.js';

async function fixture() {
  const env = { DB: migrated(), PBKDF2_ITER: '10000', SIGNUP_PER_HOUR: '1000' };
  const session = await signUp(env, { email: 'owner@test.local', password: 'original-password' }, 'local');
  return { env, session, user: session.user };
}
function beforeRun(DB, match, action) {
  const prepare = DB.prepare;
  let fired = false;
  DB.prepare = (sql) => {
    const wrap = (stmt) => ({ ...stmt, bind: (...args) => wrap(stmt.bind(...args)), run: async () => {
      if (!fired && match(sql)) { fired = true; action(); }
      return stmt.run();
    } });
    return wrap(prepare(sql));
  };
  return () => assert.ok(fired, 'the race injection reached its intended statement');
}

for (const rehash of [false, true]) test(`reset wins over stale password login, rehash=${rehash}`, async () => {
  const { env, user } = await fixture();
  if (rehash) env.PBKDF2_ITER = '11000';
  const reached = beforeRun(env.DB, sql => sql.startsWith(rehash ? 'UPDATE users SET pw_hash' : 'INSERT INTO sessions'), () => {
    env.DB.raw.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run('reset-won', user.id);
    env.DB.raw.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  });
  await assert.rejects(signIn(env, { email: user.email, password: 'original-password' }, 'local'), e => e.code === 'invalid_credentials');
  reached();
  assert.equal(env.DB.raw.prepare('SELECT pw_hash FROM users WHERE id = ?').get(user.id).pw_hash, 'reset-won');
  assert.equal(env.DB.raw.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
});

test('password change cannot overwrite a reset or revoke its sessions', async () => {
  const { env, user } = await fixture();
  const batch = env.DB.batch;
  env.DB.batch = async list => {
    if (list[0].sql.startsWith('UPDATE users SET pw_hash')) {
      env.DB.raw.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run('reset-won', user.id);
    }
    return batch(list);
  };
  await assert.rejects(changePassword(env, user, { current_password: 'original-password', password: 'new-password' }), e => e.code === 'invalid_credentials');
  assert.equal(env.DB.raw.prepare('SELECT pw_hash FROM users WHERE id = ?').get(user.id).pw_hash, 'reset-won');
  assert.equal(env.DB.raw.prepare('SELECT count(*) AS n FROM sessions').get().n, 1);
});

test('session insertion failure rolls back the password change and revocation', async () => {
  const { env, user } = await fixture();
  const old = env.DB.raw.prepare('SELECT pw_hash FROM users WHERE id = ?').get(user.id).pw_hash;
  env.DB.exec("CREATE TRIGGER fail_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  await assert.rejects(changePassword(env, user, { current_password: 'original-password', password: 'new-password' }), /injected failure/);
  assert.equal(env.DB.raw.prepare('SELECT pw_hash FROM users WHERE id = ?').get(user.id).pw_hash, old);
  assert.equal(env.DB.raw.prepare('SELECT count(*) AS n FROM sessions').get().n, 1);
});

test('signup losing an email insertion race returns the normal conflict', async () => {
  const { env } = await fixture();
  const reached = beforeRun(env.DB, sql => sql.startsWith('INSERT OR IGNORE INTO users'), () => {
    env.DB.raw.prepare('INSERT INTO users (id, email, pw_hash, created_at) VALUES (?, ?, ?, ?)').run('winner', 'raced@test.local', 'winner-hash', new Date().toISOString());
  });
  await assert.rejects(signUp(env, { email: 'raced@test.local', password: 'original-password' }, 'local'), e => e.code === 'user_already_exists');
  reached();
  assert.equal(env.DB.raw.prepare('SELECT count(*) AS n FROM users WHERE email = ?').get('raced@test.local').n, 1);
});

test('signout does not report success when session lookup fails', async () => {
  const { env, session } = await fixture();
  const prepare = env.DB.prepare;
  env.DB.prepare = sql => {
    if (sql.startsWith('SELECT s.user_id')) throw new Error('lookup unavailable');
    return prepare(sql);
  };
  const res = await worker.fetch(new Request('https://example.test/api/auth/signout', { method: 'POST', headers: { Authorization: `Bearer ${session.access_token}`, 'X-Saydaliti': '1', 'Content-Type': 'application/json' } }), env, {});
  assert.equal(res.status, 500);
  assert.equal(res.headers.get('Set-Cookie'), null);
  assert.equal(env.DB.raw.prepare('SELECT count(*) AS n FROM sessions').get().n, 1);
});
