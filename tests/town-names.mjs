// Real React components with local fixtures; no Town requests or credentials.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), sourcefile: 'town-names-fixture.tsx', loader: 'tsx', contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { TownFeed } from './desktop/renderer/town/components/feed';
    import { TownComposer } from './desktop/renderer/town/components/composer';
    import { TownModel } from './desktop/renderer/town/models/town';
    import { SceneStore } from './desktop/renderer/shared/models/scene';
    import { ChatPlaces } from './desktop/renderer/chat/components/navigation';
    const messages = [
      { id: 'incoming', sender_display: '河流', sender_name: 'old-river', sender_town_id: 't_RiverA', recipient_town_id: 't_Willow', content: '当前显示名优先', created_at: '2026-09-14T10:00:00Z' },
      { id: 'outgoing', sender_display: '柳树', sender_town_id: 't_Willow', recipient_display: '河流', recipient_town_id: 't_RiverB', content: '同名收件人使用各自的 Town ID', created_at: '2026-09-14T11:00:00Z' },
      { id: 'escaped', sender_display: '<img src=x onerror=alert(1)>', sender_town_id: 't_Other', recipient_town_id: 't_Willow', content: '名称按纯文本展示', created_at: '2026-09-14T09:00:00Z' },
    ];
    window.fixtureWrites = [];
    const model = new TownModel({ sendTown: async (input) => {
      window.fixtureWrites.push(input);
      return { ok: true, data: {}, fetchedAt: new Date().toISOString() };
    } }, console.error, () => {}, new SceneStore(), () => {}, () => {});
    model.view = 'mail'; model.tab = 'all'; model.me = 't_Willow';
    model.live = { phase: 'connected', beingId: 't_Willow', generation: 1, revision: 1, sync: 1, versions: { bonfire: 0, mail: 0, firesides: 0 }, message: 'fixture' };
    model.load = async () => {};
    if (location.pathname === '/places') {
      window.fixturePlaces = [];
      function PlacesFixture() {
        const [channels, setChannels] = React.useState([]);
        window.updatePlaces = setChannels;
        return <div id="input-area"><div id="input-row"><textarea id="input" placeholder="说点什么…"/><button type="button" className="btn-icon" aria-label="添加附件">＋</button><div id="desktop-composer-tools"><ChatPlaces send={message => window.fixturePlaces.push(message)} channels={channels}/></div><button id="send-btn" type="button" aria-label="发送">↑</button></div></div>;
      }
      createRoot(document.getElementById('root')).render(<PlacesFixture/>);
    } else createRoot(document.getElementById('root')).render(<>
      <TownFeed town={model} data={{ messages }} filterKey="mail:all" />
      <TownComposer model={model} />
    </>);
  ` },
  bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
});
const styles = await readFile('desktop/renderer/app/styles.css', 'utf8');
const chatStyles = await readFile('desktop/renderer/chat/styles.css', 'utf8');
const server = createServer((request, response) => {
  response.setHeader('Content-Type', request.url === '/fixture.js' ? 'text/javascript' : 'text/html; charset=utf-8');
  const css = request.url === '/places'
    ? `${chatStyles} body {margin:0;} #root {min-height:100vh;display:flex;align-items:flex-end;} #input-area {box-sizing:border-box;} #input {box-sizing:border-box;resize:none;font-family:system-ui;} #send-btn {cursor:pointer;}`
    : `${styles} body {display:block;height:auto;padding:32px; overflow:auto;} .social-feed {max-width:960px;margin:auto;}`;
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
  await incoming.getByRole('button', { name: '回复', exact: true }).click();
  await page.locator('#town-reply-clear').click();
  assert.equal(await page.locator('#town-recipient').evaluate(el => el.readOnly), false);
  await page.goto(`http://127.0.0.1:${server.address().port}/places`);
  const trigger = page.locator('#chat-places-trigger');
  await trigger.waitFor();
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
  const row = page.locator('#chat-places-menu button');
  assert.equal(await row.count(), 6);
  assert.equal(await row.evaluateAll(items => new Set(items.map(item => Math.round(item.getBoundingClientRect().y))).size), 1);
  await page.locator('#input').fill('保留我的草稿');
  await trigger.click();
  assert.equal(await page.locator('#chat-places-popup').isVisible(), false);
  await trigger.hover();
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
  await page.evaluate(() => window.updatePlaces(['mail']));
  assert.equal(await trigger.getAttribute('aria-label'), '展开小镇入口 · 有新动态');
  await trigger.press('ArrowRight');
  assert.equal(await page.locator('[data-place="bonfire"]').evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('[data-place="firesides"]').evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('End');
  assert.equal(await page.locator('[data-place="scrolls"]').evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Escape');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
  await trigger.press('Enter');
  await page.locator('[data-place="mail"]').click();
  assert.deepEqual(await page.evaluate(() => window.fixturePlaces), [{ type: 'beings:open-place', view: 'mail' }]);
  assert.equal(await page.locator('#input').inputValue(), '保留我的草稿');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
  await page.screenshot({ path: 'test-results/chat-places-expanded.png' });
  await trigger.click();
  await page.screenshot({ path: 'test-results/chat-places-collapsed.png' });
  await page.setViewportSize({ width: 420, height: 700 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await trigger.click();
  assert.equal(await row.evaluateAll(items => new Set(items.map(item => Math.round(item.getBoundingClientRect().y))).size), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('[data-place="scrolls"]').click();
  assert.equal(await page.evaluate(() => window.fixturePlaces.at(-1).view), 'scrolls');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.screenshot({ path: 'test-results/chat-places-narrow-dark.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: DM names without visible IDs, exact reply recipients; horizontal town shortcuts, toggle, keyboard, activity badges, narrow layout, reduced motion and draft preservation.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
