// What the packaged client puts on the wire when a person says one sentence.
//
// REWRITTEN 2026-09-16 (integration unit I5), per integration-plan.md §6.1. The
// previous script drove the conversation through `page.frameLocator('#chat-frame')`
// — the sandboxed `beings://chat` document the native React conversation replaced —
// and had been printing a skip ever since that document was removed.
//
// The subject is narrower than the old script's and deliberately so: this is the
// conversation's own protocol contract, asserted against the packaged
// application rather than against a module. Everything it checks is something a
// unit test cannot see, because it only becomes true once the main process, the
// preload bridge and the React page are the real ones:
//
//   * the request-context frame is built in the main process at send time and
//     wraps the human's text on the wire (main/chat/prepare-message.ts), while
//     the row this machine keeps is unframed (main/chat/store.ts);
//   * the body carries `scene_id`, `scene_meta.scene_label` and `client_ref`;
//   * `GET /api/history` is read exactly once as the baseline, not per render;
//   * stopping reaches `POST /api/stop`;
//   * the conversation survives a restart, through the encrypted cache and the
//     scene the Being stored.
//
// Kits, the tool bridge and orchestration are out of scope here — tools-e2e.mjs
// and orchestration-e2e.mjs own those. The relay fixture exists only so the
// bridge reaches its normal connected state; nothing is asserted through it.
//
// Fixtures only: a local HTTP + WS server on 127.0.0.1 standing in for a Being.
// No real Being, no real credentials, no message ever leaves this machine.
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { launchDesktop } from './support/electron-lifecycle.mjs';
import { desktopExecutable } from './support/desktop.mjs';

let executablePath;
try {
  executablePath = await desktopExecutable();
} catch (error) {
  // A step that ran nothing is not a step that passed (scripts/test-all.mjs).
  console.log(`SKIPPED: ${error.message}`);
  process.exit(0);
}

const TOKEN = 'local-fixture-token';
const PREFIX = '[Being Desktop request context v1; length=';
const SUFFIX = '\n[/Being Desktop request context v1]\n\n';
const FIRST = '在吗';
const SECOND = 'test-stop';

const dir = await mkdtemp(path.join(tmpdir(), 'beings-smoke-'));
const profile = path.join(dir, 'profile');
const checks = [];
const check = (name, condition) => {
  assert.equal(condition, true, name);
  checks.push(name);
  process.stdout.write(`${name}: passed\n`);
};

/** The frame's own reader, kept independent of the implementation on purpose: if
 * main/chat/frame.ts and this diverge, the fixture is what a Being would see.
 * The declared length is the authority, exactly as `unwrapMessage` treats it. */
