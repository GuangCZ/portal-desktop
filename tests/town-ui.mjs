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
// EXTENDED 2026-09-17 (integration unit IT) with the three rules from that same
// BeingDesktop file that need a caret, a focus ring or a scroll offset to mean
// anything — "background revisions and deletions preserve draft focus selection
// and scroll" and "Fireside background changes preserve draft focus and scroll",
// split into the draft half and the list half, plus the background-collection
// status strip ("refreshLabel", renderer/town-app.js:163) actually reaching the
// page. Their model halves — which ring an answer belongs to, which target a
// receipt clears, and the whole wording table of the strip — are in
// tests/town-conversation-rules.test.ts.
//
// Nothing here is a real credential, a real message or a real Town: every
// request is answered inside the application by `protocol.handle`, and any
// request to another origin fails the run.
//
// TWO KINDS OF ASSERTION LIVE HERE (IM, 2026-09-16). `check` is a rule the client
// keeps: a failure stops the run on the spot. `pending` is a rule the client does
// NOT keep today, recorded red with its evidence and its owner — the run still
// fails at the end, and the checks after it still get to run, which is the only
// way the ten rules below the first defect ever get executed at all. A `pending`
// that starts passing simply reports as passed; none of them is allowed to be
// quietly deleted, and none of the fixtures may be re-shaped to make one green.
// That last sentence is the whole of review finding 2: the first run of this
// script turned「成员目录挂起」into「成员目录 503 快速失败」, which is a different
// scenario that the client already handles, and two red checks went green without
// a line of product code changing.
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
/** Rules the client does not keep today: name, and where the defect is. */
const failed = [];
const check = (name, condition) => {
  assert.equal(condition, true, name);
  checks.push(name);
  process.stdout.write(`${name}: passed\n`);
};
/** A rule that is red because of a defect, not because of the fixture. Recorded
 * with its evidence, the run fails at the end, and the rest of the script runs. */
