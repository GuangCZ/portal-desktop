// Side by Side, in a real Electron window, against a fake Being.
// Rewritten on 2026-09-16 (integration unit I6b) from the script that drove the
// retired `beings://chat` iframe.
//
// ── WHAT CHANGED, AND WHAT DID NOT ───────────────────────────────────────────
// The old script drove Loom's own page inside `#chat-frame` and read Side by Side
// off the shell topbar, which learned it from a `beings:sbs-state` message the
// page posted. That page, that message and that frame are gone (MIGRATION.md,
// "P1 完成状态"), so the script reported a skip.
//
// The rules it pinned are not gone, and they are pinned here, on the native
// settings page this unit adds:
//
//   1. Before a read confirms one, the switch is disabled and reports NO pressed
//      state — unknown is not off.
//   2. A rejected PATCH does not optimistically flip the switch.
//   3. A 503, and an answer that simply omits `sbs_enabled`, put the state back
//      to unknown; a later successful read recovers it.
//   4. Only explicit toggles write configuration.
//
// The old script's fifth rule — an older pending GET cannot undo a subsequently
// confirmed toggle — moved to vitest, where it can be expressed exactly: this
// client cannot overlap a read and a write from the page (the page refuses while
// `busy`), and the rule now lives in `ModelConfig` itself as the BUSY answer
// asserted by tests/model-settings-config.test.ts ("saving rejects concurrent
// requests and discards older configuration reads").
//
// ── METHOD ───────────────────────────────────────────────────────────────────
// The method is tests/sidebar-e2e.mjs's, and so is the honesty about scope: the
// renderer, the preload and the model-settings subsystem are the production ones
// — the subsystem is bundled from `desktop/main/subsystems/model-settings.ts` and
// installed with the context production installs it with — and everything a Being
// would answer is a local HTTP fixture. No Being is contacted, no Portal is
// started, no profile outside the temporary directory is touched, so this runs
// anywhere, packaged or not. Every request the page makes is a real PATCH and a
// real GET of `/api/llm/config`, which is the only way to assert that the wire
// shape is `{sbs_enabled:'on'}` — the string, measured from Loom 1.8.0 rather
// than inferred (docs/migration/i6b-model-settings.md §1.7).
import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const esbuild = path.join(root, 'node_modules/.bin/esbuild');
const directory = await mkdtemp(path.join(os.tmpdir(), 'beings-sbs-e2e-'));

/** The Being's stored configuration. `presets` is what the model list renders
 * from; one of them is keyless, so the page's self-hosted grouping is exercised
 * on the way past. */
