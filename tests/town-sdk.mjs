// The Town SDK contract, as the packaged client speaks it.
//
// REWRITTEN 2026-09-16 (integration unit I1). The previous script drove the
// retired `beings://chat` iframe and had been reporting a skip since that
// document was removed. Its subject survives unchanged: what goes on the wire
// when this client pairs, reads and speaks, asserted against the packaged
// application rather than against a module in isolation.
//
// The difference from tests/town-ui.mjs is the direction of the assertion. That
// script asks what the page does; this one asks what Town receives — the confirm
// body, the Authorization header, the absence of a token in any URL, the three
// speak bodies, and which error code reaches the renderer when a read is refused.
// Unit coverage of the same rules against the module is in
// tests/town-session-client.test.ts; this is the packaged path, including the
// preload envelope that carries a `code` across IPC.
//
// FIRST EXECUTED 2026-09-16 by integration unit IM. Three things this script
// had never been able to learn about itself came out of that run; two were its
// own and are fixed above and below (the speak receipt it answered with, and the
// key order it demanded). The third is not this script's and is left failing on
// purpose: the four checks that read `error.code` cannot pass today, because
// `contextBridge` drops every custom property of a thrown Error before it
// reaches the renderer. Measured on this exact Electron (44.2.0), with a
// standalone two-file fixture: a preload that rejects with
// `Object.assign(new Error(m), {code})` arrives in the page as an Error whose
// own properties are `["stack","message"]` — while the same value passed as a
// plain object keeps its `code`. So `preload/channels/{bridge,town}.ts` rebuild
// the Error on the wrong side of the bridge, and the codes die there.
// BeingDesktop 0.8.26 has the same shape and the same hole (src/preload.cjs
// lines 60-76, whose own comment says「Electron strips custom Error fields」);
// its renderer/town-app.js lines 308 and 1027 branch on codes that never arrive.
// This is therefore inherited, not introduced by the port — and it is not this
// unit's to fix, because the repair changes what every Town and conversation
// call site receives. See docs/migration/im-integration.md §4.4.
//
// HOW THAT IS RECORDED (IM, 2026-09-16, after review finding 2). `check` is a
// rule the client keeps and stops the run when it does not. `pending` is a rule
// the client does NOT keep today: it is printed red with its evidence, the run
// still fails at the end, and the checks after it still get to run — which is the
// only reason the nine rules below the first of the four are executed at all.
// The four assertions themselves are untouched; what each of them used to test
// TOGETHER with a code has been split, so the half that does hold (the call was
// refused, Town was not asked, nothing was sent) stays a hard check.
//
// SDK contract fixtures only: no real Town pairing, messages or credentials.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
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

const TOKEN = 'e'.repeat(64);
const dir = await mkdtemp(path.join(os.tmpdir(), 'town-sdk-'));
const checks = [];
/** Rules the client does not keep today: name, and where the defect is. */
const failed = [];
const check = (name, condition) => {
  assert.equal(condition, true, name);
  checks.push(name);
  process.stdout.write(`${name}: passed\n`);
};
/** A rule that is red because of a defect, not because of the fixture. */
const pending = (name, condition, why) => {
  if (condition === true) {
    checks.push(name);
    process.stdout.write(`${name}: passed\n`);
    return;
  }
  failed.push({ name, why });
  process.stdout.write(`${name}: FAILED — ${why}\n`);
};
const STRIPPED = 'contextBridge 剥掉了 Error 的自定义属性，`code` 到不了渲染层'
  + '（实测 Electron 44.2.0：页面收到的 Error 自有属性只有 ["stack","message"]；'
  + '同一个值当普通对象返回时 code 原样到达）。preload/channels/{bridge,town}.ts '
  + '把包络还原成 Error 的位置在 contextBridge 的错误一侧；0.8.26 src/preload.cjs:60-76 同病。'
  + '记录 §4.4 / openIssue 1。';

/** Compare bodies by field and value, not by key insertion order: a JSON object
 * has no ordering on the wire, and `town-client.cjs` line 298 builds a fireside
 * body as `{message, fireside_id}` while docs/interfaces.md lists the fields the
 * other way round. Asserting `JSON.stringify` equality made this script demand
 * an order neither Town nor the client promises (IM, 2026-09-16: first run). The
 * field set and every value are still asserted exactly. */
const canonical = value => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
    : item);

