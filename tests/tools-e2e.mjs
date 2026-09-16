// The packaged client, a local fake relay, and one Being tool call that only
// runs because a person allowed it. 2026-09-16, integration plan §6.2.
//
// WHY THIS SCRIPT EXISTS, AND WHY IT MUST RUN AGAINST `npm run package` OUTPUT
// RATHER THAN `npm start`:
//
// `DesktopToolLink`'s default transport is `createRequire(import.meta.url)('ws')`
// (desktop/main/tools/tool-link.ts, PACKAGING CONTRACT). In a development tree
// `node_modules/ws` is always present, so typecheck, vitest and `npm start` all
// pass whether or not `ws` is a runtime dependency. A release build is different:
// @electron/packager prunes devDependencies out of the asar, and the measured
// failure is `MODULE_NOT_FOUND` the first time anyone presses「连接 Being 工具」.
// Bundling ws into the main chunk instead has been measured too and is worse — a
// bundle that dies on its first outbound frame with `bufferUtil.mask is not a
// function`. So the only verification of that contract is this script, run
// against the packaged app. Do not "simplify" it into a vitest case.
//
// It never talks to a real Being: the fixture below is an HTTP server on
// 127.0.0.1 that answers the four endpoints the client verifies a connection
// with, plus a `/_relay` WebSocket speaking the reverse-MCP contract
// (docs/interfaces.md §6).
import { launchDesktop } from './support/electron-lifecycle.mjs';
import { desktopExecutable } from './support/desktop.mjs';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const executablePath = await desktopExecutable();
const directory = await mkdtemp(path.join(tmpdir(), 'beings-tools-e2e-'));
const token = 'local-fixture-token';
const beingId = 'willow';

/** The page the Being will ask to open, served by the same fixture. */
const PAGE = '/being-asked-for-this';

let relay = null;
let handshakes = 0;
let rejected = 0;
let toolNames = [];
let portalName = '';
let rpcId = 0;
const pending = new Map();

