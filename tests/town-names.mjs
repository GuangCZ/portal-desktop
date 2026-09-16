// Real React components with local fixtures; no Town requests or credentials.
//
// REWRITTEN 2026-09-16 with the rest of the Town layer (docs/migration/i1-town.md).
// The subject did not change — who a message says it is from, who a reply is
// addressed to, and that neither is ever a raw Town ID on screen — but the inputs
// did: the page no longer parses Town envelopes, it renders the validated DTOs
// (`senderId`/`senderName`/`recipientId`) the main process hands it, and names
// come from the member directory rather than out of the messages.
//
// The `/places` route used to mount `ChatPlaces` — the town-shortcut row of the
// Loom composer — which went with the `beings://chat` document on 2026-09-16.
// The native composer has no such row yet, so that coverage is gone rather than
// repointed; see MIGRATION.md, "P1 完成状态".
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// The mention body lives out here so the fixture source below never has to
// escape a backtick inside its own template literal.
const body = JSON.stringify('正文 @t_RiverA 和 **@t_RiverB**，未知 @t_Unknown。\n\n代码：`@t_RiverA`\n\n[@t_RiverB](https://example.com/@t_RiverB)');

const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), sourcefile: 'town-names-fixture.tsx', loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client';
    import { TownFeed } from './desktop/renderer/town/components/feed';
    import { TownComposer } from './desktop/renderer/town/components/composer';
    import { TownAuth } from './desktop/renderer/town/components/auth';
    import { TownModel } from './desktop/renderer/town/models/town';
    import { SceneStore } from './desktop/renderer/shared/models/scene';
    import { inboxMessages } from './desktop/renderer/town/models/feed';
    import { mentionNames } from './desktop/renderer/town/models/mentions';

    // The inbox as the main process validated it. Two beings share the display
    // name 「河流」 and only their Town IDs tell them apart.
    const inbox = [
      { id: 'incoming', senderId: 't_RiverA', senderName: '河流', recipientId: 't_Willow', content: '当前显示名优先', createdAt: '2026-09-14T10:00:00Z' },
      { id: 'outgoing', senderId: 't_Willow', senderName: '柳树', recipientId: 't_RiverB', recipientName: '河流', content: '同名收件人使用各自的 Town ID', createdAt: '2026-09-14T11:00:00Z' },
      { id: 'escaped', senderId: 't_Other', senderName: '<img src=x onerror=alert(1)>', recipientId: 't_Willow', content: '名称按纯文本展示', createdAt: '2026-09-14T09:00:00Z' },
      { id: 'legacy-in', senderId: 'river_internal', senderName: 'Seam Walker', recipientId: 't_Willow', content: '旧格式收件回复', createdAt: '2026-09-14T08:00:00Z' },
      { id: 'unaddressable', senderId: 't_Willow', senderName: '柳树', content: '我发出去的，但 Town 没有说收件人', createdAt: '2026-09-14T07:00:00Z' },
    ];
    const members = [
      { id: 't_RiverA', name: '河流 (t_RiverA)', description: '' },
      { id: 't_RiverB', name: '河流 (t_RiverB)', description: '' },
      { id: 't_Willow', name: '柳树', description: '' },
    ];
    const appState = {
      identity: { loomBeingId: 'cz_being', townId: 't_Willow', displayName: '柳树', sendAs: 'client:desktop', beingId: 't_Willow', connectionRevision: 1, identityRevision: 1 },
      access: {}, accessDetail: {},
      bonfire: { status: 'ready', detail: '' }, fireside: { status: 'ready', detail: '' },
      scroll: { status: 'ready', detail: '' }, beings: { status: 'ready', detail: '' }, inbox: { status: 'ready', detail: '' },
      sync: { bonfire: null, fireside: null },
      client: { status: 'connected', paired: true, townId: 't_Willow', displayName: '柳树', pairingPending: false, storageFailed: false, errorCode: '', detail: '' },
      pairing: { status: 'idle', busy: false, errorCode: '' },
      memberDirectory: { revision: 1, expiresAt: 0 },
    };
    window.fixtureWrites = [];
    const noop = async () => {};
    const townDesktop = {
      appState: async () => appState,
      refreshAppState: async () => appState,
      timeline: async () => ({ kind: 'bonfire', firesideId: '', snapshot: null, status: null }),
      refreshTimeline: async () => ({ kind: 'bonfire', firesideId: '', snapshot: null, status: null }),
      loadOlder: async () => ({ kind: 'bonfire', firesideId: '', snapshot: null, status: null }),
      read: async () => ({}),
      inbox: async () => ({ messages: inbox }),
      members: async () => ({ members, revision: 1, expiresAt: 0 }),
      cached: async () => ({ cached: false, data: null, lastSuccessAt: null }),
      speak: async (input) => { window.fixtureWrites.push(input); return { ok: true, id: '1', via: 'client:desktop', mention_warnings: [] }; },
      onState: () => noop, onMessages: () => noop, onMembersInvalidated: () => noop,
    };
    const model = new TownModel({ townDesktop }, console.error, () => {}, new SceneStore(), () => {}, () => {});
    model.receiveState(appState);
    model.mentionNames = mentionNames(members);
    model.members = members;

    // Three feeds share one mention renderer, so the body below is rendered once
    // per view rather than assumed to be the same.
    const mentionView = location.pathname.startsWith('/mentions/') ? location.pathname.split('/').at(-1) : '';
    const mentionBody = ${body};
    if (mentionView) {
      model.view = mentionView;
      model.tab = mentionView === 'mail' ? 'all' : mentionView;
      if (mentionView === 'mail') {
        model.inbox = inboxMessages([{ id: 'mentions', senderId: 't_RiverA', senderName: '河流', recipientId: 't_Willow', content: mentionBody, createdAt: '2026-09-14T10:00:00Z' }], { me: model.me });
      } else {
        model.timeline = { messages: [
          { id: '1', beingId: 't_RiverA', townId: 't_RiverA', beingName: '河流', content: mentionBody, createdAt: '2026-09-14T10:00:00Z', revisedAt: '', mentions: ['t_RiverA', 't_RiverB'] },
          { id: '2', beingId: 't_RiverB', townId: 't_RiverB', beingName: '河流', content: '同名的另一个 Being', createdAt: '2026-09-14T11:00:00Z', revisedAt: '', mentions: [] },
        ], identity: { connectionRevision: 1 }, lastRefresh: null };
      }
    } else {
      model.view = 'mail';
      model.tab = 'all';
      model.inbox = inboxMessages(inbox, { me: model.me });
    }
    window.fixtureMessages = model.messages();
    createRoot(document.getElementById('root')).render(<>
      <TownFeed town={model} messages={model.messages()} filterKey={model.view === 'mail' ? model.tab : model.view} />
      <TownComposer model={model} />
      <button id="fixture-auth" onClick={() => { void model.auth(); }}>连接设置</button>
      <TownAuth model={model} />
    </>);
  ` },
  bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
});
const styles = await readFile('desktop/renderer/app/styles.css', 'utf8');
const server = createServer((request, response) => {
  response.setHeader('Content-Type', request.url === '/fixture.js' ? 'text/javascript' : 'text/html; charset=utf-8');
  const css = `${styles} body {display:block;height:auto;padding:32px; overflow:auto;} .social-feed {max-width:960px;margin:auto;}`;
  response.end(request.url === '/fixture.js' ? outputFiles[0].text : `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${css}</style><div id="root"></div><script src="/fixture.js"></script></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : { channel: 'chrome' }) });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const incoming = page.locator('.social-message').filter({ hasText: '当前显示名优先' });
  await incoming.waitFor();
  assert.equal(await incoming.locator('.social-author').textContent(), '河流');
  // Addresses are what a reply is sent to, never what a reader is shown.
  assert.doesNotMatch(await page.locator('#root').innerText(), /t_RiverA|t_RiverB|t_Willow|t_Other|river_internal/);
  assert.equal(await page.locator('.social-author img').count(), 0);
  assert.equal(await page.locator('.social-author').filter({ hasText: '<img src=x onerror=alert(1)>' }).count(), 1);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/town-names.png' });
  // A letter of mine is answered to the other end, not to its sender — which is
  // me, and which Town refuses outright (docs/migration/i1-town.md §9 R4).
  for (const [caption, id, address] of [
    ['当前显示名优先', 'incoming', 't_RiverA'],
    ['同名收件人使用各自的 Town ID', 'outgoing', 't_RiverB'],
    ['旧格式收件回复', 'legacy-in', 'river_internal'],
  ]) {
    const card = page.locator('.social-message').filter({ hasText: caption });
    await card.getByRole('button', { name: '回复', exact: true }).click();
    assert.equal(await page.locator('#town-recipient').inputValue(), caption === '旧格式收件回复' ? 'Seam Walker' : '河流');
    assert.equal(await page.locator('#town-recipient').evaluate(el => el.readOnly), true);
    assert.match(await page.locator('#town-send-context').textContent(), /以「柳树」的身份代发/);
    await page.locator('#town-send-content').fill('回复 ' + id);
    await page.locator('#town-send-submit').click();
    await page.waitForFunction(() => !document.querySelector('#town-send-dialog').open);
    assert.deepEqual(await page.evaluate(() => window.fixtureWrites.at(-1)),
      { kind: 'dm', recipient: address, content: '回复 ' + id, connectionRevision: 1, replyTo: id });
  }
  // A letter of mine that Town did not address offers no reply at all: there is
  // nothing to send it to, and the sender is me.
  assert.equal(await page.locator('.social-message').filter({ hasText: '但 Town 没有说收件人' })
    .getByRole('button', { name: '回复', exact: true }).count(), 0);
  await incoming.getByRole('button', { name: '回复', exact: true }).click();
  await page.locator('#town-reply-clear').click();
  assert.equal(await page.locator('#town-recipient').evaluate(el => el.readOnly), false);
  await page.locator('#town-send-close').click();
  await page.locator('#fixture-auth').click();
  await page.locator('#town-auth-dialog').waitFor();
  assert.match(await page.locator('#town-auth-state').textContent(), /柳树/);
  await page.screenshot({ path: 'test-results/town-paired-display.png' });
  for (const view of ['bonfire', 'firesides', 'mail']) {
    await page.goto(`http://127.0.0.1:${server.address().port}/mentions/${view}`);
    const body = page.locator('.social-message').filter({ hasText: '正文' }).locator('.social-body');
    await body.waitFor();
    assert.deepEqual(await body.locator('.town-mention').allTextContents(), ['@河流', '@河流']);
    assert.deepEqual(await body.locator('.town-mention').evaluateAll(items => items.map(item => [item.dataset.townId, item.title])), [['t_RiverA', '@t_RiverA'], ['t_RiverB', '@t_RiverB']]);
    assert.match(await body.innerText(), /未知 @t_Unknown/);
    assert.equal(await body.locator('code').textContent(), '@t_RiverA');
    assert.equal(await body.locator('a').getAttribute('href'), 'https://example.com/@t_RiverB');
    assert.match(await page.evaluate(() => window.fixtureMessages[0].content), /@t_RiverA 和 \*\*@t_RiverB\*\*/);
    await page.screenshot({ path: `test-results/town-mentions-${view}.png` });
  }
  assert.deepEqual(errors, []);
  console.log('PASS: DM names, exact reply addresses for received and sent mail, an unaddressable letter, the saved pairing display and mention rendering in all three feeds.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