const pending = (name, condition, why) => {
  if (condition === true) {
    checks.push(name);
    process.stdout.write(`${name}: passed\n`);
    return;
  }
  failed.push({ name, why });
  process.stdout.write(`${name}: FAILED — ${why}\n`);
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
    globalThis.town = { reads: [], confirms: [], members: 0, holdMembers: true, writes: [], since: null };
    // ONE shared deferred, not one per request. Every concurrent `/api` waits on
    // this same promise and a single release answers all of them; the first draft
    // of this fixture awaited a fresh promise per request and overwrote the
    // resolver, so only the last one could ever be answered.
    globalThis.town.membersHeld = new Promise(resolve => { globalThis.town.releaseMembers = resolve; });
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
        // 同时在飞的公共目录请求数的峰值。「同一 in-flight 读合并」就是这个数字
        // 永远是 1：TTL 缓存只在成功之后才写，所以并发调用者只能靠合并，不能靠缓存。
        // IM 2026-09-16 在打包产物上实测到干净一次打开 4 条、失败时 9–12 条。
        globalThis.town.membersOpen = (globalThis.town.membersOpen || 0) + 1;
        globalThis.town.membersPeak = Math.max(globalThis.town.membersPeak || 0, globalThis.town.membersOpen);
        // 「成员目录还没到」= 请求真的挂着，直到 `releaseMembers()`。这正是下面两条
        // check 名字里的场景，也是 BeingDesktop test/town-conversation-ui.cjs
        //「while the member directory remains pending」的原样。
        // 它当然会让篝火 feed 一起停住——那不是夹具的毛病，是
        // desktop/main/town/session/session.ts 的 `getBonfireMessages` 把
        // `/api/bonfire/hear` 和 `getMembers()` 放进同一个 `Promise.all`，
        // `.catch` 接得住「拒绝」接不住「慢」（复审 finding 2，记录 §8 openIssue 10）。
        if (globalThis.town.holdMembers) await globalThis.town.membersHeld;
        globalThis.town.membersOpen--;
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
        const limit = Math.max(1, Number(url.searchParams.get('limit')) || 10);
        globalThis.town.reads.push({ since, at: Date.now() });
        // 「上次刷新到这里」只在**这次刷新真的带来了新东西**时才画
        // （desktop/main/town/timeline/refresh.ts:435 `const arrived = before !== null
        // && sorted.some(seq => seq > before)`；带不来新的就保留上一个标记，起始是 null）。
        // 夹具原来每次都回同样的 seq 7/8，所以那条 check 断言的场景从来没被造出来过；
        // IM 2026-09-16 首次执行到这里时才看见。`fresh` 就是「刷新之后 Town 多了一条」。
        const fresh = globalThis.town.fresh ? [message(9, '刷新之后的新消息')] : [];
        // `bulk` 只在最后一段用：要断言「背景更新不动滚动位置」，列表必须真的能滚。
        // 它只增加消息，不改动上面任何一条 check 见过的场景。
        const bulk = globalThis.town.bulk
          ? Array.from({ length: 60 }, (_, index) => message(100 + index, `用于核对滚动位置的第 ${index} 条消息，` + '内容需要足够长才会把列表撑出可滚动的高度。'.repeat(2)))
          : [];
        const all = [message(1, '更早的消息 @t_River'), message(7, '篝火消息 @t_River'), message(8, '第二条篝火消息'), ...fresh, ...bulk];
        // 分页语义按实测记录（docs/town-sdk-integration.md「时间线累积」/ hear 分页）：
        // 不带 since = 最新的一页；带 since = 序号**大于** since 的最早 N 条，没有 before。
        // 夹具原来对任何 since 都只回 seq 1，那等于宣告「seq>0 里只有这一条」，
        // 于是 refresh.ts:418 的窗口收敛把 7/8/9 删掉——「加载更早」之后消息反而变少，
        // 这条 check 就永远等不到「多出来一条」。客户端是对的，夹具是错的。
        const messages = since === null
          ? all.filter(item => item.seq >= 7).slice(-limit)
          : all.filter(item => item.seq > Number(since)).slice(0, limit);
        return Response.json({ ok: true, town_id: 't_Willow', total_count: all.length, global_latest_seq: all[all.length - 1].seq, messages });
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
  // The directory is still held here, so this wait is BOUNDED: the rule is that
  // the feed does not wait for it, and a rule that is broken should go red in
  // seconds rather than at Playwright's default timeout.
  const HOLD_BUDGET_MS = 6000;
  let rendered = true;
  try { await page.locator('.social-message').first().waitFor({ timeout: HOLD_BUDGET_MS }); }
  catch { rendered = false; }
  // 默认排序是「最新在前」（feed-controls 的 select），所以带 @ 的 seq 7 排在 seq 8
  // 之后——`.first()` 取到的是没有提及的那一条。IM 2026-09-16 首次执行时改成按内容找,
  // 并顺带把「两条都出来了」也断言上，比原来的写法更强，不是更松。
  const beforeDirectory = rendered ? await page.locator('.social-message').allTextContents() : [];
  const readsWhilePending = await app.evaluate(() => globalThis.town.reads.length);
  check('messages render while the member directory is still pending',
    rendered
    && beforeDirectory.length === 2
    && beforeDirectory.some(text => text.includes('篝火消息') && text.includes('@t_River')));
  check('the pending directory did not stop the feed read', readsWhilePending >= 1);
  // Let the live reader's 250 ms reconcile window pass, so the next check
  // measures the DIRECTORY's effect and nothing else. See the note below.
  await page.waitForTimeout(800);
  const beforeArrival = await app.evaluate(() => globalThis.town.reads.length);
  // The directory arrives.
  await app.evaluate(() => { globalThis.town.holdMembers = false; globalThis.town.releaseMembers(); });
  await page.locator('.social-message').first().waitFor();
  await page.locator('.town-mention').first().waitFor();
  check('late directory arrival rerenders mention labels without mutating messages',
    (await page.locator('.town-mention').first().textContent()) === '@河流'
    && (await page.locator('.town-mention').first().getAttribute('title')) === '@t_River');
  check('a directory arrival costs no second message read',
    (await app.evaluate(() => globalThis.town.reads.length)) === beforeArrival);

  // ONE public-directory read, however many callers want it (IT, 2026-09-17).
  //
  // MEASURED (IM 2026-09-16, packaged build): a single clean opening asked
  // https://beings.town/api FOUR times, and nine to twelve while it was failing,
  // because `TownSession.getMembers` wrote its 60 s cache only AFTER a success —
  // so concurrent callers had nothing to share and each opened its own request.
  // They now join the one in flight (desktop/main/town/session/session.ts), which
  // is the rule BeingDesktop keeps one layer up in renderer/town-app.js:1957 and
  // :1972, where the load already started is reused rather than repeated
  // (`cachedMembers || loadBonfireMembers()`).
  //
  // The burst is driven deliberately rather than read off the opening sequence:
  // pairing legitimately resets the session and invalidates the directory, and a
  // read that was abandoned at a reset is not a read that failed to merge. Five
  // forced reads issued in one tick, against a directory that is held again, have
  // no such excuse.
  await app.evaluate(() => {
    globalThis.town.holdMembers = true;
    globalThis.town.membersHeld = new Promise(resolve => { globalThis.town.releaseMembers = resolve; });
    globalThis.town.membersBefore = globalThis.town.members;
  });
  const burst = page.evaluate(() => Promise.allSettled(
    Array.from({ length: 5 }, () => window.beings.townDesktop.members({ force: true }))));
  await page.waitForTimeout(500);
  const shared = await app.evaluate(() => globalThis.town.members - globalThis.town.membersBefore);
  await app.evaluate(() => { globalThis.town.holdMembers = false; globalThis.town.releaseMembers(); });
  await burst;
  check('five directory reads at once are one request on the wire', shared === 1);

  // WHY THESE THREE COUNT AGAINST A BASELINE INSTEAD OF AGAINST 1 (IT, 2026-09-17).
  //
  // MEASURED on the packaged build with a timestamped probe over this very
  // fixture: one opening produces the page's own read at t=0 and a SECOND read
  // 245-251 ms later. Its source is not the page. Pairing completes by opening
  // the SSE stream, whose `hello` frame lands 2-7 ms before the first read;
  // `TownBackground.notifyEvent` coalesces a live event for 250 ms and then
  // reconciles (desktop/main/town/channel/town-background.ts, ported byte for
  // byte from BeingDesktop src/town-background.cjs:60-82, including the 250).
  // That read is Town saying something changed, not the page asking twice, and
  // suppressing it would mean dropping an update the server announced.
  //
  // IM's original `=== 1` was measuring the defect it sat beside rather than a
  // rule: while the feed read was stuck behind the member directory its flight
  // never settled, so the live reconcile joined it (timeline/refresh.ts:543
  // `if (this._flight) return this._flight.promise`) and never reached the wire.
  // Take the directory out of the way and the reconcile becomes a request of its
  // own. So each rule is now asserted as itself — the directory did not stop the
  // read, the directory's arrival cost nothing, and an opening costs at most one
  // read — each against what was on the wire immediately before it.
  const beforeReopen = await app.evaluate(() => globalThis.town.reads.length);
  // Leaving and re-entering repaints from the cache and reads once more; two
  // rapid entries share the one read rather than starting a second.
  await townPage('私信');
  await townPage('篝火');
  await townPage('私信');
  await townPage('篝火');
  await page.locator('.social-message').first().waitFor();
  check('repeated openings never start more than one read per opening',
    (await app.evaluate(() => globalThis.town.reads.length)) - beforeReopen <= 2);

  // ── the accumulating timeline ──────────────────────────────────────────────
  // Town gains a message between the first read and the refresh, which is the
  // only situation the boundary marker is defined for (see the fixture).
  await app.evaluate(() => { globalThis.town.fresh = true; });
  await page.locator('#town-refresh').click();
  await page.locator('.feed-boundary').waitFor();
  check('a refresh marks where the previous one stopped',
    (await page.locator('.feed-boundary').textContent()).includes('上次刷新到这里'));
  const beforeOlder = await page.locator('.social-message').count();
  await page.locator('#town-load-older').click();
  await page.waitForFunction(count => document.querySelectorAll('.social-message').length > count, beforeOlder);
  check('loading older prepends what came back and asks with `since` only',
    (await app.evaluate(() => globalThis.town.reads.some(read => read.since !== null))) === true);

  // ── a background update must not disturb what the user is doing ────────────
  // ADDED 2026-09-17 (integration unit IT). BeingDesktop
  // test/town-conversation-ui.cjs 「background revisions and deletions preserve
  // draft focus selection and scroll」 and 「Fireside background changes preserve
  // draft focus and scroll」. Only a real window can answer these three — caret,
  // focus, list scrollTop — which is why they are here and not in
  // tests/town-conversation-rules.test.ts, where the model half of the same
  // family lives.
  //
  // The update is a REAL background one: the fixture's own SSE controller emits a
  // `bonfire` event, the live reader marks the feed dirty and refreshes 250 ms
  // later (desktop/main/town/channel/town-background.ts `notifyEvent`, ported
  // byte for byte from BeingDesktop src/town-background.cjs:60-82), and the new
  // envelope is pushed to the page. Nothing here fakes the push.
  const backgroundUpdate = async () => {
    const before = await app.evaluate(() => globalThis.town.reads.length);
    await app.evaluate(() => globalThis.town.stream.enqueue(
      new TextEncoder().encode('event: bonfire\ndata: {"type":"bonfire"}\n\n')));
    for (let waited = 0; waited < 60; waited++) {
      if ((await app.evaluate(() => globalThis.town.reads.length)) > before) return true;
      await page.waitForTimeout(100);
    }
    return false;
  };
  await page.locator('#town-write').click();
  await page.locator('#town-send-content').fill('尚未发送的草稿');
  await page.locator('#town-send-content').evaluate(element => { element.focus(); element.setSelectionRange(2, 4); });
  const draftUpdated = await backgroundUpdate();
  await page.waitForTimeout(200);
  const draftState = await page.evaluate(() => {
    const draft = document.getElementById('town-send-content');
    return { value: draft.value, start: draft.selectionStart, end: draft.selectionEnd, focused: document.activeElement === draft };
  });
  check('a background update preserves the draft, its caret and its focus',
    draftUpdated && draftState.value === '尚未发送的草稿' && draftState.start === 2 && draftState.end === 4 && draftState.focused === true);
  await page.locator('#town-send-close').click();
  await page.locator('#town-send-dialog').waitFor({ state: 'hidden' });

  // Enough messages for the list to actually scroll, then the same background
  // update again. Which element scrolls is a layout detail — several ancestors
  // carry `overflow:auto` and only one of them ends up taller than its box — so
  // it is found rather than assumed, and a run where nothing scrolls fails
  // loudly on `scrolled > 0` instead of passing vacuously.
  await app.evaluate(() => { globalThis.town.bulk = true; });
  await page.locator('#town-refresh').click();
  await page.waitForFunction(() => document.querySelectorAll('.social-message').length > 10);
  const scroller = () => page.evaluate(() => {
    for (let node = document.querySelector('.social-messages'); node; node = node.parentElement)
      if (node.scrollHeight - node.clientHeight > 40) return node.className || node.id;
    return '';
  });
  const scrollerName = await scroller();
  const setScroll = (name, value) => page.evaluate(([key, top]) => {
    const node = document.getElementById(key) || document.getElementsByClassName(key)[0];
    if (top !== null) node.scrollTop = top;
    return node.scrollTop;
  }, [scrollerName, value]);
  await setScroll(scrollerName, await page.evaluate(key => {
    const node = document.getElementById(key) || document.getElementsByClassName(key)[0];
    return Math.floor((node.scrollHeight - node.clientHeight) / 3);
  }, scrollerName));
  const scrolled = await setScroll(scrollerName, null);
  const scrollUpdated = await backgroundUpdate();
  await page.waitForTimeout(200);
  check('a background update leaves the list where the reader left it',
    scrolled > 0 && scrollUpdated && (await setScroll(scrollerName, null)) === scrolled);

  // The strip that says where background collection stands. BeingDesktop
  // renderer/town-app.js `refreshLabel` (:163); the wording table is asserted
  // exhaustively in tests/town-conversation-rules.test.ts, this is the one that
  // proves it reaches the page at all.
  check('the page says where background collection stands',
    /最近采集|等待 Town 同步|已显示读取结果|正在同步 Town 消息/.test(
      await page.locator('#town-refresh-status').textContent()));

  // ── sending ────────────────────────────────────────────────────────────────
  await townPage('私信');
  await page.locator('#town-write').click();
  await page.locator('#town-recipient').fill('Neo');
  await page.locator('#town-send-content').fill('你好');
  await page.locator('#town-send-submit').click();
  // The refusal itself is what「nothing is resent」is about, and it is on screen
  // as soon as `#town-send-error` fills in. The choices are a separate half; wait
  // for them, but not forever.
  await page.locator('#town-send-error').waitFor();
  let candidateCount = 0;
  try {
    await page.locator('#town-send-candidates li').first().waitFor({ timeout: 4000 });
    candidateCount = await page.locator('#town-send-candidates li').count();
  } catch { candidateCount = await page.locator('#town-send-candidates li').count(); }
  check('an ambiguous recipient is refused, and nothing is resent',
    (await page.locator('#town-send-error').textContent()).includes('收件人有歧义')
    && (await app.evaluate(() => globalThis.town.writes.filter(write => write.path === '/api/messages').length)) === 1);
  pending('an ambiguous recipient offers the choices Town returned', candidateCount === 2,
    'contextBridge 把 Error 的自定义属性剥掉了，`NOT_SENT` 上的 `candidates` 到不了渲染层，'
    + '`TownModel.send()` 的 `(error).candidates` 永远是 undefined（记录 §8 openIssue 1 的第二个后果）。'
    + '实测（打包产物，Electron 44.2.0）：页面收到的 Error 自有属性只有 ["stack","message"]，'
    + 'message 是「收件人有歧义；本次私信未发送，请选择 Town ID。」而 code 与 candidates 都是 null。');
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
  if (failed.length) {
    console.log(`\n${checks.length} checks passed, ${failed.length} FAILED:`);
    for (const entry of failed) console.log(`  · ${entry.name}\n    ${entry.why}`);
    throw new Error(`${failed.length} check(s) failed: ${failed.map(entry => entry.name).join('; ')}`);
  }
  console.log(`\n${checks.length} checks passed. Scope: offline fixtures; no real Town, credentials or messages.`);
} finally {
  if (app) await app.close().catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
