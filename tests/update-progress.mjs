import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const bundle = await build({ stdin: { contents: `
  import { createRoot } from 'react-dom/client';
  import { useState } from 'react';
  import { UpdateProgress } from './desktop/renderer/app/components/update-progress';
  function Fixture() {
    const [activity, setActivity] = useState();
    window.updateActivity = setActivity;
    return <UpdateProgress activity={activity} onCancel={() => { window.cancellations = (window.cancellations || 0) + 1; setActivity(undefined); }} />;
  }
  createRoot(document.getElementById('root')).render(<Fixture />);
`, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', jsx: 'automatic', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
const css = await readFile('desktop/renderer/app/styles.css');
const server = createServer((request, response) => {
  if (request.url === '/app.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0].contents); return; }
  if (request.url === '/app.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); return; }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end('<!doctype html><link rel="stylesheet" href="/app.css"><dialog id="settings"><button id="original-focus">检查更新</button></dialog><div id="root"></div><script src="/app.js"></script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : { channel: 'chrome' }) });
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForFunction(() => typeof window.updateActivity === 'function');
  await page.evaluate(() => { document.querySelector('#settings').showModal(); document.querySelector('#original-focus').focus(); });
  const phase = (value, extra = {}) => page.evaluate(activity => window.updateActivity(activity), { phase: value, version: '0.2.0', ...extra });
  await phase('metadata'); await page.getByText('正在读取更新信息…', { exact: true }).waitFor();
  assert.equal(await page.locator('#update-progress-dialog').evaluate(el => el.contains(document.activeElement)), true);
  await phase('downloading', { received: 26_214_400, total: 104_857_600 });
  await page.getByText('已下载 25.0 MB / 100.0 MB · 25%', { exact: true }).waitFor();
  assert.equal(await page.locator('progress').getAttribute('value'), '0.25');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/update-progress-light.png' });
  await phase('downloading', { received: 26_214_400 });
  await page.getByText('已下载 25.0 MB', { exact: true }).waitFor();
  assert.equal(await page.locator('progress').getAttribute('value'), null);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#update-progress-dialog').open);
  assert.equal(await page.locator('#original-focus').evaluate(el => el === document.activeElement), true);
  await phase('verifying'); await page.getByText('正在校验安装包…', { exact: true }).waitFor();
  await phase('preparing'); await page.getByText('正在准备安装文件…', { exact: true }).waitFor();
  await page.getByRole('button', { name: '取消下载' }).click();
  await page.waitForFunction(() => window.cancellations === 2 && !document.querySelector('#update-progress-dialog').open);
  await phase('ready'); await page.getByText('下载和校验已完成', { exact: true }).waitFor();
  assert.equal(await page.locator('#cancel-update-download').count(), 0);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#update-progress-dialog').evaluate(el => el.open), true);
  await phase('installing'); await page.getByText('正在停止 Portal，准备安装…', { exact: true }).waitFor();
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.setViewportSize({ width: 380, height: 640 });
  await page.screenshot({ path: 'test-results/update-progress-dark.png' });
  assert.equal(await page.locator('#update-progress-dialog').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await page.evaluate(() => window.updateActivity(undefined));
  await page.waitForFunction(() => !document.querySelector('#update-progress-dialog').open);
  assert.deepEqual(errors, []);
  console.log('PASS: update modal displays phases, real byte/percentage progress and unknown totals; cancellation restores settings focus and installation cannot be dismissed.');
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
