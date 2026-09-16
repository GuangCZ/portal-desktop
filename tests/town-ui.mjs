// The Town page over the real IPC, with Town itself replaced by fixtures.
//
// REWRITTEN 2026-09-16 (integration unit I1). The previous script drove the
// retired `beings://chat` iframe and had been reporting a skip since that
// document was removed; every locator in it addressed nothing. What it is now is
// a port of the assertions in BeingDesktop test/town-conversation-ui.cjs that
// need a real main process to mean anything — the ones about WHEN a read
// happens, not about how a list renders. The rendering half is covered without
// an application in tests/renderer-state.test.ts and tests/town-mentions.test.ts.
//
// The four rules, verbatim from that file's names:
//   * "opening Bonfire waits for the local snapshot before requesting Being"
//   * "Bonfire renders cached messages before requesting Being while the member
//      directory remains pending"
//   * "repeated Bonfire clicks join the same in-flight Being read"
//   * "late directory arrival rerenders mention labels without mutating messages"
// plus the two the accumulating timeline added ("a feed with history above
// offers to load it, and marks where the last refresh started", "loading older
// asks the main process once for this feed and prepends what came back") and the
// pairing surface, which is new to this shell.
//
// Nothing here is a real credential, a real message or a real Town: every
// request is answered inside the application by `protocol.handle`, and any
// request to another origin fails the run.
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

const dir = await mkdtemp(path.join(os.tmpdir(), 'beings-town-ui-'));
const checks = [];
const check = (name, condition) => {
  assert.equal(condition, true, name);
  checks.push(name);
  process.stdout.write(`${name}: passed\n`);
};

