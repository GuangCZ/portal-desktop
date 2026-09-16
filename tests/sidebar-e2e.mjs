// The sidebar's interaction rules, in a real Electron window.
// Rewritten from BeingDesktop 0.8.26 test/sidebar-ui.cjs (91 lines, 11 checks)
// for the React sidebar; 2026-09-16 (integration unit I6).
//
// Same method as the script it replaces, and the same honesty about scope: the
// renderer and the preload are the production ones, the ledger is the production
// reducer (desktop/main/shell/sidebar-state.ts), and everything a Being would
// answer is a local fixture. No Being is contacted, no Portal is started, no
// profile outside the temporary directory is touched — which is what lets this
// run anywhere, packaged or not.
//
// The five rules it pins are the ones that have broken before:
//   · the sidebar's two primary entries come first, in order;
//   · a pinned conversation appears exactly once, in 已置顶;
//   · exactly one conversation is marked current;
//   · a bound window says nothing about the ledger not being saved;
//   · a folded project stays folded across a state update, and across a reload;
//   · a pin made from the context menu is on disk when it is on screen.
// Plus the switch this unit exists for: a different Being, a different set, and
// (IM, 2026-09-16) the project menu: a new conversation is filed under the
// project it was started in, and「设为工作目录」moves the working directory —
// BeingDesktop's `projectMenu` / `selectSavedProject`.
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const esbuild = path.join(root, 'node_modules/.bin/esbuild');
const directory = await mkdtemp(path.join(os.tmpdir(), 'beings-sidebar-e2e-'));
const ids = Array.from({ length: 6 }, () => randomUUID());
const SCOPE_A = 'persist:loom-v1-' + 'a'.repeat(32);
const SCOPE_B = 'persist:loom-v1-' + 'b'.repeat(32);
const PROJECT = process.platform === 'win32' ? 'C:\\Users\\preview\\Projects\\BeingDesktop' : '/Users/preview/Projects/BeingDesktop';
const ledgerFile = path.join(directory, 'ledger.json');

/** The production bundles, built the way the packaged client builds them, minus
 * Vite's HTML handling — which this fixture supplies itself. */
async function build() {
  const bundle = path.join(directory, 'bundle');
  await mkdir(bundle, { recursive: true });
  await run(esbuild, ['desktop/preload/preload.ts', '--bundle', '--platform=node', '--format=cjs',
    '--external:electron', `--outfile=${path.join(bundle, 'preload.js')}`, '--log-level=warning'], { cwd: root });
  await run(esbuild, ['desktop/main/shell/sidebar-state.ts', '--bundle', '--platform=node', '--format=cjs',
    `--outfile=${path.join(bundle, 'ledger.js')}`, '--log-level=warning'], { cwd: root });
  await run(esbuild, ['desktop/renderer/main.tsx', '--bundle', '--format=iife', '--loader:.png=dataurl',
    '--define:import.meta.hot=undefined', `--outfile=${path.join(bundle, 'renderer.js')}`, '--log-level=warning'], { cwd: root });
  await writeFile(path.join(bundle, 'index.html'),
    '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Sidebar fixture</title>'
    + '<link rel="stylesheet" href="./renderer.css"></head><body><div id="root"></div>'
    + '<script src="./renderer.js"></script></body></html>');
  await writeFile(path.join(bundle, 'main.js'), MAIN);
  await writeFile(path.join(bundle, 'package.json'), JSON.stringify({ name: 'sidebar-fixture', version: '0.0.0', main: 'main.js' }));
  return bundle;
}