function unwrap(text) {
  if (typeof text !== 'string' || !text.startsWith(PREFIX)) return null;
  const header = /^\[Being Desktop request context v1; length=(\d{1,6})\]\n/.exec(text);
  if (!header) return null;
  const declared = Number(header[1]);
  const end = header[0].length + declared;
  if (text.slice(end, end + SUFFIX.length) !== SUFFIX) return null;
  return { declared, context: text.slice(header[0].length, end), body: text.slice(end + SUFFIX.length) };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
/** Wait for a fixture-side condition the page gives no signal for. */
async function until(what, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for: ${what}`);
}

// ── the Being fixture ───────────────────────────────────────────────────────
const history = [];
let seq = 1;
let historyReads = 0;
let stopPosts = 0;
const sends = [];
let holdOpen = null;
/** The breath currently running, as `GET /api/stream/active` reports it. The
 * client refuses to stop a stream it cannot prove is this conversation's
 * (main/chat/being-chat.ts `stop`), so a fixture that always answers 204 makes
 * the stop button a no-op — the refusal, not the stop, is what would be tested. */
let active = null;

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const json = (data, status = 200) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(data));
  };
  if (url.searchParams.get('token') !== TOKEN) return json({ error: 'unauthorized' }, 401);
  if (url.pathname.endsWith('/api/status')) return json({ being_name: 'Willow', description: '夹具 Being' });
  if (url.pathname.endsWith('/health')) return json({ status: 'ok', commit: 'fixture' });
  if (url.pathname.endsWith('/api/history')) { historyReads++; return json({ messages: history }); }
  if (url.pathname.endsWith('/api/stream/active')) {
    if (!active) { response.writeHead(204); response.end(); return; }
    // One delta, carrying the scene: `speaking` is true because the last event is
    // not a `message_stop`, and `origin: 'human'` keeps it from reading as an
    // autonomous breath no conversation owns.
    return json({
      stream_id: active.streamId,
      origin: 'human',
      next_seq: 2,
      events: [{ event: 'content_block_delta', seq: 1, data: { scene_id: active.scene, delta: { text: '…' } } }],
    });
  }
  if (url.pathname.endsWith('/api/stop')) {
    stopPosts++;
    // A real Being ends the breath it was holding; without this the client waits
    // for the stream it just asked to stop.
    if (holdOpen) { holdOpen(); holdOpen = null; }
    return json({ ok: true });
  }
  if (url.pathname.endsWith('/api/chat/stream')) {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    sends.push(body);
    // The Being stores what it received, frame and all: `GET /api/history`
    // returning the framed text verbatim is what makes unframing on ingest the
    // client's job (main/chat/frame.ts's opening comment).
    history.push({ seq: seq++, role: 'user', content: body.message, at: new Date().toISOString(), scene_id: body.scene_id });
    const streamId = `fixture-${sends.length}`;
    active = { streamId, scene: body.scene_id };
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const event = (name, data) => response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    event('meta', { stream_id: streamId, client_ref: body.client_ref });
    const spoken = unwrap(body.message)?.body ?? body.message;
    try {
      if (spoken === SECOND) {
        // Held open so the stop button has something to stop. `/api/stop` ends it.
        event('content_block_delta', { delta: { text: '让我想想' } });
        await new Promise(resolve => {
          holdOpen = resolve;
          const timer = setTimeout(resolve, 20000);
          response.on('close', () => { clearTimeout(timer); resolve(); });
        });
        event('message_stop', {});
        return;
      }
      const reply = '我在。';
      // Slow enough that the streaming row is observable, short enough that the
      // script is not waiting on a clock.
      event('content_block_delta', { delta: { text: reply.slice(0, 1) } });
      await sleep(900);
      event('content_block_delta', { delta: { text: reply.slice(1) } });
      history.push({ seq: seq++, role: 'being', content: reply, at: new Date().toISOString(), scene_id: body.scene_id });
      event('message_stop', { session_id: 'fixture-session' });
    } finally {
      if (active?.streamId === streamId) active = null;
      response.end();
    }
    return;
  }
  json({ error: 'not found' }, 404);
});

// The reverse-MCP relay. Present so the tool bridge reaches its normal state;
// this script asserts nothing through it.
const wss = new WebSocketServer({ server, path: '/_relay' });
wss.on('connection', socket => {
  let ready = false;
  socket.on('message', data => {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (!ready) {
      socket.send(JSON.stringify({ ok: true, being_id: message.being_id, relay_keepalive: 'text-v1' }));
      ready = true;
      return;
    }
    if (message.type === 'keepalive') socket.send(JSON.stringify({ type: 'keepalive_ack' }));
  });
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const link = `http://127.0.0.1:${port}/willow/?token=${TOKEN}`;

let app = null;
let cleanupPromise;
function cleanup() {
  return cleanupPromise ??= (async () => {
    if (app) await app.close().catch(() => {});
    if (holdOpen) { holdOpen(); holdOpen = null; }
    for (const client of wss.clients) client.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  })();
}
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => { void cleanup().finally(() => process.exit(code)); });
}

const launch = () => launchDesktop({
  executablePath,
  env: { ...process.env, PORTAL_DESKTOP_USER_DATA: profile, PORTAL_DESKTOP_TEST_MOCK_KEYCHAIN: '1' },
});

