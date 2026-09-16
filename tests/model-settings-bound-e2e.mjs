// 模型设置, in the PACKAGED client, cold-started against a Being that was already
// saved in the profile before launch. Written on 2026-09-16 (integration unit
// I6b) after review: every other check of this page — tests/sbs-refresh.mjs
// included — drives a fixture main process, and the unit's first packaged smoke
// only ever saw the disconnected page, so the whole connected path went
// unverified in the real client.
//
// It is the one check that runs desktop/main/main.ts's own assembly: the real
// SettingsStore reading a real profile, `restoreStartup()` → `verifyConnection()`
// → `connectionVerified`, the real preload, the real renderer bundle.
//
// Runs as `npm run test:model-settings` and as the `model-settings-e2e` step of
// `npm run test:all` (wired on 2026-09-17, once the I6b merge unfroze
// package.json and scripts/test-all.mjs). By hand, after `npm run package`:
//
//     node tests/model-settings-bound-e2e.mjs
//
// WHAT IT CATCHES. Removing the `void this.pull()` from
// settings/models/model-settings.ts `start()` and repackaging fails it at
// `page-knows-a-being-is-connected` with「连接 Being 后即可配置模型。」— measured
// on 2026-09-16, both directions, against the packaged product.
//
// Two launches share one temporary profile:
//   1. the first binds the fixture Being through the client's own connection
//      form, exactly as a person would, and then quits;
//   2. the second is the run under test. Its main process reads settings.json,
//      verifies the Being over `/api/status` and calls `connectionVerified`
//      while the window is still loading — so the model-settings push goes out
//      with nobody listening, which is the ordering the review reproduced.
//
// Nothing outside the temporary profile and a loopback HTTP server is touched:
// the background service checkbox is cleared before saving, so no launch agent
// is installed and no Portal is expected to run.
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { launchDesktop } from './support/electron-lifecycle.mjs';
import { desktopExecutable } from './support/desktop.mjs';

const directory = await mkdtemp(path.join(os.tmpdir(), 'beings-bound-smoke-'));
const profile = path.join(directory, 'profile');
const token = '5'.repeat(64);
const being = 'smoke_being';