// The fixture main process. It answers the channels the shell opens with and
// nothing else, and the sidebar's three channels go through the real reducer over
// a JSON file this script reads back — so「落盘」means what it says.
const MAIN = `
const { app, BrowserWindow, ipcMain, net, protocol } = require('electron');
const { writeFileSync, readFileSync, existsSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { sidebarState, updateSidebar, addSidebarProject, assertSavedProject } = require('./ledger.js');
const file = ${JSON.stringify(ledgerFile)};
const ids = ${JSON.stringify(ids)};
const PROJECT = ${JSON.stringify(PROJECT)};
let scope = ${JSON.stringify(SCOPE_A)};
// BeingDesktop's disk.workspace, which this client reads as projectWorkspace.
let workspace = '';
let window;
const saved = () => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
const write = next => { writeFileSync(file, JSON.stringify(next, null, 2)); };
const ledger = () => sidebarState(saved(), scope, '');
const push = (channel, payload) => { if (window && !window.isDestroyed()) window.webContents.send(channel, payload); };
const sessions = ids.map((id, index) => ({ id, title: ['重新设计桌面侧边栏', 'Portal 更新与一键接管', '优化工具权限设置', '整理项目文档'][index % 4] + (index > 3 ? ' ' + index : ''),
  createdAt: Date.now() - index * 3600000, updatedAt: new Date(Date.now() - index * 3600000).toISOString(),
  truncated: false, count: 1, lastSeq: 1, busy: false, inFlight: false }));
let active = ids[0];
const chatState = () => ({ open: true, version: 1, identityKey: 'bound', active, cursor: 1, seeded: true, degraded: false,
  sessions, recovery: { phase: 'idle' } });
const snapshot = () => ({ desktopId: '11111111-1111-4111-8111-111111111111',
  settings: { endpoint: 'https://fixture.invalid/cz_being', being: 'cz_being', hasToken: true, workspace: path.join(app.getPath('userData'), 'workspace'),
    projectWorkspace: '', portalBinary: '', portalName: 'sidebar-fixture', autoStart: false, backgroundEnabled: false, allowExec: true, kitsEnabled: true },
  portal: { phase: 'stopped', message: '本机 Portal 未启动（夹具）。', logs: [] } });
const handle = (channel, callback) => ipcMain.handle(channel, (_event, ...args) => callback(...args));
// The shell is served from beings://desktop/ here as it is in the client
// (desktop/main/main.ts line 47 and 93), rather than from a file:// path. The
// origin is what decides whether the renderer has localStorage at all, and the
// sidebar's fold lives there — a fixture on file:// would be testing a window the
// client never opens.
protocol.registerSchemesAsPrivileged([{ scheme: 'beings', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

handle('beings:snapshot', snapshot);
handle('beings:appearance', () => 'light');
handle('beings:update-state', () => ({ phase: 'idle', currentVersion: '0.9.0-fixture', message: '', releaseUrl: '' }));
handle('beings:client-startup', () => ({ supported: false, enabled: false, message: '夹具不管理开机自启。' }));
handle('beings:town-live', () => ({ phase: 'unpaired', generation: 0, revision: 0, sync: 0, message: '夹具未连接小镇。', versions: { bonfire: 0, mail: 0, firesides: 0 } }));
handle('beings:town-auth', () => ({ configured: false }));
handle('beings:browser-state', () => ({ open: false, address: '', title: '', loading: false, canGoBack: false, canGoForward: false }));
handle('beings:browser-bounds', () => undefined);
handle('beings:chat-sessions', chatState);
handle('beings:chat-view', id => ({ sessionId: id, version: 1, rows: [], sent: [], replied: [], live: null, workerResults: [] }));
handle('beings:chat-composer-data', () => ({ kits: [], members: [], kitsError: '', membersError: '', connectionRevision: 0 }));
handle('beings:chat-change-session', id => {
  if (id === null) {
    const created = require('node:crypto').randomUUID();
    sessions.unshift({ id: created, title: '新会话', createdAt: Date.now(), updatedAt: new Date().toISOString(),
      truncated: false, count: 0, lastSeq: 0, busy: false, inFlight: false });
    active = created;
  } else active = id;
  push('beings:chat-state', chatState());
  return active;
});
handle('beings:sidebar-state', ledger);
handle('beings:sidebar-action', action => {
  write(updateSidebar(saved(), scope, '', action, sessions.map(item => item.id)));
  const next = ledger();
  push('beings:sidebar', next);
  return next;
});
handle('beings:sidebar-project-add', project => {
  write(addSidebarProject(saved(), scope, '', project));
  const next = ledger();
  push('beings:sidebar', next);
  return next;
});
// BeingDesktop's selectSavedProject (src/main.cjs:574). The production subsystem
// writes Settings.projectWorkspace and pushes the tool bridge; this fixture
// records the directory, which is the part the sidebar itself can be held to.
handle('beings:sidebar-project-select', project => {
  if (!assertSavedProject) throw new Error('fixture missing reducer');
  workspace = assertSavedProject(saved(), scope, '', project);
  const next = ledger();
  push('beings:sidebar', next);
  return next;
});
// The test's own controls. They are functions on the main process's global
// rather than channels, so the renderer cannot reach them and the bridge under
// test stays exactly the production one (playwright's electronApp.evaluate runs
// in this process).
globalThis.__fixtureAddProject = () => { write(addSidebarProject(saved(), scope, '', PROJECT)); push('beings:sidebar', ledger()); };
globalThis.__fixtureRepublishChat = () => { push('beings:chat-state', chatState()); };
globalThis.__fixtureSwitchBeing = () => { scope = ${JSON.stringify(SCOPE_B)}; push('beings:sidebar', ledger()); };
globalThis.__fixtureWorkspace = () => workspace;
globalThis.__fixtureFiledUnder = () => sidebarState(saved(), scope, '').tasks[active]?.project || '';

app.whenReady().then(() => {
  if (process.env.SIDEBAR_FIXTURE_PROFILE) app.setPath('userData', process.env.SIDEBAR_FIXTURE_PROFILE);
  protocol.handle('beings', request => {
    const name = new URL(request.url).pathname;
    return net.fetch(pathToFileURL(path.join(__dirname, name === '/' ? 'index.html' : name)).toString());
  });
  window = new BrowserWindow({ show: true, width: 1280, height: 860,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.loadURL('beings://desktop/');
});
app.on('window-all-closed', () => app.quit());
`;