try {
  // ── 1-2. the packaged client opens, unconnected ───────────────────────────
  app = await launch();
  let page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('#connect-button').waitFor();
  check('the packaged client opens on the welcome screen with no conversation',
    (await page.locator('.chat-native').count()) === 0);

  // ── 3. connect to the fixture through the real dialog ─────────────────────
  await page.locator('#connect-button').click();
  await page.locator('#settings-dialog').waitFor({ state: 'visible' });
  await page.locator('#connection-link').fill(link);
  await page.locator('#portal-name-input').fill('smoke-portal');
  await page.locator('#workspace-input').fill(path.join(dir, 'workspace'));
  // No engine is started: this script is about the conversation, and the
  // packaged stub Portal would only add a failure mode of its own.
  if (await page.locator('#background-input').isEnabled()) await page.locator('#background-input').uncheck();
  await page.locator('#autostart-input').uncheck();
  await page.locator('#save-settings').click();
  await page.waitForFunction(() => !document.querySelector('#settings-dialog')?.open, { timeout: 30000 });

  // ── 4. the sidebar opens one conversation ─────────────────────────────────
  await page.locator('.sidebar-task-row').first().waitFor();
  await page.locator('.chat-input').waitFor();
  check('connecting opens exactly one conversation in the sidebar',
    (await page.locator('.sidebar-task-row').count()) === 1);

  // ── 8. the baseline history read, before anything is said ─────────────────
  // The sidebar row exists before the timeline is reconciled (sessions.ts line
  // 225 runs before line 229), so the count is polled rather than sampled, then
  // given a moment to prove it does not climb with re-renders.
  await until('the timeline baseline read', () => historyReads >= 1);
  await sleep(1500);
  check('the timeline baseline is one GET /api/history, not one per render', historyReads === 1);

  // ── 5-6. one sentence, typed and sent ─────────────────────────────────────
  await page.locator('.chat-input').click();
  await page.locator('.chat-input').fill(FIRST);
  await page.locator('.chat-input').press('Enter');
  await page.locator('.chat-message.is-user').first().waitFor();
  check('the message appears as this person said it, unframed on screen',
    (await page.locator('.chat-message.is-user .chat-body').first().innerText()).trim() === FIRST);
  // The streaming row, while the fixture is still writing it.
  await page.locator('.chat-message.is-being.is-live').first().waitFor();
  check('the reply streams into a live row', true);
  await page.locator('.chat-message.is-being.is-live').first().waitFor({ state: 'detached' });

  // ── 7. what the Being received ────────────────────────────────────────────
  const body = sends[0];
  const framed = unwrap(body.message);
  // `desktop-<desktop uuid>-<session uuid>` (main/chat/store.ts `sessionFromScene`).
  const scene = /^desktop-([0-9a-f-]{36})-([0-9a-f-]{36})$/.exec(body.scene_id || '');
  check('the body carries the scene, its label and a correlation ref',
    scene !== null
    && typeof body.scene_meta?.scene_label === 'string' && body.scene_meta.scene_label.length > 0
    && typeof body.scene_meta?.client === 'string' && body.scene_meta.client.startsWith('being-desktop/')
    && typeof body.client_ref === 'string' && body.client_ref.startsWith('req-'));
  check('the message on the wire carries the v1 request context frame', framed !== null);
  check('the frame declares its length truthfully and the human words follow it',
    framed.body === FIRST && framed.context.length === framed.declared && framed.context === framed.context.trimEnd());
  check('the frame is the desktop message environment, naming this conversation',
    framed.context.startsWith('[Being Desktop 当前消息环境]\n')
    && framed.context.includes(`"chatSessionId":"${scene[2]}"`));
  check('direct mode says so, and carries no orchestrator paragraph',
    framed.context.includes('当前为直接执行模式') && !framed.context.includes('[Being Desktop Orchestrator mode]'));
  check('the credential never travels inside the frame',
    !body.message.includes(TOKEN) && !JSON.stringify(body).includes(TOKEN));

  // ── 9. stopping reaches the Being ─────────────────────────────────────────
  await page.locator('.chat-input').fill(SECOND);
  await page.locator('.chat-input').press('Enter');
  await page.locator('.chat-stop').waitFor({ state: 'visible' });
  const stopsBefore = stopPosts;
  await page.locator('.chat-stop').click();
  // The main process refuses to guess when the breath it would stop belongs to
  // another conversation; here it is this one's, so no confirmation is expected.
  await page.waitForFunction(() => !document.querySelector('.chat-stop') || document.querySelector('.chat-stop').hidden, { timeout: 30000 });
  check('stopping the reply reaches POST /api/stop exactly once', stopPosts === stopsBefore + 1);

  const beforeRestart = {
    title: await page.locator('.sidebar-task-row .session-title').first().innerText(),
    reads: historyReads,
  };
  check('nothing on the page threw', errors.length === 0);

  // ── 10. the conversation survives a restart ───────────────────────────────
  await app.close();
  app = null;
  app = await launch();
  page = await app.firstWindow();
  const restartErrors = [];
  page.on('pageerror', error => restartErrors.push(error.message));
  await page.locator('.chat-input').waitFor();
  await page.locator('.chat-message.is-user').first().waitFor();
  check('the conversation is still there after a restart',
    (await page.locator('.sidebar-task-row').count()) === 1
    && (await page.locator('.sidebar-task-row .session-title').first().innerText()) === beforeRestart.title);
  check('the words come back as the person said them, not as they went on the wire',
    (await page.locator('.chat-message.is-user .chat-body').first().innerText()).trim() === FIRST
    && !(await page.locator('.chat-stream').innerText()).includes('request context v1'));
  check('the Being\'s side of the exchange came back with it',
    (await page.locator('.chat-stream').innerText()).includes('我在。'));
  check('the restarted client reconciles against the Being once more',
    historyReads > beforeRestart.reads);
  check('nothing on the restarted page threw', restartErrors.length === 0);

  console.log(`PASS: ${checks.length} checks — packaged client, request context frame on the wire, unframed on disk, scene routing, one baseline read, stop, restart.`);
} catch (error) {
  if (app) {
    const failed = app.windows()[0];
    if (failed) console.error((await failed.locator('body').innerText().catch(() => '')).slice(-3000));
  }
  throw error;
} finally {
  await cleanup();
}
