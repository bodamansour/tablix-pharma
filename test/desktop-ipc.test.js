// The Windows program's bridge (desktop/main.js): every IPC handler checks who is asking before doing anything,
// and the page runs isolated and sandboxed. The real handlers also run with Electron stubs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const main = new URL('../desktop/main.js', import.meta.url);
const src = readFileSync(main, 'utf8');

test('every IPC handler checks the sender first', () => {
  const all = [...src.matchAll(/ipcMain\.handle\(/g)].map((m) => m.index);
  assert.ok(all.length >= 10, `found ${all.length} handlers`);
  for (const at of all) {
    // From this handler to its first statement (the next line for a block body).
    const head = src.slice(at, src.indexOf('\n', src.indexOf('\n', at) + 1));
    const m = /^ipcMain\.handle\('([^']+)',\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*(.*)$/s.exec(head);
    assert.ok(m, `unrecognised handler: ${head.split('\n')[0]}`);
    const [, name, params, body] = m;
    const first = body.startsWith('{\n') ? body.slice(2) : body.split('\n')[0];
    assert.match(params, /^e\b/, `${name}: the event is used`);
    // The check must decide the outcome: refuse (return/throw) when it fails, or choose the result (ternary / if-body).
    const sender = String.raw`trusted\(e\)`;
    const guards = new RegExp(String.raw`^\s*\{?\s*(?:if \([^\n]*!${sender}[^\n]*\) (?:return|throw)\b|\(${sender} \?|if \(${sender}\) )`);
    assert.match(first, guards, `${name}: refuses before anything else when the sender is not trusted`);
  }
});

test('only the main window top frame can use IPC, and only the start page changes mode', async () => {
  const site = 'https://tablix.example.test';
  const local = 'app://saydaliti';
  const registered = new Map();
  const writes = [], loads = [];
  const win = { webContents: {}, isDestroyed: () => false, loadURL: (url) => loads.push(url) };
  const electron = {
    app: { getPath: () => '.', requestSingleInstanceLock: () => true, on() {}, whenReady: () => new Promise(() => {}) },
    protocol: { registerSchemesAsPrivileged() {} },
    ipcMain: { handle: (name, fn) => registered.set(name, fn) },
  };
  const require = createRequire(main);
  runInNewContext(src + '\nwin = mainWindow;', {
    require: (name) => name === 'electron' ? electron
      : name === 'node:fs/promises' ? { writeFile: async (...args) => writes.push(args) } : require(name),
    URL, __dirname: '.',
    process: { argv: [], env: { SAYDALITI_SITE: site }, on() {} },
    mainWindow: win,
  });
  const page = (url, origin) => {
    const frame = { url, origin };
    win.webContents.mainFrame = frame;
    return { sender: win.webContents, senderFrame: frame };
  };
  const status = registered.get('genius:status');
  const setMode = registered.get('mode:set');

  const normal = page(local + '/index.html', local);
  assert.equal(status(normal)?.enabled, false);
  assert.equal(status({ ...normal, senderFrame: { ...normal.senderFrame } }), null, 'nested same-origin frame');
  assert.equal(status({ ...normal, sender: { mainFrame: normal.senderFrame } }), null, 'other window');
  assert.equal(status({ ...normal, senderFrame: null }), null, 'missing frame');
  normal.senderFrame.detached = true;
  assert.equal(status(normal), null, 'detached frame');
  assert.equal(status(page('app://other/index.html', 'app://other')), null, 'different app origin');
  assert.equal(status(page(site + '.invalid/index.html', site + '.invalid')), null, 'different website origin');
  assert.equal(status(page('about:blank', site)), null, 'inherited origin without an app page');
  assert.equal(status(page(site + '/index.html', site))?.enabled, false);

  assert.equal(await setMode(page(local + '/index.html', local), 'online'), null);
  assert.equal(await setMode(page(site + '/start.html', site), 'online'), null);
  assert.equal(await setMode(page(local + '/start.html?offline=2', local), 'online'), null);
  assert.equal(writes.length, 0);
  assert.equal(await setMode(page(local + '/start.html', local), 'local'), 'local');
  assert.equal(await setMode(page(local + '/start.html?offline=1', local), 'online'), 'online');
  assert.equal(writes.length, 2);
  assert.deepEqual(loads, [local + '/index.html', site + '/index.html']);
});

test('the window is isolated and sandboxed', () => {
  const prefs = /webPreferences:\s*\{([^}]*)\}/.exec(src)?.[1] || '';
  assert.match(prefs, /contextIsolation: true/);
  assert.match(prefs, /nodeIntegration: false/);
  assert.match(prefs, /sandbox: true/);
});

test('an update finds the data of the version named Saydaliti, and the United sync keeps starting with Windows', () => {
  const pin = src.indexOf("app.setPath('userData', LEGACY_DATA)");
  assert.ok(pin > 0, 'the old data folder is used when it is there');
  assert.match(src, /LEGACY_DATA = join\(app\.getPath\('appData'\), 'Saydaliti'\)/);
  for (const use of ["app.requestSingleInstanceLock()", "app.getPath('userData')"]) {
    assert.ok(src.indexOf(use) > pin, `${use} comes after the data folder is chosen`);
  }
  assert.match(src, /if \(SYNC\?\.enabled\) \{ startWithWindows\(true\);/, 'the start-with-Windows entry is renewed at every start');
});