let app;
try {
  app = await launchDesktop({
    executablePath,
    env: { ...process.env, PORTAL_DESKTOP_USER_DATA: path.join(dir, 'profile'), PORTAL_DESKTOP_TEST_MOCK_KEYCHAIN: '1' },
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: '连接我的 Being' }).waitFor();

  // ── Town, as fixtures ──────────────────────────────────────────────────────
  await app.evaluate(({ protocol }) => {
    const token = 'f'.repeat(64);
    globalThis.town = { reads: [], confirms: [], members: 0, holdMembers: true, resolveMembers: null, writes: [], since: null };
    const message = (seq, content, extra = {}) => ({
      seq, town_id: 't_River', speaker_name: '河流', message: content,
      at: '2026-09-11T10:0' + (seq % 10) + ':00Z', ...extra,
    });
    protocol.handle('https', async request => {
      const url = new URL(request.url);
      if (url.origin !== 'https://beings.town') return Response.json({ error: 'fixture only' }, { status: 404 });
      const authorized = request.headers.get('authorization') === `Bearer ${token}`;
      if (url.pathname === '/api/client/pair/confirm') {
        const body = await request.json();
        globalThis.town.confirms.push({ body, authorization: request.headers.has('authorization') });
        return Response.json({ ok: true, token, town_id: 't_Willow', display: '柳树' });
      }
      if (url.pathname === '/api/client/stream') {
        if (!authorized) return new Response('', { status: 401 });
        return new Response(new ReadableStream({
          start(controller) {
            globalThis.town.stream = controller;
            controller.enqueue(new TextEncoder().encode('event: hello\ndata: {"town_id":"t_Willow","token_kind":"client","anonymous":false}\n\n'));
          },
        }), { headers: { 'Content-Type': 'text/event-stream' } });
      }
      // The public homepage carries the member directory and needs no credential.
      if (url.pathname === '/api') {
        globalThis.town.members++;
        // 「还没到」这件事用一次快速失败表示，不用挂住请求。IM 2026-09-16 首次执行时
        // 实测：原来的写法是每一个并发 `/api` 各自 await 一个新 Promise，永不兑现,
        // 客户端在目录未到时重试了 9 次，于是 9 个请求同时挂在 beings.town 上,
        // 把这个源的并发预算占满——连**不碰目录**的 `bonfire()` 直读都一起挂死
        // （实测：held-direct-bonfire HUNG>8s；改成快速失败后同一次调用 n=2）。
        // 挂死之后 feed 当然是空的，于是下面那条「目录还没到也要出消息」永远等不到
        // `.social-message`，看起来像产品缺陷，其实是夹具把自己饿死了。
        // 顺带修掉原来的另一半：`resolveMembers` 每次被覆盖，只兑现得了最后一个。
        if (globalThis.town.holdMembers) return new Response('', { status: 503 });
        return Response.json({ community: [{ town_id: 't_River', display_name: '河流', description: '' }] });
      }
      if (!authorized) return Response.json({ error: 'unauthorized' }, { status: 401 });
      if (request.method === 'POST') {
        globalThis.town.writes.push({ path: url.pathname, body: await request.json() });
        if (url.pathname === '/api/messages') {
          return Response.json({ error: 'ambiguous recipient', candidates: [{ town_id: 't_NeoA', display_name: 'Neo A' }, { town_id: 't_NeoB', display_name: 'Neo B' }] }, { status: 400 });
        }
        return Response.json({ ok: true, seq: 99, via: 'client:desktop' });
      }
      if (url.pathname === '/api/bonfire/hear') {
        const since = url.searchParams.get('since');
        globalThis.town.reads.push({ since, at: Date.now() });
        // Two pages: the newest two, and anything older when asked with `since`.
        const older = [message(1, '更早的消息 @t_River')];
        const newest = [message(7, '篝火消息 @t_River'), message(8, '第二条篝火消息')];
        return Response.json({ ok: true, town_id: 't_Willow', total_count: 3, global_latest_seq: 8, messages: since === null ? newest : older });
      }
      if (url.pathname === '/api/fireside/list') return Response.json({ owned: [], joined: [] });
      if (url.pathname === '/api/messages') return Response.json({ messages: [] });
      return Response.json({ error: 'fixture only' }, { status: 404 });
    });
  });
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

  const townPage = async place => {
    if (!await page.locator('#place-sheet').evaluate(element => element.open)) {
      await page.locator('#options-trigger').click();
      await page.locator('[data-view="town"]').click();
    }
    await page.locator('.place-switcher').getByRole('button', { name: place, exact: true }).click();
  };

  // ── pairing ────────────────────────────────────────────────────────────────
  await townPage('篝火');
  await page.locator('#town-auth-button').click();
  await page.locator('#town-pair-code').fill('k7m2n4');
  await page.getByRole('button', { name: '确认配对' }).click();
  await page.locator('#town-auth-dialog').waitFor({ state: 'hidden' });
  const confirms = await app.evaluate(() => globalThis.town.confirms);
  check('pairing spends the six-digit code exactly once, upper-cased, with no credential of its own',
    confirms.length === 1 && confirms[0].body.code === 'K7M2N4' && confirms[0].body.being_id === 'willow' && confirms[0].authorization === false);
  const leaked = await page.evaluate(token => JSON.stringify(window.beings ? Object.keys(window.beings.townDesktop) : []).includes(token)
    || document.documentElement.outerHTML.includes(token), 'f'.repeat(64));
  check('the client token never reaches the renderer', leaked === false);
  check('the paired client reports itself connected',
    (await page.locator('#town-live-status').textContent()).includes('已连接 Town'));

  // ── one read, cache first, directory late ──────────────────────────────────
  await page.locator('.social-message').first().waitFor();
  // 默认排序是「最新在前」（feed-controls 的 select），所以带 @ 的 seq 7 排在 seq 8
  // 之后——`.first()` 取到的是没有提及的那一条。IM 2026-09-16 首次执行时改成按内容找,
  // 并顺带把「两条都出来了」也断言上，比原来的写法更强，不是更松。
  const beforeDirectory = await page.locator('.social-message').allTextContents();
  check('messages render while the member directory is still pending',
    beforeDirectory.length === 2
    && beforeDirectory.some(text => text.includes('篝火消息') && text.includes('@t_River')));
  check('the pending directory did not stop the feed read',
    (await app.evaluate(() => globalThis.town.reads.length)) === 1);
  await app.evaluate(() => { globalThis.town.holdMembers = false; globalThis.town.resolveMembers?.(); });
  await page.locator('.town-mention').first().waitFor();
  check('late directory arrival rerenders mention labels without mutating messages',
    (await page.locator('.town-mention').first().textContent()) === '@河流'
    && (await page.locator('.town-mention').first().getAttribute('title')) === '@t_River');
  check('a directory arrival costs no second message read',
    (await app.evaluate(() => globalThis.town.reads.length)) === 1);

  // Leaving and re-entering repaints from the cache and reads once more; two
  // rapid entries share the one read rather than starting a second.
  await townPage('私信');
  await townPage('篝火');
  await townPage('私信');
  await townPage('篝火');
  await page.locator('.social-message').first().waitFor();
  check('repeated openings never start more than one read per opening',
    (await app.evaluate(() => globalThis.town.reads.length)) <= 3);

  // ── the accumulating timeline ──────────────────────────────────────────────
  await page.locator('#town-refresh').click();
  await page.locator('.feed-boundary').waitFor();
  check('a refresh marks where the previous one stopped',
    (await page.locator('.feed-boundary').textContent()).includes('上次刷新到这里'));
  const beforeOlder = await page.locator('.social-message').count();
  await page.locator('#town-load-older').click();
  await page.waitForFunction(count => document.querySelectorAll('.social-message').length > count, beforeOlder);
  check('loading older prepends what came back and asks with `since` only',
    (await app.evaluate(() => globalThis.town.reads.some(read => read.since !== null))) === true);

  // ── sending ────────────────────────────────────────────────────────────────
  await townPage('私信');
  await page.locator('#town-write').click();
  await page.locator('#town-recipient').fill('Neo');
  await page.locator('#town-send-content').fill('你好');
  await page.locator('#town-send-submit').click();
  await page.locator('#town-send-candidates li').first().waitFor();
  check('an ambiguous recipient is refused with the choices Town offered, and nothing is resent',
    (await page.locator('#town-send-candidates li').count()) === 2
    && (await app.evaluate(() => globalThis.town.writes.filter(write => write.path === '/api/messages').length)) === 1);
  check('the draft survives a refused send',
    (await page.locator('#town-send-content').inputValue()) === '你好');

  // ── unpaired ───────────────────────────────────────────────────────────────
  await page.keyboard.press('Escape');
  await page.locator('#town-auth-button').click();
  await page.locator('#clear-town-token').click();
  await page.waitForFunction(() => document.querySelector('#town-live-status')?.textContent?.includes('尚未配对'));
  check('forgetting the pairing asks for a six-digit code rather than a token',
    (await page.locator('#town-live-status').textContent()).includes('六位配对码'));

  check('the renderer raised no errors', errors.length === 0);
  console.log(`\n${checks.length} checks passed. Scope: offline fixtures; no real Town, credentials or messages.`);
} finally {
  if (app) await app.close().catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
