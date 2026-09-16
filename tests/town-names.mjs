// Real React components with local fixtures; no Town requests or credentials.
// The `/places` route used to mount `ChatPlaces` — the town-shortcut row of the
// Loom composer — which went with the `beings://chat` document on 2026-09-16.
// The native composer has no such row yet, so that coverage is gone rather than
// repointed; see MIGRATION.md, "P1 完成状态".
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), sourcefile: 'town-names-fixture.tsx', loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client';
    import { TownFeed } from './desktop/renderer/town/components/feed';
    import { TownComposer } from './desktop/renderer/town/components/composer';
    import { TownAuth } from './desktop/renderer/town/components/auth';
    import { TownModel } from './desktop/renderer/town/models/town';
    import { SceneStore } from './desktop/renderer/shared/models/scene';
    import { collectMentionNames } from './desktop/renderer/town/models/mentions';
    const messages = [
      { id: 'incoming', sender_display: '河流', sender_name: 'old-river', sender_town_id: 't_RiverA', recipient_town_id: 't_Willow', content: '当前显示名优先', created_at: '2026-09-14T10:00:00Z' },
      { id: 'outgoing', sender_display: '柳树', sender_town_id: 't_Willow', recipient_display: '河流', recipient_town_id: 't_RiverB', content: '同名收件人使用各自的 Town ID', created_at: '2026-09-14T11:00:00Z' },
      { id: 'escaped', sender_display: '<img src=x onerror=alert(1)>', sender_town_id: 't_Other', recipient_town_id: 't_Willow', content: '名称按纯文本展示', created_at: '2026-09-14T09:00:00Z' },
      { id: 'legacy-in', sender_being_id: 'river_internal', sender_display_name: 'Seam Walker', recipient_town_id: 't_Willow', content: '旧格式收件回复', created_at: '2026-09-14T08:00:00Z' },
      { id: 'legacy-out', sender_town_id: 't_Willow', sender_display: '柳树', recipient_being_id: 'river_internal', recipient_display_name: 'Seam Walker', content: '旧格式发件回复', created_at: '2026-09-14T07:00:00Z' },
      { id: 'unaddressable', sender_being_id: 'unaddressable_internal', recipient_town_id: 't_Willow', content: '只有内部 ID 不猜收件地址', created_at: '2026-09-14T06:00:00Z' },
    ];
    window.fixtureWrites = [];
    const model = new TownModel({ townAuth: async () => ({ configured: true, pairedBeingId: 't_Willow', display: '柳树 (t_Willow)', suggestedBeingId: 'other-loom-being' }), sendTown: async (input) => {
      window.fixtureWrites.push(input);
      return { ok: true, data: {}, fetchedAt: new Date().toISOString() };
    } }, console.error, () => {}, new SceneStore(), () => {}, () => {});
    model.view = 'mail'; model.tab = 'all'; model.me = 't_Willow';
    const mentionView = location.pathname.startsWith('/mentions/') ? location.pathname.split('/').at(-1) : '';
    const feed = mentionView ? [
      { id: 'mentions', seq: 1, town_id: 't_RiverA', speaker_name: '河流', sender_town_id: 't_RiverA', sender_display: '河流', recipient_town_id: 't_Willow',
        content: '正文 @t_RiverA 和 **@t_RiverB**，未知 @t_Unknown。\\n\\n代码：\u0060@t_RiverA\u0060\\n\\n[@t_RiverB](https://example.com/@t_RiverB)' },
      { id: 'other', seq: 2, town_id: 't_RiverB', speaker_name: '河流', sender_town_id: 't_RiverB', sender_display: '河流', content: '同名的另一个 Being' },
    ] : messages;
    if (mentionView) model.view = mentionView;
    model.mentionNames = collectMentionNames(feed);
    window.fixtureMessages = feed;
    model.live = { phase: 'connected', beingId: 't_Willow', display: '柳树', generation: 1, revision: 1, sync: 1, versions: { bonfire: 0, mail: 0, firesides: 0 }, message: 'fixture' };
    model.load = async () => {};
    createRoot(document.getElementById('root')).render(<>
      <TownFeed town={model} data={{ messages: feed }} filterKey={model.view + ':all'} />
      <TownComposer model={model} />
      <button id="fixture-auth" onClick={() => { model.live = { ...model.live, phase: 'connecting', beingId: undefined, display: undefined, message: '正在确认 Town 身份' }; void model.auth(); }}>连接设置</button>
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
  assert.equal(await page.locator('.social-author-id').count(), 0);
  assert.doesNotMatch(await page.locator('#root').innerText(), /t_RiverA|t_RiverB|t_Willow|t_Other/);
  assert.equal(await page.locator('.social-author img').count(), 0);
  assert.equal(await page.locator('.social-author').filter({ hasText: '<img src=x onerror=alert(1)>' }).count(), 1);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/town-names.png' });
  for (const [card, id] of [[incoming, 'incoming'], [page.locator('.social-message').filter({ hasText: '同名收件人使用各自的 Town ID' }), 'outgoing']]) {
    await card.getByRole('button', { name: '回复', exact: true }).click();
    assert.equal(await page.locator('#town-recipient').inputValue(), '河流');
    assert.equal(await page.locator('#town-recipient').evaluate(el => el.readOnly), true);
    await page.locator('#town-send-content').fill('回复 ' + id);
    await page.locator('#town-send-submit').click();
    await page.waitForFunction(() => !document.querySelector('#town-send-dialog').open);
  }
  assert.deepEqual(await page.evaluate(() => window.fixtureWrites), [
    { kind: 'dm', content: '回复 incoming', recipient: 't_RiverA', replyTo: 'incoming' },
    { kind: 'dm', content: '回复 outgoing', recipient: 't_RiverB', replyTo: 'outgoing' },
  ]);
  for (const [caption, id] of [['旧格式收件回复', 'legacy-in'], ['旧格式发件回复', 'legacy-out']]) {
    const card = page.locator('.social-message').filter({ hasText: caption });
    await card.getByRole('button', { name: '回复', exact: true }).click();
    assert.equal(await page.locator('#town-recipient').inputValue(), 'Seam Walker');
    assert.match(await page.locator('#town-send-context').textContent(), /以「柳树」的身份代发/);
    await page.locator('#town-send-content').fill('回复 ' + id);
    await page.locator('#town-send-submit').click();
    await page.waitForFunction(() => !document.querySelector('#town-send-dialog').open);
    assert.deepEqual(await page.evaluate(() => window.fixtureWrites.at(-1)), { kind: 'dm', content: '回复 ' + id, recipient: 'Seam Walker', replyTo: id });
  }
  assert.equal(await page.locator('.social-message').filter({ hasText: '只有内部 ID 不猜收件地址' }).getByRole('button', { name: '回复', exact: true }).count(), 0);
  await incoming.getByRole('button', { name: '回复', exact: true }).click();
  await page.locator('#town-reply-clear').click();
  assert.equal(await page.locator('#town-recipient').evaluate(el => el.readOnly), false);
  await page.locator('#town-send-close').click();
  await page.locator('#fixture-auth').click();
  await page.locator('#town-auth-dialog').waitFor();
  assert.equal(await page.locator('#town-being').inputValue(), 't_Willow');
  assert.match(await page.locator('#town-auth-state').textContent(), /已保存配对：柳树/);
  assert.match(await page.locator('#town-auth-state').textContent(), /正在确认 Town 身份/);
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
  console.log('PASS: DM names, exact and legacy reply recipients, unaddressable legacy mail, saved pairing display and confirmed sender.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
