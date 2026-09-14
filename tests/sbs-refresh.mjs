// Real generated Loom + its desktop bridge, served only by a local fixture.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const { outputFiles } = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { AppModel } from './desktop/renderer/app/models/app';
  import { useModel } from './desktop/renderer/shared/hooks/use-model';
  import { Topbar } from './desktop/renderer/app/components/topbar';
  const app = new AppModel({});
  window.sbsApp = app;
  window.sbsStates = [];
  const snapshot = { settings: { being: 'fixture', hasToken: true }, portal: { phase: 'stopped', logs: [] } };
  app.post = data => document.getElementById('chat-frame')?.contentWindow?.postMessage(data, location.origin);
  // HTTP transport for the fixture; production validates beings://chat and the same frame revision.
  window.addEventListener('message', event => {
    const frame = document.getElementById('chat-frame');
    if (!frame || event.source !== frame.contentWindow || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.revision !== new URL(frame.src).searchParams.get('revision')) return;
    if (message.type === 'beings:sbs-state') {
      window.sbsStates.push(message);
      if (typeof message.enabled === 'boolean') app.setSbsEnabled(message.enabled);
      else if (message.known === false) app.setSbsEnabled();
    }
  });
  function Fixture() {
    useModel(app);
    return <><Topbar model={app} /><iframe id="chat-frame" title="Loom fixture"
      src={'/loom' + new URL(app.chatSource).search} onLoad={() => app.frameLoaded()} /></>;
  }
  app.applySnapshot(snapshot);
  createRoot(document.getElementById('root')).render(<Fixture />);
` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic' });
const css = await readFile('desktop/renderer/app/styles.css', 'utf8');
const loom = await readFile('desktop/generated/loom.html', 'utf8');
const assets = new Map(await Promise.all(['chat.js', 'chat.css', 'highlight.css'].map(async file => [ '/' + file, await readFile('desktop/generated/' + file) ])));
let enabled = false, status = 200, malformed = false, holdReads = true, holdPatch = false, rejectPatch = false;
const reads = [], patches = [], pendingReads = [], pendingPatches = [];
const release = queue => { for (const finish of queue.splice(0)) finish(); };
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const json = (data, code = 200) => { response.writeHead(code, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
  if (url.pathname === '/api/llm/config') {
    if (request.method === 'PATCH') {
      let body = ''; for await (const chunk of request) body += chunk;
      const patch = JSON.parse(body); patches.push(patch);
      const finish = () => {
        if (rejectPatch) return json({ error: 'fixture rejection' }, 500);
        enabled = patch.sbs_enabled === 'on';
        json({ ok: true, config: { sbs_enabled: enabled, model: 'fixture', presets: [] } });
      };
      if (holdPatch) pendingPatches.push(finish); else finish();
    } else {
      const config = { model: 'fixture', presets: [], ...(malformed ? {} : { sbs_enabled: enabled }) }, code = status;
      reads.push(config);
      const finish = () => json(config, code);
      if (holdReads) pendingReads.push(finish); else finish();
    }
    return;
  }
  if (url.pathname === '/api/status') return json({ being_name: 'fixture' });
  if (url.pathname === '/api/history') return json({ messages: [] });
  if (url.pathname === '/api/stream/active') { response.writeHead(204); response.end(); return; }
  if (url.pathname === '/health') return json({ status: 'ok', commit: 'fixture' });
  if (assets.has(url.pathname)) {
    response.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
    response.end(assets.get(url.pathname)); return;
  }
  if (url.pathname === '/fixture.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(outputFiles[0].text); return; }
  if (url.pathname === '/loom') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(loom); return; }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${css}body{display:block;background:var(--bg)}#chat-frame{height:650px}</style><div id="root"></div><script src="/fixture.js"></script></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const until = async predicate => {
  const end = Date.now() + 10000;
  while (!await predicate()) { assert.ok(Date.now() < end, 'fixture request arrived'); await new Promise(resolve => setTimeout(resolve, 10)); }
};
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : { channel: 'chrome' }) });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = 'http://127.0.0.1:' + server.address().port;
  await page.route('**/*', route => {
    if (route.request().url().startsWith(origin + '/')) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  const button = page.getByRole('button', { name: '切换 SBS 自主醒来', exact: true });
  const confirmed = value => page.waitForFunction(value => {
    const button = document.querySelector('.sbs-header-switch');
    return button?.getAttribute('aria-pressed') === String(value) && !button.disabled;
  }, value);
  const frame = () => page.frames().find(frame => frame.url().startsWith(origin + '/loom'));
  const request = () => page.evaluate(() => window.sbsApp.post({ type: 'beings:sbs-request' }));
  await page.goto(origin);
  await until(() => reads.length > 0);
  assert.equal(await button.isDisabled(), true);
  assert.equal(await button.getAttribute('aria-pressed'), null, 'Initial default is not confirmed state');
  assert.equal(await page.evaluate(() => window.sbsStates.length), 0);
  holdReads = false; release(pendingReads);
  await confirmed(false);

  // External SBS change + real refresh button reloads the frame and issues a new GET.
  enabled = true; holdReads = true;
  const beforeRefresh = reads.length;
  await page.getByRole('button', { name: '刷新 Being 对话', exact: true }).click();
  await until(() => reads.length > beforeRefresh);
  assert.equal(await button.getAttribute('aria-pressed'), null);
  holdReads = false; release(pendingReads);
  await confirmed(true);
  enabled = false;
  const beforeRequest = reads.length;
  await request(); await confirmed(false);
  assert.ok(reads.length > beforeRequest, 'SBS request reads the server instead of the memory snapshot');

  // Ordinary Loom config reads and focus refreshes also notify the shell.
  enabled = true;
  await page.evaluate(() => window.sbsApp.post({ type: 'beings:chat-action', action: 'model' }));
  await confirmed(true);
  enabled = false;
  await frame().evaluate(() => window.dispatchEvent(new Event('focus')));
  await confirmed(false);

  // A rejected toggle must not optimistically flip the header.
  holdPatch = true; rejectPatch = true;
  await button.click(); await until(() => pendingPatches.length === 1);
  assert.equal(await page.evaluate(() => window.sbsApp.sbsEnabled), false);
  assert.equal(await button.isDisabled(), true);
  holdPatch = false; release(pendingPatches);
  await confirmed(false);
  rejectPatch = false;
  await button.click(); await confirmed(true);

  // An older pending GET cannot undo a subsequently confirmed successful toggle.
  holdReads = true;
  // A focus/config read from the previous step may still be shared by the
  // runtime. Request again once it settles until this fixture holds a new GET.
  await until(async () => { await request(); return pendingReads.length > 0; });
  await button.click();
  await confirmed(false);
  const beforeLateRead = await page.evaluate(() => window.sbsStates.length);
  holdReads = false; release(pendingReads);
  await request();
  await confirmed(false);
  assert.equal(await page.evaluate(index => window.sbsStates.slice(index).some(state => state.enabled === true), beforeLateRead), false);

  // Failed or malformed responses leave the state unknown; refresh recovers it.
  status = 503;
  await page.getByRole('button', { name: '刷新 Being 对话', exact: true }).click();
  await page.waitForFunction(() => window.sbsStates.at(-1)?.known === false);
  assert.equal(await button.isDisabled(), true);
  assert.equal(await button.getAttribute('aria-pressed'), null);
  status = 200; malformed = true;
  const beforeMalformed = reads.length;
  await request(); await until(() => reads.length > beforeMalformed);
  assert.equal(await button.getAttribute('aria-pressed'), null);
  malformed = false; enabled = true;
  await page.getByRole('button', { name: '刷新 Being 对话', exact: true }).click();
  await confirmed(true);
  await page.reload(); await confirmed(true);
  assert.equal(patches.length, 3, 'Only explicit test toggles write configuration');
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log('PASS: SBS refresh fetches live config, delayed initial reads, server-confirmed toggles, stale-read isolation, focus sync and failure recovery.');
} finally {
  release(pendingReads); release(pendingPatches);
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