let stored = {
  model: 'fixture-model-a', provider: 'openai', base_url: 'https://model.fixture.invalid/v1',
  has_api_key: true, thinking: '', temperature: null, sbs_enabled: false,
  presets: [
    { id: 'fixture-a', label: 'Fixture A', model: 'fixture-model-a', provider: 'openai', has_key: true },
    { id: 'fixture-b', label: 'Fixture B', model: 'fixture-model-b', provider: 'openai', has_key: true },
    { id: 'self-hosted-fixture', label: 'Self Hosted', model: 'fixture-self-hosted', provider: 'self-hosted' },
  ],
};
let readStatus = 200;
let dropSbs = false;
let rejectPatch = false;
let holdReads = true;
const reads = [];
const patches = [];
const pendingReads = [];
const release = queue => { for (const finish of queue.splice(0)) finish(); };

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const json = (data, code = 200) => { response.writeHead(code, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
  if (!url.pathname.endsWith('/api/llm/config')) { response.writeHead(404); response.end(); return; }
  if (request.method === 'PATCH') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const patch = JSON.parse(body);
    patches.push(patch);
    if (rejectPatch) return json({ error: 'fixture rejection' }, 500);
    // Loom 1.8.0's own semantics: the string 'on'/'off' in, a boolean out.
    const { sbs_enabled: sbs, ...rest } = patch;
    stored = { ...stored, ...rest, ...(sbs === undefined ? {} : { sbs_enabled: sbs === 'on' }) };
    return json({ ok: true, config: stored });
  }
  reads.push(Date.now());
  const finish = () => {
    if (readStatus !== 200) return json({ error: 'fixture unavailable' }, readStatus);
    const answer = { ...stored };
    if (dropSbs) delete answer.sbs_enabled;
    json(answer);
  };
  if (holdReads) pendingReads.push(finish); else finish();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
// Loopback may use HTTP (parseConnection, desktop/main/common/loom-connection.ts).
const ADDRESS = `${origin}/fixture_being/?token=${'f'.repeat(64)}&relay_secret=fixture-relay`;

/** The production bundles, built the way the packaged client builds them, minus
 * Vite's HTML handling — which this fixture supplies itself. */
async function build() {
  const bundle = path.join(directory, 'bundle');
  await mkdir(bundle, { recursive: true });
  await run(esbuild, ['desktop/preload/preload.ts', '--bundle', '--platform=node', '--format=cjs',
    '--external:electron', `--outfile=${path.join(bundle, 'preload.js')}`, '--log-level=warning'], { cwd: root });
  // The subsystem under test, bundled on its own rather than through
  // extensions.ts: it needs no peer, and the rest of that list would drag in the
  // tool browser and the terminal, whose native bindings this fixture has no use
  // for. It is installed below with the same context production gives it.
  await run(esbuild, ['desktop/main/subsystems/model-settings.ts', '--bundle', '--platform=node', '--format=cjs',
    '--external:electron', `--outfile=${path.join(bundle, 'model-settings.js')}`, '--log-level=warning'], { cwd: root });
  await run(esbuild, ['desktop/renderer/main.tsx', '--bundle', '--format=iife', '--loader:.png=dataurl',
    '--define:import.meta.hot=undefined', `--outfile=${path.join(bundle, 'renderer.js')}`, '--log-level=warning'], { cwd: root });
  await writeFile(path.join(bundle, 'index.html'),
    '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>SBS fixture</title>'
    + '<link rel="stylesheet" href="./renderer.css"></head><body><div id="root"></div>'
    + '<script src="./renderer.js"></script></body></html>');
  await writeFile(path.join(bundle, 'main.js'), MAIN);
  await writeFile(path.join(bundle, 'package.json'), JSON.stringify({ name: 'sbs-fixture', version: '0.0.0', main: 'main.js' }));
  return bundle;
}

// The fixture main process. It answers the channels the shell opens with, and
// hands the model-settings subsystem the real context — so `beings:model-config
// -get`, `beings:model-config-save` and `beings:sbs-set` are registered by the
// production code and speak to the HTTP fixture over `net.fetch`.
const MAIN = `
const { app, BrowserWindow, ipcMain, net, protocol } = require('electron');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { installModelSettingsSubsystem } = require('./model-settings.js');
const ADDRESS = ${JSON.stringify(ADDRESS)};
let window;
const push = (channel, payload) => { if (window && !window.isDestroyed()) window.webContents.send(channel, payload); };
const snapshot = () => ({ desktopId: '11111111-1111-4111-8111-111111111111',
  settings: { endpoint: ${JSON.stringify(origin)} + '/fixture_being', being: 'fixture_being', hasToken: true,
    workspace: app.getPath('userData'), projectWorkspace: '', portalBinary: '', portalName: 'sbs-fixture',
    autoStart: false, backgroundEnabled: false, allowExec: true, kitsEnabled: true },
  portal: { phase: 'stopped', message: '本机 Portal 未启动（夹具）。', logs: [] } });
const handle = (channel, callback) => ipcMain.handle(channel, (_event, ...args) => callback(...args));
protocol.registerSchemesAsPrivileged([{ scheme: 'beings', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

handle('beings:snapshot', snapshot);
handle('beings:appearance', () => 'light');
handle('beings:update-state', () => ({ phase: 'idle', currentVersion: '0.9.0-fixture', message: '', releaseUrl: '' }));
handle('beings:client-startup', () => ({ supported: false, enabled: false, message: '夹具不管理开机自启。' }));
handle('beings:town-live', () => ({ phase: 'unpaired', generation: 0, revision: 0, sync: 0, message: '夹具未连接小镇。', versions: { bonfire: 0, mail: 0, firesides: 0 } }));
handle('beings:town-auth', () => ({ configured: false }));
handle('beings:browser-state', () => ({ open: false, address: '', title: '', loading: false, canGoBack: false, canGoForward: false }));
handle('beings:browser-bounds', () => undefined);
handle('beings:chat-sessions', () => ({ open: false, version: 0, identityKey: '', active: '', cursor: 0, seeded: true, degraded: false, sessions: [], recovery: { phase: 'idle' } }));

// One operation at a time, in order: production's own queue (main.ts).
let queue = Promise.resolve();
const exclusive = operation => { const next = queue.then(operation, operation); queue = next.catch(() => {}); return next; };
const subsystem = installModelSettingsSubsystem({
  handle, exclusive, window: () => window,
  store: { connection: null, connectionAddress: ADDRESS, settings: {}, extras: {}, saveExtra: async () => {} },
  electron: { net }, userData: '', desktopId: '11111111-1111-4111-8111-111111111111', clientVersion: '0.9.0-fixture',
  fetchImpl: (url, options) => net.fetch(url, options),
  onError: (scope, error) => { globalThis.__fixtureErrors.push(scope + ': ' + (error && error.message)); },
  registry: { get: () => null, require: () => { throw new Error('no peer in this fixture'); } },
  push,
});
globalThis.__fixtureErrors = [];
// The test's own control, on the main process's global rather than a channel, so
// the renderer cannot reach it and the bridge under test stays production's.
globalThis.__fixtureBind = () => { subsystem.connectionVerified(null); return subsystem.ready; };
globalThis.__fixtureState = () => subsystem.state();

app.whenReady().then(() => {
  if (process.env.SBS_FIXTURE_PROFILE) app.setPath('userData', process.env.SBS_FIXTURE_PROFILE);
  protocol.handle('beings', request => {
    const name = new URL(request.url).pathname;
    return net.fetch(pathToFileURL(path.join(__dirname, name === '/' ? 'index.html' : name)).toString());
  });
  window = new BrowserWindow({ show: true, width: 1280, height: 900,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.loadURL('beings://desktop/');
});
app.on('window-all-closed', () => app.quit());
`;

let application;
const checks = [];
const check = (name, passed) => { checks.push({ name, passed: Boolean(passed) }); assert.ok(passed, name); };
const until = async (predicate, label = 'condition') => {
  const end = Date.now() + 15000;
  while (!await predicate()) {
    assert.ok(Date.now() < end, `fixture reached ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

try {
  const bundle = await build();
  application = await electron.launch({ args: [bundle], env: { ...process.env, SBS_FIXTURE_PROFILE: path.join(directory, 'profile') } });
  const page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const evaluate = name => application.evaluate((_electron, name) => globalThis[name](), name);
  const toggle = page.locator('#model-sbs-toggle');
  const configured = page.locator('#model-sbs-configured');
  const status = page.locator('#model-config-status');

  // Open the page the way a user does: the sidebar footer's third link.
  await page.locator('#open-models').waitFor();
  // Bind the Being first so the subsystem's own first read is the one being held.
  const binding = evaluate('__fixtureBind');
  await until(() => reads.length > 0, 'the first read');
  await page.locator('#open-models').click();
  await page.locator('#model-settings-page').waitFor();

  // 1. Unknown is not off. While no read has confirmed a value the switch is
  //    disabled and carries no `aria-pressed` at all.
  check('unknown-before-first-read-is-not-pressed', await toggle.getAttribute('aria-pressed') === null);
  check('unknown-before-first-read-is-disabled', await toggle.isDisabled());
  check('unknown-before-first-read-says-so', (await configured.textContent()).trim() === '未知');
  check('no-write-before-the-user-asks', patches.length === 0);

  holdReads = false;
  release(pendingReads);
  await binding;
  await page.waitForFunction(() => document.querySelector('#model-sbs-toggle')?.getAttribute('aria-pressed') === 'false');
  check('confirmed-read-enables-the-switch', !await toggle.isDisabled());
  check('confirmed-read-shows-the-saved-value', (await configured.textContent()).trim() === '已关闭');

  // The model list arrived with it, grouped the way Loom groups it.
  await page.waitForFunction(() => document.querySelectorAll('#model-select option').length === 4);
  check('self-hosted-group-first', (await page.locator('#model-select optgroup').first().getAttribute('label')) === '自部署');
  check('custom-option-offered', await page.locator('#model-select option[value="__custom__"]').count() === 1);
  check('existing-key-is-never-filled', await page.locator('#model-api-key').inputValue() === '');

  // 2. A rejected PATCH does not flip the switch. The click is real; the answer
  //    is a 500, and the display must still read what the Being last confirmed.
  rejectPatch = true;
  await toggle.click();
  await until(() => patches.length === 1, 'the rejected write');
  await page.waitForFunction(() => !document.querySelector('#model-sbs-toggle')?.disabled);
  check('rejected-write-does-not-flip', await toggle.getAttribute('aria-pressed') === 'false');
  check('rejected-write-says-why', (await page.locator('#model-sbs-status').textContent()).includes('未确认'));
  rejectPatch = false;

  // 3. An accepted toggle writes Loom's own shape and the display follows the
  //    Being's echo, not the click.
  await toggle.click();
  await page.waitForFunction(() => document.querySelector('#model-sbs-toggle')?.getAttribute('aria-pressed') === 'true');
  check('toggle-writes-the-measured-shape', JSON.stringify(patches.at(-1)) === JSON.stringify({ sbs_enabled: 'on' }));
  check('toggle-confirms-by-rereading', stored.sbs_enabled === true);
  check('enabled-shows-the-saved-value', (await configured.textContent()).trim() === '已开启');

  // 4. A 503 puts it back to unknown, and a refresh recovers it.
  readStatus = 503;
  await page.locator('#model-config-refresh').click();
  await page.waitForFunction(() => document.querySelector('#model-sbs-configured')?.textContent.trim() === '未知');
  check('failed-read-returns-to-unknown', await toggle.getAttribute('aria-pressed') === null);
  check('failed-read-disables-the-switch', await toggle.isDisabled());
  check('failed-read-explains-itself', (await status.textContent()).length > 0);

  readStatus = 200;
  await page.locator('#model-config-refresh').click();
  await page.waitForFunction(() => document.querySelector('#model-sbs-toggle')?.getAttribute('aria-pressed') === 'true');
  check('refresh-recovers-the-state', (await configured.textContent()).trim() === '已开启');

  // An answer that simply omits the field is unknown too — not off.
  dropSbs = true;
  await page.locator('#model-config-refresh').click();
  await page.waitForFunction(() => document.querySelector('#model-sbs-configured')?.textContent.trim() === '未知');
  check('missing-field-is-unknown-not-off', await toggle.getAttribute('aria-pressed') === null);
  dropSbs = false;
  await page.locator('#model-config-refresh').click();
  await page.waitForFunction(() => document.querySelector('#model-sbs-toggle')?.getAttribute('aria-pressed') === 'true');

  // 5. 运行中 has no source in this client and says so rather than guessing.
  check('running-state-is-honestly-unknown', (await page.locator('#model-sbs-active').textContent()).trim() === '未知');

  // 6. Only explicit toggles write configuration. Four refreshes and a page's
  //    worth of reads later, the only two writes are the two clicks above.
  check('only-explicit-toggles-write', patches.length === 2);
  check('every-write-is-a-side-by-side-write', patches.every(patch => Object.keys(patch).join() === 'sbs_enabled'));

  // A model save is a different write, and it carries no key when none was typed.
  await page.locator('#model-select').selectOption({ index: 2 });
  await page.waitForFunction(() => !document.querySelector('#model-config-save')?.disabled);
  await page.locator('#model-config-save').click();
  await until(() => patches.length === 3, 'the model write');
  check('model-save-omits-a-blank-key', !Object.hasOwn(patches.at(-1), 'api_key'));
  check('model-save-is-confirmed-by-reread', stored.model === patches.at(-1).model);
  await page.waitForFunction(() => document.querySelector('#model-config-status')?.textContent.includes('已保存'));

  const mainErrors = await application.evaluate(() => globalThis.__fixtureErrors);
  check('no-main-process-errors', mainErrors.length === 0, mainErrors);
  check('no-renderer-errors', errors.length === 0, errors);
  console.log(`PASS: Side by Side unknown/confirmed states, rejected and accepted writes, failure recovery and the measured 'on'/'off' wire shape — ${checks.length} checks.`);
} finally {
  release(pendingReads);
  await application?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