let application;
const checks = [];
const check = (name, passed) => { checks.push({ name, passed: Boolean(passed) }); assert.ok(passed, name); };
try {
  const bundle = await build();
  application = await electron.launch({ args: [bundle], env: { ...process.env, SIDEBAR_FIXTURE_PROFILE: path.join(directory, 'profile') } });
  const page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const fixture = name => application.evaluate((_electron, name) => globalThis[name](), name);
  await page.locator('.session-sidebar').waitFor();
  await page.locator('#new-chat-session').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.sidebar-task-row').length >= 6);

  // 1. The two primary entries, in order, before anything a feature adds.
  check('primary-entry-order', (await page.locator('.sidebar-head > button').allTextContents())
    .slice(0, 2).map(text => text.trim()).join(',') === '新会话,搜索会话');

  // 2. Exactly one conversation is marked current, and the sidebar says nothing
  //    about the ledger: both notes it can show («没有连上侧栏账本», «暂时无法读取»)
  //    are for a window that is not saving, and this one is.
  check('only-current-task-selected', await page.locator('.session-shortcut[aria-current=page]').count() === 1);
  check('no-ledger-note-while-bound', await page.locator('.sidebar-note').count() === 0);

  // 3. A pin from the context menu: on screen once, in 已置顶, and on disk.
  const target = page.locator(`[data-task-id="${ids[1]}"]`).first();
  await target.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '置顶', exact: true }).click();
  await page.waitForFunction(id => document.querySelector(`[aria-label="已置顶"] [data-task-id="${id}"]`), ids[1]);
  check('pinned-task-only-once', await page.locator(`[data-task-id="${ids[1]}"]`).count() === 1);
  const written = JSON.parse(await readFile(ledgerFile, 'utf8'));
  check('pin-saved-to-disk', written.owners[SCOPE_A].tasks[ids[1]].pinned === true);
  check('only-current-task-still-selected', await page.locator('.session-shortcut[aria-current=page]').count() === 1);

  // 4. A folded project stays folded across a state update. The fold is the
  //    window's, the ledger is the main process's, and the two must not fight.
  await fixture('__fixtureAddProject');
  await page.locator('.sidebar-project-toggle').first().waitFor();
  await page.locator('.sidebar-project-toggle').first().click();
  await page.waitForFunction(() => document.querySelector('.sidebar-project-toggle')?.getAttribute('aria-expanded') === 'false');
  await fixture('__fixtureRepublishChat');
  await page.waitForTimeout(200);
  check('fold-survives-state-update', await page.locator('.sidebar-project-toggle').first().getAttribute('aria-expanded') === 'false');

  //    And across a reload — 0.8.26's second fold check, and the one that makes
  //    folding a project worth doing: the fold is stored under the Being's own
  //    key, so restarting the client finds it folded.
  await page.reload();
  await page.locator('.session-sidebar').waitFor();
  await page.locator('.sidebar-project-toggle').first().waitFor();
  check('fold-survives-reload', await page.locator('.sidebar-project-toggle').first().getAttribute('aria-expanded') === 'false');

  // 4b. The project menu, which is BeingDesktop's `projectMenu`
  //     (renderer/sidebar.js:168). Two of its three items are behaviours worth
  //     pinning here rather than in a unit test, because both are a click that
  //     has to reach the main process and come back:
  //       ·「+」creates a conversation and files it under THIS project;
  //       ·「设为工作目录」is 0.8.26's「浏览文件」→ `selectSavedProject`, which
  //         moves the directory the terminal, the console and the desktop tools
  //         start from. I6 shipped without the channel; IM restored it.
  const projectRow = page.locator('.sidebar-project-row').first();
  if (await projectRow.locator('.sidebar-project-toggle').getAttribute('aria-expanded') === 'false')
    await projectRow.locator('.sidebar-project-toggle').click();
  await page.waitForFunction(() => document.querySelector('.sidebar-project-toggle')?.getAttribute('aria-expanded') === 'true');
  const filedBefore = await application.evaluate(() => globalThis.__fixtureFiledUnder());
  await projectRow.locator('.project-new-task').click();
  await page.waitForFunction(project => !document.querySelector('.sidebar-section[aria-label^="项目"] .sidebar-empty') && Boolean(project), PROJECT);
  const filed = await application.evaluate(() => globalThis.__fixtureFiledUnder());
  check('project-new-task-binds-project', filed === PROJECT && filedBefore !== PROJECT);
  check('projects-contain-their-tasks',
    await page.locator('.sidebar-section[aria-label^="项目"] .sidebar-task-row').count() >= 1);

  check('workspace-unset-before-select', await application.evaluate(() => globalThis.__fixtureWorkspace()) === '');
  await projectRow.locator('.project-more').click();
  await page.getByRole('menuitem', { name: '设为工作目录', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.sidebar-menu'));
  check('project-select-moves-workspace', await application.evaluate(() => globalThis.__fixtureWorkspace()) === PROJECT);

  // 5. A different Being is a different set of pins, without a reload.
  await fixture('__fixtureSwitchBeing');
  await page.waitForFunction(id => !document.querySelector(`[aria-label="已置顶"] [data-task-id="${id}"]`), ids[1]);
  check('metadata-swaps-with-the-being', await page.locator('[aria-label="已置顶"]').count() === 0);

  check('no-script-errors', errors.length === 0);
  console.log('PASS sidebar rules: ' + checks.map(entry => entry.name).join(', '));
} finally {
  await application?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
