// Exercise the actual bundled React chat against a local protocol fixture.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const assets = new Map(await Promise.all(['loom.html', 'chat.js', 'chat.css', 'highlight.css'].map(async file => ['/' + file, await readFile('desktop/generated/' + file)])));
let seq = 1;
const history = [];
const append = (role, content) => history.push({ seq: seq++, role, content, at: new Date().toISOString() });
for (let i = 1; i <= 12; i++) { append('user', `历史问题 ${i}`); append('being', Array.from({ length: 6 }, (_, j) => `第 ${i} 轮回复，第 ${j + 1} 段。`).join('\n\n')); }
append('being', '打开篝火，然后看 `seeds`。\n\n```javascript\nconst safe = "<script>never()</script>";\n```\n\n`https://example.com/manual`\n\n| 列一 | 列二 |\n| --- | --- |\n| 内容 | 内容 |\n\n[恶意链接](javascript:alert(1))\n\n<img src=x onerror=alert(1)>');
const presets = [{ id: 'a', label: 'Claude Alpha', provider: 'anthropic', model: 'alpha', has_key: true }, { id: 'b', label: 'DeepSeek Beta', provider: 'deepseek', model: 'beta', has_key: false }];
let config = { model: 'alpha', presets, thinking: 'medium', temperature: 0.7, sbs_enabled: false };
const requests = [], patches = [];
let active = null, heldResponse = null, rejectConfig = false, requireKey = false, stopCount = 0, oauthPolls = 0;
const event = (response, name, data) => response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const json = (data, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
  if (url.pathname === '/api/history') return json({ messages: history });
  if (url.pathname === '/api/status') return json({ being_name: 'Willow', description: '本地 React 测试', tools: 7, memory: { nodes: 12 } });
  if (url.pathname === '/health') { response.end('OK fixture'); return; }
  if (url.pathname === '/api/llm/config') {
    if (request.method !== 'PATCH') return json(config);
    let body = ''; for await (const chunk of request) body += chunk;
    const patch = JSON.parse(body); patches.push(patch);
    if (rejectConfig) return json({ error: 'fixture rejected config' }, 500);
    if (requireKey && !patch.api_key) return json({ needs_key: true, error: 'fixture needs key' });
    config = { ...config, ...patch, sbs_enabled: patch.sbs_enabled ? patch.sbs_enabled === 'on' : config.sbs_enabled };
    return json({ ok: true, config });
  }
  if (url.pathname === '/api/llm/oauth/start') { oauthPolls = 0; return json({ status: 'pending', expires_in: 120 }); }
  if (url.pathname === '/api/llm/oauth/poll') { oauthPolls++; return json({ status: 'connected' }); }
  if (url.pathname === '/api/llm/oauth') return json({ ok: true });
  if (url.pathname === '/api/stop') { stopCount++; heldResponse?.end(); heldResponse = null; return json({ ok: true }); }
  if (url.pathname === '/api/stream/active') {
    if (!active) { response.writeHead(204); response.end(); return; }
    if (url.searchParams.has('after')) {
      const after = Number(url.searchParams.get('after'));
      const events = active.events.filter(item => item.seq > after);
      const result = { ...active, events, finished: true };
      append('being', active.reply); active = null; return json(result);
    }
    return json({ ...active, events: active.events.slice(0, 1), finished: false });
  }
  if (url.pathname === '/api/chat/stream') {
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body); requests.push(input); append('user', input.message);
    if (heldResponse) return json({ spliced: true }, 202);
    if (input.message === 'http-error') return json({ error: 'fixture request failed' }, 400);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    event(response, 'meta', { stream_id: 'stream-' + requests.length });
    event(response, 'thinking', { text: '检查 React 状态与协议' });
    event(response, 'content_block_delta', { delta: { text: '开始回复。' } });
    if (input.message === 'hold') { heldResponse = response; return; }
    if (input.message === 'continuation') event(response, 'message_stop', {});
    setTimeout(() => {
      event(response, 'tool_use', { name: 'read_file', input: { path: '/tmp/fixture.txt' } });
      event(response, 'tool_result', { name: 'read_file', summary: 'fixture file read', is_error: false });
      event(response, 'content_block_delta', { delta: { text: '\n\n**React 回复完成**。查看花园与篝火。' } });
      append('being', '开始回复。\n\n**React 回复完成**。查看花园与篝火。');
      event(response, 'message_stop', { session_id: 'session-fixture' }); response.end();
    }, 150);
    return;
  }
  if (assets.has(url.pathname)) {
    response.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
    response.end(assets.get(url.pathname)); return;
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><html><meta charset="utf-8"><style>body{margin:0}iframe{border:0;width:100vw;height:100vh}</style><iframe id="chat" src="/loom.html?revision=fixture"></iframe><script>
    window.received=[];
    window.addEventListener('message', event => {
      if(event.source!==document.querySelector('iframe').contentWindow) return;
      window.received.push(event.data);
      if(event.data.type==='beings:scene-capture') event.source.postMessage({type:'beings:scene-captured',id:event.data.id},location.origin);
    });
  </script></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : { channel: 'chrome' }) });
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const origin = 'http://127.0.0.1:' + server.address().port;
  await page.goto(origin);
  const frame = page.frameLocator('#chat');
  const child = () => page.frames().find(frame => frame.url().includes('/loom.html'));
  const post = data => page.evaluate(data => document.querySelector('iframe').contentWindow.postMessage(data, location.origin), data);
  await frame.locator('.chat-index-tick').nth(11).waitFor();
  assert.equal(await frame.locator('#messages .message').count(), 25);
  assert.equal(await frame.locator('#messages img').count(), 0);
  assert.equal(await frame.locator('#messages a[href^="javascript:"]').count(), 0);
  assert.ok(await frame.locator('.hljs-keyword').count());
  assert.equal(await frame.locator('.chat-code-link').getAttribute('href'), 'https://example.com/manual');
  await frame.getByRole('button', { name: '打开篝火', exact: true }).click();
  await page.waitForFunction(() => window.received.some(item => item.type === 'beings:open-place' && item.view === 'bonfire'));
  await frame.locator('#input').fill('保留草稿');
  await frame.locator('.chat-index-tick').first().hover();
  await frame.locator('#chat-index-preview').waitFor();
  assert.match(await frame.locator('#chat-index-preview').textContent(), /第 1 轮回复/);
  await frame.locator('.chat-index-tick').first().click();
  assert.equal(await frame.locator('#input').inputValue(), '保留草稿');
  const initialScroll = await frame.locator('#messages').evaluate(el => el.scrollTop);
  await post({ type: 'beings:town-activity', channels: ['mail'] });
  assert.equal(await frame.locator('#messages').evaluate(el => el.scrollTop), initialScroll);
  await post({ type: 'beings:chat-action', action: 'model' });
  await frame.locator('#settings-panel.active').waitFor();
  await frame.locator('#llm-current').getByText('Claude Alpha', { exact: true }).waitFor();
  await frame.locator('.llm-custom-link').click();
  await frame.locator('#s2-model').fill('custom-test'); await frame.locator('#s2-provider').fill('custom'); await frame.locator('#s2-base-url').fill('https://example.com/v1');
  rejectConfig = true; await frame.locator('#s2-apply').click(); await frame.locator('#s2-error').getByText(/fixture rejected/).waitFor();
  assert.equal(await frame.locator('#s2-model').inputValue(), 'custom-test');
  rejectConfig = false; await frame.locator('.step2-back').click(); await frame.getByRole('button', { name: /^Beta/ }).click();
  assert.equal(await frame.locator('#s2-provider').evaluate(el => el.readOnly), true);
  requireKey = true; await frame.locator('#s2-apply').click(); await frame.locator('#s2-error').getByText('fixture needs key').waitFor();
  await frame.locator('#s2-api-key').fill('fixture-key'); await frame.locator('#s2-apply').click();
  await frame.locator('#llm-current').getByText('DeepSeek Beta', { exact: true }).waitFor();
  assert.equal(patches.at(-1).api_key, 'fixture-key'); requireKey = false;
  await frame.locator('#cfg-thinking [data-val="high"]').click(); await frame.locator('#cfg-thinking [data-val="high"].active').waitFor();
  await frame.locator('#oauth-connect-btn').click(); await frame.locator('#oauth-status').getByText('✓ ChatGPT account connected').waitFor(); assert.equal(oauthPolls, 1);
  await frame.locator('#oauth-disconnect-btn').click(); await frame.getByRole('group').getByRole('button', { name: 'Disconnect', exact: true }).click(); await frame.locator('#oauth-connect-btn').waitFor();
  await frame.getByRole('button', { name: '关闭模型设置' }).click();
  await post({ type: 'beings:chat-action', action: 'being' }); await frame.locator('#soul-card.active').waitFor();
  assert.match(await frame.locator('#soul-stats').innerText(), /7/);
  await frame.getByRole('button', { name: '关闭 Being 信息' }).click();
  await post({ type: 'beings:chat-action', action: 'privacy' }); await frame.locator('#privacy-panel.active').waitFor(); await frame.getByRole('button', { name: '关闭隐私说明' }).click();
  assert.equal(await frame.locator('#input').inputValue(), '保留草稿');
  await frame.locator('#file-input').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('react attachment') });
  await frame.locator('#pending-files.active').waitFor();
  await frame.locator('#input').fill('send-test'); await frame.locator('#send-btn').click();
  await frame.getByText('React 回复完成', { exact: true }).waitFor();
  await frame.locator('.run-activity[data-outcome="done"]').waitFor();
  assert.equal(requests.length, 1); assert.equal(requests[0].attachments[0].data, Buffer.from('react attachment').toString('base64'));
  assert.equal(await frame.locator('.run-activity').count(), 1, 'One process record per completed turn');
  assert.equal(await frame.locator('.run-activity.running').count(), 0);
  await frame.locator('.run-activity summary').click(); assert.match(await frame.locator('.run-list').innerText(), /fixture file read/);
  const repliesBeforeContinuation = await frame.locator('.message.being:not(.thinking-indicator)').count();
  await frame.locator('#input').fill('continuation'); await frame.locator('#send-btn').click();
  await page.waitForFunction(() => window.received.some(item => item.type === 'beings:scene-result' && item.ok));
  await child().waitForFunction(count => document.querySelectorAll('.message.being:not(.thinking-indicator)').length === count + 2 && !document.querySelector('.run-activity.running'), repliesBeforeContinuation);
  await frame.locator('#input').fill('hold'); await frame.locator('#send-btn').click(); await frame.locator('.run-activity.running .run-stop').waitFor();
  await frame.locator('#file-input').setInputFiles({ name: 'splice.txt', mimeType: 'text/plain', buffer: Buffer.from('splice attachment') });
  await frame.locator('#pending-files.active').waitFor(); await frame.locator('#input').fill('additional input'); await frame.locator('#send-btn').click();
  await frame.getByText(/消息已送达/).waitFor(); assert.equal(requests.at(-1).attachments[0].data, Buffer.from('splice attachment').toString('base64'));
  await frame.locator('.run-activity.running .run-stop').click(); await frame.locator('.run-activity[data-outcome="stopped"]').waitFor(); assert.equal(stopCount, 1);
  await frame.locator('#input').fill('http-error'); await frame.locator('#send-btn').click(); await frame.getByText(/fixture request failed/).waitFor();
  assert.equal(await frame.locator('.run-activity.running').count(), 0);
  assert.equal(await frame.locator('.run-activity').last().getAttribute('data-outcome'), 'error');
  await frame.locator('#input').fill('');
  const draft = { type: 'beings:scene-draft', id: 'draft1', text: '一起看：以下是引用内容：fixture', expiresAt: Date.now() + 10000 };
  await post(draft); await child().waitForFunction(() => document.querySelector('#input').value.includes('fixture'));
  await post({ ...draft, id: 'draft2', text: '不得覆盖已有草稿' });
  await page.waitForFunction(() => window.received.some(item => item.type === 'beings:scene-draft-result' && item.id === 'draft2' && item.ok === false));
  await frame.locator('#send-btn').click();
  await page.waitForFunction(() => window.received.some(item => item.type === 'beings:scene-result' && item.hasSceneDraft && item.ok));
  await frame.locator('.run-activity.running').waitFor({ state: 'hidden' });
  // A fresh React root catches up using replay sequence numbers without duplicating deltas.
  active = { stream_id: 'replay-fixture', origin: 'human', next_seq: 4, reply: 'replay-once-complete', events: [
    { seq: 1, event: 'content_block_delta', data: { delta: { text: 'replay-once-' } } },
    { seq: 2, event: 'content_block_delta', data: { delta: { text: 'complete' } } },
    { seq: 3, event: 'message_stop', data: {} },
  ] };
  await page.reload(); await frame.getByText('replay-once-complete', { exact: true }).waitFor();
  assert.equal(await frame.getByText('replay-once-complete', { exact: true }).count(), 1);
  await frame.locator('#chat-index-latest').click();
  await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/chat-react-light.png' });
  await post({ type: 'beings:appearance', theme: 'dark' }); await post({ type: 'beings:reading', size: 19 });
  await child().waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.setViewportSize({ width: 420, height: 740 });
  assert.equal(await child().evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'test-results/chat-react-dark-mobile.png' });
  // The standalone browser build exposes its own React settings controls.
  await page.goto(origin + '/loom.html');
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await page.locator('#settings-panel.active').waitFor();
  await page.getByRole('button', { name: '关闭模型设置' }).click();
  assert.deepEqual(errors, []);
  console.log('PASS: React history/index/Markdown, settings and OAuth, attachments, live and spliced streams, stop/error cleanup, scene drafts, replay, dark/narrow layout.');
} finally {
  heldResponse?.end(); await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
