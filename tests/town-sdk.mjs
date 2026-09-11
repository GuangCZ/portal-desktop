// SDK contract fixtures only: no real Town pairing, messages or credentials.
import { launchDesktop } from './support/electron-lifecycle.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { desktopExecutable } from './support/desktop.mjs';

const dir = await mkdtemp(path.join(os.tmpdir(), 'town-sdk-2769e2f-'));
let app;
try {
  app = await launchDesktop({ executablePath: await desktopExecutable(), env: { ...process.env, PORTAL_DESKTOP_USER_DATA: dir } });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: '连接我的 Being' }).waitFor();
  await app.evaluate(({ protocol }) => {
    const token = 'sdk-fixture-client-token';
    globalThis.sdkWrites = [];
    const base = { being: 'willow', speaker_name: '服务端展示名', at: '2026-09-11T10:00:00Z' };
    const messages = [
      { ...base, seq: 1, message: 'Being 本体消息', via: 'being' },
      { ...base, seq: 2, message: '伙伴代发消息', via: 'client:my-phone' },
      { ...base, seq: 3, message: '旧消息缺少来源', via: null },
      { ...base, seq: 4, message: '来源按纯文本展示', via: 'client:<img src=x onerror=alert(1)>' },
    ];
    protocol.handle('https', async request => {
      const url = new URL(request.url);
      if (url.origin !== 'https://beings.town') return Response.json({ error: 'fixture only' }, { status: 404 });
      if (url.pathname === '/api/client/pair/confirm') {
        const body = await request.json();
        if (body.being_id !== 'willow' || body.code !== 'AB3XY9' || request.headers.has('authorization')) return Response.json({ error: 'bad fixture pairing' }, { status: 400 });
        return Response.json({ ok: true, token, being_id: 'willow' });
      }
      if (url.pathname === '/api/client/stream') {
        if (url.searchParams.get('token') !== token) return new Response('', { status: 401 });
        return new Response(new ReadableStream({ start(controller) {
          globalThis.sdkStream = controller;
          controller.enqueue(new TextEncoder().encode('event: hello\ndata: {"being_id":"willow","token_kind":"client","anonymous":false}\n\n'));
        } }), { headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (url.pathname === '/api') return Response.json({ version: 'fixture', community: [], services: { bonfire: { what: '篝火说明' }, messages: { what: '私信说明' }, fireside: { what: '围炉说明' } } });
      if (url.pathname !== '/api/bonfire/hear' && request.headers.get('authorization') !== `Bearer ${token}`) return Response.json({ error: 'unauthorized' }, { status: 401 });
      if (request.method === 'POST') {
        globalThis.sdkWrites.push({ path: url.pathname, body: await request.json() });
        return Response.json({ ok: true, via: 'client:desktop', seq: 5, message_id: 'sent-1' });
      }
      if (url.pathname === '/api/bonfire/hear') return Response.json({ ok: true, being: 'willow', messages });
      if (url.pathname === '/api/fireside/list') return Response.json({ owned: [{ id: 10, name: '测试围炉' }], joined: [] });
      if (url.pathname === '/api/fireside/hear') return Response.json({ ok: true, messages: [messages[1]] });
      if (url.pathname === '/api/messages') return Response.json({ messages: [{ id: 'dm-1', sender: 'river', recipient: 'willow', content: '来自伙伴的私信', created_at: base.at, via: 'client:tablet' }] });
      return Response.json({ error: 'fixture only' }, { status: 404 });
    });
  });
  const home = async () => {
    if (await page.locator('#place-sheet').evaluate(el => el.open)) await page.locator('#back-to-chat').click();
    await page.locator('#options-trigger').click();
    await page.locator('[data-view="town"]').click();
    await page.locator('.service-card').first().waitFor();
  };
  const open = async title => {
    await home();
    await page.locator('.service-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).getByRole('button', { name: '打开', exact: true }).click();
  };
  await home();
  await page.locator('#town-auth-button').click();
  await page.locator('#town-being').fill('willow');
  await page.locator('#town-pair-code').fill('AB3XY9');
  await page.locator('#town-auth-form button[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector('#town-auth-dialog').open);
  await page.waitForFunction(async () => (await window.beings.townLive()).phase === 'connected');
  await open('篝火');
  await page.getByText('伙伴代发消息', { exact: true }).waitFor();
  const partner = page.locator('.social-message').filter({ hasText: '伙伴代发消息' });
  assert.equal(await partner.locator('.via-tag').textContent(), '借 my-phone');
  assert.equal(await partner.locator('.social-author').textContent(), '服务端展示名');
  for (const body of ['Being 本体消息', '旧消息缺少来源']) assert.equal(await page.locator('.social-message').filter({ hasText: body }).locator('.via-tag').count(), 0);
  assert.equal(await page.locator('.via-tag img').count(), 0);
  assert((await page.locator('.via-tag').allTextContents()).includes('借 <img src=x onerror=alert(1)>'));
  await page.screenshot({ path: path.join(os.tmpdir(), 'town-sdk-via.png') });
  await page.locator('#town-write').click();
  assert((await page.locator('#town-send-context').textContent()).includes('以 @willow 的身份代发'));
  await page.locator('#town-send-content').fill('SDK 测试消息');
  await page.locator('#town-send-submit').click();
  await page.waitForFunction(() => !document.querySelector('#town-send-dialog').open);
  assert.deepEqual(await app.evaluate(() => globalThis.sdkWrites), [{ path: '/api/bonfire/speak', body: { message: 'SDK 测试消息' } }]);
  await open('私信');
  await page.getByText('来自伙伴的私信', { exact: true }).waitFor();
  assert.equal(await page.locator('.via-tag').textContent(), '借 tablet');
  assert.equal(await page.locator('.social-message').getByRole('button', { name: '回复', exact: true }).count(), 0);
  await page.locator('#town-write').click();
  await page.locator('#town-recipient').fill('willow');
  await page.locator('#town-send-content').fill('不能发给自己');
  await page.locator('#town-send-submit').click();
  await page.locator('#town-send-error').getByText(/不能给当前 Being 自己/).waitFor();
  assert.equal(await app.evaluate(() => globalThis.sdkWrites.length), 1);
  await page.locator('#town-send-close').click();
  await open('围炉');
  await page.getByText('伙伴代发消息', { exact: true }).waitFor();
  assert.equal(await page.locator('.via-tag').textContent(), '借 my-phone');
  assert.deepEqual(errors, []);
  console.log('PASS: SDK pairing + SSE hello, server display names, via badges in all three feeds, inert via text, explicit author context, fixture-only send, self-DM blocked before network');
} finally {
  if (app) await app.close();
  await rm(dir, { recursive: true, force: true });
}