const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++rpcId;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timed out: ${method}`)); }, 20000);
  pending.set(id, { resolve, reject, timer });
  relay.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
});

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const json = (data, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
  if (url.pathname === PAGE) {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<title>Being 打开的页面</title><h1>Being 打开的页面</h1>');
    return;
  }
  if (url.searchParams.get('token') !== token) return json({ error: 'unauthorized' }, 401);
  if (url.pathname.endsWith('/api/status')) return json({ being_name: 'Willow', description: '工具桥冒烟夹具。' });
  if (url.pathname.endsWith('/health')) return json({ status: 'ok', commit: 'test' });
  if (url.pathname.endsWith('/api/history')) return json({ messages: [] });
  if (url.pathname.endsWith('/api/llm/config')) return json({ model: 'test-model', provider: 'test', presets: [] });
  if (url.pathname.endsWith('/api/stream/active')) { response.writeHead(204); response.end(); return; }
  json({ error: 'not found' }, 404);
});

// The relay side of the handshake, exactly as docs/interfaces.md §6 describes it:
// the client opens the socket and sends its identity first; the relay answers
// `{ok:true, being_id, relay_keepalive:'text-v1'}` and then drives the session.
const sockets = new WebSocketServer({ server, path: '/_relay' });
sockets.on('connection', socket => {
  let ready = false;
  socket.on('message', data => {
    const message = JSON.parse(data.toString());
    if (!ready) {
      if (message.being_id !== beingId || message.loom_token !== token || typeof message.portal_name !== 'string') {
        rejected++;
        socket.send(JSON.stringify({ ok: false }));
        return;
      }
      portalName = message.portal_name;
      socket.send(JSON.stringify({ ok: true, being_id: beingId, relay_keepalive: 'text-v1' }));
      relay = socket;
      ready = true;
      handshakes++;
      return;
    }
    if (message.type === 'keepalive') { socket.send(JSON.stringify({ type: 'keepalive_ack' })); return; }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

let app;
let failure;
try {
  app = await launchDesktop({ executablePath, env: { ...process.env, PORTAL_DESKTOP_USER_DATA: path.join(directory, 'profile') } });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  // 1. Bind the fixture Being, exactly as a person would.
  await page.getByRole('button', { name: '连接我的 Being' }).click();
  await page.locator('#connection-link').fill(`${base}/${beingId}/?token=${token}`);
  await page.locator('#portal-name-input').fill('tools-smoke');
  await page.locator('#workspace-input').fill(path.join(directory, 'workspace'));
  await page.locator('#background-input').uncheck();
  await page.getByRole('button', { name: '保存、连接并启动' }).click();
  await page.waitForFunction(() => !document.querySelector('#settings-dialog').open, { timeout: 30000 });

  // 2. Open the tool panel and connect the bridge. This is the line that fails
  //    with MODULE_NOT_FOUND when `ws` is not a runtime dependency.
  await page.locator('#open-tools').click();
  await page.locator('#desktop-tools').waitFor();
  await page.locator('#tools-connection').click();
  await page.locator('#tools-link-toggle').click();
  await page.waitForFunction(
    () => document.querySelector('#tools-link-status')?.textContent === 'Being 工具已连接',
    { timeout: 30000 },
  );
  assert.equal(handshakes, 1, '工具桥应完成一次握手');
  assert.equal(rejected, 0);
  assert.match(portalName, /^being-desktop-tools-[0-9a-f-]{36}$/);

  // 3. The reverse-MCP session the relay drives.
  const initialized = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'tools-e2e-fixture', version: '1.0.0' },
  });
  assert.equal(initialized.serverInfo.name, 'being-desktop-tools');
  const listed = await rpc('tools/list');
  toolNames = listed.tools.map(tool => tool.name);
  assert.ok(toolNames.includes('desktop_browser_open'), `tools/list 缺少 desktop_browser_open：${toolNames.join(', ')}`);
  assert.ok(!toolNames.some(name => name.startsWith('desktop_worker_')), '直接模式不应公开 worker 工具');
  // Every tool advertises this client as its only execution target.
  const open = listed.tools.find(tool => tool.name === 'desktop_browser_open');
  assert.deepEqual(open.inputSchema.properties.target_portal.enum, [portalName]);

  // 4. The call waits for a person. Nothing has opened yet.
  //    The panel opened a blank first tab of its own when it was shown (0.8.26's
  //    `show()` does the same), so what must not change is the count.
  const tabs = page.locator('#tools-browser-tabs .browser-tab');
  const before = await tabs.count();
  const call = rpc('tools/call', {
    name: 'desktop_browser_open',
    arguments: { url: `${base}${PAGE}`, place: portalName, target_portal: portalName },
  });
  const card = page.locator('#tools-requests .tools-request');
  await card.waitFor();
  assert.match(await card.locator('strong').textContent(), /打开网页/);
  assert.match(await card.locator('pre').textContent(), new RegExp(PAGE));
  assert.equal(await tabs.count(), before, '未确认前不应打开标签页');

  // 5. Allow it — and only then does the browser open the page.
  await card.getByRole('button', { name: '允许本次' }).click();
  const result = await call;
  assert.equal(result.isError, false, JSON.stringify(result));
  await page.waitForFunction(
    title => [...document.querySelectorAll('#tools-browser-tabs .browser-tab button:first-child')].some(tab => tab.textContent.includes(title)),
    'Being 打开的页面',
    { timeout: 20000 },
  );
  assert.equal(await tabs.count(), before + 1, '允许后应多出一个标签页');
  await page.waitForFunction(() => !document.querySelector('#tools-requests .tools-request'));

  // 6. A second call, denied, must leave the client exactly as it was.
  const denied = rpc('tools/call', {
    name: 'desktop_browser_open',
    arguments: { url: `${base}${PAGE}?second=1`, place: portalName, target_portal: portalName },
  });
  await card.waitFor();
  const tabsBefore = await tabs.count();
  await card.getByRole('button', { name: '拒绝' }).click();
  const refusal = await denied;
  assert.equal(refusal.isError, true);
  assert.equal(await tabs.count(), tabsBefore);

  assert.deepEqual(errors, [], `渲染层报错：${errors.join(' | ')}`);
  console.log(`PASS: tools-e2e（握手 1 次，tools/list ${toolNames.length} 个工具，允许 1 次、拒绝 1 次）`);
} catch (error) {
  failure = error;
} finally {
  if (app) await app.close().catch(() => {});
  for (const client of sockets.clients) client.terminate();
  sockets.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
if (failure) { console.error(failure); process.exit(1); }