let stored = {
  model: 'smoke-model-a', provider: 'openai', base_url: 'https://model.smoke.invalid/v1',
  has_api_key: true, thinking: '', temperature: null, sbs_enabled: false,
  presets: [
    { id: 'smoke-a', label: 'Smoke A', model: 'smoke-model-a', provider: 'openai', has_key: true },
    { id: 'smoke-b', label: 'Smoke B', model: 'smoke-model-b', provider: 'openai', has_key: true },
    { id: 'smoke-self', label: 'Smoke Self Hosted', model: 'smoke-self-hosted', provider: 'self-hosted' },
  ],
};
const reads = [];
const patches = [];
const others = new Set();

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const json = (data, code = 200) => { response.writeHead(code, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
  if (url.pathname.endsWith('/api/status')) return json({ being_name: 'Smoke Being', name: 'Smoke Being', description: '模型设置冒烟夹具。' });
  if (url.pathname.endsWith('/health')) return json({ status: 'ok', commit: 'smoke' });
  if (url.pathname.endsWith('/api/history')) return json({ messages: [] });
  if (url.pathname.endsWith('/api/stream/active')) { response.writeHead(204); response.end(); return; }
  if (url.pathname.endsWith('/api/llm/config')) {
    if (request.method === 'PATCH') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const patch = JSON.parse(body);
      patches.push(patch);
      const { sbs_enabled: sbs, ...rest } = patch;
      stored = { ...stored, ...rest, ...(sbs === undefined ? {} : { sbs_enabled: sbs === 'on' }) };
      return json({ ok: true, config: stored });
    }
    reads.push(Date.now());
    return json(stored);
  }
  others.add(url.pathname);
  json({ error: 'not found' }, 404);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const env = { ...process.env, PORTAL_DESKTOP_USER_DATA: profile, PORTAL_DESKTOP_TEST_MOCK_KEYCHAIN: '1' };
const checks = [];
const check = (name, passed, detail) => { checks.push(name); assert.ok(passed, `${name}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

let app;
try {
  const executablePath = await desktopExecutable();

  // ── Launch 1: bind the Being the way a person does, then quit ───────────────
  app = await launchDesktop({ executablePath, env });
  let page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await page.getByRole('button', { name: '连接我的 Being' }).click();
  await page.locator('#connection-link').fill(`${origin}/${being}/?token=${token}`);
  await page.locator('#portal-name-input').fill('being-desktop-smoke');
  await page.locator('#workspace-input').fill(path.join(directory, 'workspace'));
  await page.locator('#background-input').uncheck();
  await page.getByRole('button', { name: '保存、连接并启动' }).click();
  await page.waitForFunction(() => !document.querySelector('#settings-dialog')?.open, { timeout: 60000 });
  await app.close();
  app = undefined;
  console.log(`Launch 1: Being saved in the profile (${reads.length} config reads so far).`);

  // ── Launch 2: the cold start under test ────────────────────────────────────
  const before = reads.length;
  app = await launchDesktop({ executablePath, env });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  await page.locator('#open-models').waitFor();
  // The main process bound the Being during startup and read /api/llm/config
  // once, unasked, before this renderer subscribed to anything.
  await pause(1000);
  check('being-bound-before-the-page-subscribed', reads.length > before, { before, now: reads.length });

  await page.locator('#open-models').click();
  await page.locator('#model-settings-page').waitFor();
  const status = (await page.locator('#model-config-status').textContent()).trim();
  check('page-knows-a-being-is-connected', status !== '连接 Being 后即可配置模型。', status);

  // The model list the Being offers, populated by the page's own read.
  await page.waitForFunction(() => document.querySelectorAll('#model-select option').length >= 4);
  const options = await page.locator('#model-select option').allTextContents();
  check('model-list-populated', options.length === 4, options);
  check('self-hosted-group-first', (await page.locator('#model-select optgroup').first().getAttribute('label')) === '自部署');
  check('key-field-is-write-only', await page.locator('#model-api-key').inputValue() === '');

  // 刷新列表 works against the real client.
  const beforeRefresh = reads.length;
  await page.locator('#model-config-refresh').click();
  await pause(1500);
  check('refresh-reads-the-being-again', reads.length > beforeRefresh, { beforeRefresh, now: reads.length });

  // The Side by Side switch: confirmed state, then a real toggle.
  await page.waitForFunction(() => document.querySelector('#model-sbs-toggle')?.getAttribute('aria-pressed') === 'false');
  check('sbs-switch-enabled-after-a-confirmed-read', !await page.locator('#model-sbs-toggle').isDisabled());
  check('sbs-shows-the-saved-value', (await page.locator('#model-sbs-configured').textContent()).trim() === '已关闭');

  await page.locator('#model-sbs-toggle').click();
  await page.waitForFunction(() => document.querySelector('#model-sbs-toggle')?.getAttribute('aria-pressed') === 'true');
  check('sbs-toggle-writes-the-measured-shape', JSON.stringify(patches.at(-1)) === JSON.stringify({ sbs_enabled: 'on' }), patches);
  check('sbs-toggle-confirmed-by-the-being', stored.sbs_enabled === true);
  check('sbs-display-follows-the-echo', (await page.locator('#model-sbs-configured').textContent()).trim() === '已开启');
  check('running-state-is-honestly-unknown', (await page.locator('#model-sbs-active').textContent()).trim() === '未知');

  check('no-renderer-errors', errors.length === 0, errors);
  console.log(`PASS: packaged client, cold start with a saved Being — ${checks.length} checks.`);
  console.log('   status  :', status);
  console.log('   options :', options.join(' | '));
  console.log('   patches :', JSON.stringify(patches));
  console.log('   reads   :', reads.length);
  console.log('   other routes asked for:', [...others].join(', ') || '(none)');
} finally {
  await app?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