let app;
try {
  app = await launchDesktop({
    executablePath,
    env: { ...process.env, PORTAL_DESKTOP_USER_DATA: dir, PORTAL_DESKTOP_TEST_MOCK_KEYCHAIN: '1' },
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: '连接我的 Being' }).waitFor();

  await app.evaluate(({ protocol }, token) => {
    globalThis.sdk = { calls: [], writes: [], confirms: 0, paired: true };
    const message = (seq, content, via) => ({ seq, town_id: 't_River', speaker_name: '河流', message: content, at: '2026-09-11T10:00:00Z', via });
    protocol.handle('https', async request => {
      const url = new URL(request.url);
      if (url.origin !== 'https://beings.town') return Response.json({ error: 'fixture only' }, { status: 404 });
      const headers = Object.fromEntries(request.headers);
      globalThis.sdk.calls.push({
        path: url.pathname, search: url.search, method: request.method,
        authorization: headers.authorization || '', referer: headers.referer || '', cookie: headers.cookie || '',
      });
      if (url.pathname === '/api/client/pair/confirm') {
        globalThis.sdk.confirms++;
        const body = await request.json();
        globalThis.sdk.confirmBody = body;
        return Response.json({ ok: true, token, town_id: 't_Willow', display: '柳树' });
      }
      if (url.pathname === '/api/client/stream') {
        if (headers.authorization !== `Bearer ${token}`) return new Response('', { status: 401 });
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('event: hello\ndata: {"town_id":"t_Willow","token_kind":"client","anonymous":false}\n\n'));
          },
        }), { headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (url.pathname === '/api') return Response.json({ community: [{ town_id: 't_River', display_name: '河流', description: '' }] });
      if (!globalThis.sdk.paired || headers.authorization !== `Bearer ${token}`) return Response.json({ error: 'unauthorized' }, { status: 401 });
      if (request.method === 'POST') {
        globalThis.sdk.writes.push({ path: url.pathname, body: await request.json() });
        // A speak receipt has to carry the identity Town wrote under and, for a
        // direct message, `message_id` — `town-client.cjs` line 301/326 reads
        // exactly these, and its port does too (session/client.ts:458/485).
        // Answering without them is not「Town said yes」but RESULT_UNKNOWN, which
        // is what this fixture used to produce (IM, 2026-09-16: first execution).
        return Response.json({ ok: true, seq: 12, message_id: 'sent-1', town_id: 't_Willow', via: 'client:desktop' });
      }
      if (url.pathname === '/api/bonfire/hear') {
        return Response.json({ ok: true, town_id: 't_Willow', global_latest_seq: 4, messages: [
          message(1, 'Being 本体消息', 'being'),
          message(2, '伙伴代发消息', 'client:my-phone'),
          message(3, '旧消息缺少来源', null),
          message(4, '来源按纯文本展示', 'client:<img src=x onerror=alert(1)>'),
        ] });
      }
      if (url.pathname === '/api/fireside/list') return Response.json({ owned: [{ id: 10, name: '测试围炉' }], joined: [] });
      if (url.pathname === '/api/fireside/hear') return Response.json({ ok: true, messages: [message(2, '围炉消息', 'being')] });
      if (url.pathname === '/api/messages') return Response.json({ messages: [] });
      return Response.json({ error: 'fixture only' }, { status: 404 });
    });
  }, TOKEN);
  await app.evaluate(({ protocol }) => {
    protocol.handle('http', async request => {
      const url = new URL(request.url);
      if (url.host !== '127.0.0.1:1') return Response.json({ error: 'fixture only' }, { status: 404 });
      if (url.pathname.endsWith('/api/stream/active')) return new Response(null, { status: 204 });
      return Response.json({ being_name: 'willow', messages: [], status: 'ok' });
    });
  });
  await page.evaluate(async workspace => {
    const { settings } = await window.beings.snapshot();
    await window.beings.save({ ...settings, connectionLink: 'http://127.0.0.1:1/willow/?token=local-ui-fixture', workspace, backgroundEnabled: false, autoStart: false });
  }, dir);
  await page.waitForFunction(async () => (await window.beings.townDesktop.appState()).identity.loomBeingId === 'willow');

  // ── the catalogue reaches the renderer as a code, not a sentence ───────────
  const unpaired = await page.evaluate(() => window.beings.townDesktop.bonfire()
    .then(() => null, error => ({ code: error.code ?? null, message: String(error.message || '') })));
  check('an unpaired read is refused rather than answered', unpaired !== null && unpaired.message.length > 0);
  pending('an unpaired read rejects with AUTH_REQUIRED rather than a sentence', unpaired?.code === 'AUTH_REQUIRED', STRIPPED);
  const invalid = await page.evaluate(() => window.beings.townDesktop.pair({ code: 'ABC' })
    .then(() => null, error => ({ code: error.code ?? null, message: String(error.message || '') })));
  check('a code that cannot be valid never reaches Town', invalid !== null
    && (await app.evaluate(() => globalThis.sdk.confirms)) === 0);
  pending('…and says so as INVALID_REQUEST', invalid?.code === 'INVALID_REQUEST', STRIPPED);

  // ── pairing ────────────────────────────────────────────────────────────────
  const state = await page.evaluate(() => window.beings.townDesktop.pair({ code: 'ab3xy9' }));
  check('the confirm body names the bound identity and the upper-cased code',
    (await app.evaluate(() => globalThis.sdk.confirmBody)).code === 'AB3XY9'
    && (await app.evaluate(() => globalThis.sdk.confirmBody)).being_id === 'willow');
  check('the confirm exchange carries no credential of its own',
    (await app.evaluate(() => globalThis.sdk.calls.find(call => call.path === '/api/client/pair/confirm').authorization)) === '');
  check('the paired state that crosses IPC has no token in it',
    state.paired === true && state.townId === 't_Willow' && !JSON.stringify(state).includes(TOKEN));

  // ── reads ──────────────────────────────────────────────────────────────────
  const bonfire = await page.evaluate(() => window.beings.townDesktop.bonfire({ limit: 10 }));
  check('a direct read returns the validated DTO, not the upstream body',
    bonfire.messages.length === 4 && bonfire.messages[0].content === 'Being 本体消息'
    && bonfire.messages[0].beingName === '河流' && bonfire.messages[0].townId === 't_River');
  check('client provenance survives and is carried as plain text',
    bonfire.messages[1].via === 'client:my-phone' && bonfire.messages[3].via.includes('<img') && !('__html' in bonfire.messages[3]));
  const reads = await app.evaluate(() => globalThis.sdk.calls.filter(call => call.path.endsWith('/hear') || call.path === '/api/messages'));
  check('every authenticated read uses the client bearer, never a URL token or a cookie',
    reads.length > 0 && reads.every(call => call.authorization === `Bearer ${TOKEN}` && !call.search.includes('token') && call.cookie === '' && call.referer === ''));

  // ── writes ─────────────────────────────────────────────────────────────────
  const revision = (await page.evaluate(() => window.beings.townDesktop.appState())).identity.connectionRevision;
  await page.evaluate(connectionRevision => window.beings.townDesktop.speak({ kind: 'bonfire', content: '篝火', connectionRevision }), revision);
  await page.evaluate(connectionRevision => window.beings.townDesktop.speak({ kind: 'fireside', firesideId: '10', content: '围炉', connectionRevision }), revision);
  await page.evaluate(connectionRevision => window.beings.townDesktop.speak({ kind: 'dm', recipient: 't_River', content: '私信', connectionRevision }), revision);
  const writes = await app.evaluate(() => globalThis.sdk.writes);
  check('the three speak bodies are the documented ones', canonical(writes) === canonical([
    { path: '/api/bonfire/speak', body: { message: '篝火' } },
    { path: '/api/fireside/speak', body: { fireside_id: 10, message: '围炉' } },
    { path: '/api/messages', body: { recipient: 't_River', content: '私信' } },
  ]));
  const stale = await page.evaluate(connectionRevision => window.beings.townDesktop
    .speak({ kind: 'bonfire', content: '旧连接', connectionRevision })
    .then(() => null, error => ({ code: error.code ?? null, message: String(error.message || '') })), revision + 1);
  check('a send composed under a previous connection is refused before it is sent',
    stale !== null && stale.message.includes('连接已变化')
    && (await app.evaluate(() => globalThis.sdk.writes.length)) === 3);
  pending('…and says so as SESSION_CHANGED', stale?.code === 'SESSION_CHANGED', STRIPPED);

  // ── forgetting ─────────────────────────────────────────────────────────────
  const forgotten = await page.evaluate(() => window.beings.townDesktop.forget());
  check('forgetting leaves the client unpaired without asking Town for anything',
    forgotten.paired === false && forgotten.status === 'unpaired');
  const after = await page.evaluate(() => window.beings.townDesktop.inbox()
    .then(() => null, error => ({ code: error.code ?? null, message: String(error.message || '') })));
  // The same refusal as before pairing, word for word: forgetting really does put
  // the client back where it started, and this half needs no code to say so.
  check('and the next read asks for a pairing again', after !== null && after.message === unpaired.message);
  pending('…as AUTH_REQUIRED', after?.code === 'AUTH_REQUIRED', STRIPPED);

  check('the renderer raised no errors', errors.length === 0);
  if (failed.length) {
    console.log(`\n${checks.length} checks passed, ${failed.length} FAILED:`);
    for (const entry of failed) console.log(`  · ${entry.name}\n    ${entry.why}`);
    throw new Error(`${failed.length} check(s) failed: ${failed.map(entry => entry.name).join('; ')}`);
  }
  console.log(`\n${checks.length} checks passed. Scope: SDK contract fixtures; no real Town pairing, messages or credentials.`);
} finally {
  if (app) await app.close().catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
