// The Channel unit's IPC surface as the renderer meets it; 2026-09-16
// (integration unit I7).
//
// New. BeingDesktop registers these handlers inline in src/main.cjs (lines 1238,
// 1252-1262 and 1329-1332) and has no test that calls them as channels; the
// modules behind them are covered file by file (tests/town-channel-channel-being
// .test.ts, tests/town-channel-town-catalog.test.ts, tests/draft-integration
// .test.ts). What is asserted here is the seam those files cannot reach: the
// registered channel set, the sender guard, which failures come back as an
// envelope carrying a `code`, the feature-task accounting, the read-only
// promise of `inspect`, and the「读回」tail that follows a channel request.
import { afterEach, expect, it } from 'vitest';
import {
  CHANNEL_CHANNELS, channelFixture, event, json, settle, sse, stubSubsystem, type ChannelFixture,
} from './channel-fixture';
import { PAIRING_DRAFT } from '../desktop/main/town/channel/ipc';

const open: ChannelFixture[] = [];
afterEach(async () => { while (open.length) await open.pop()!.cleanup(); });
const fixture = async (options?: Parameters<typeof channelFixture>[0]) => {
  const f = await channelFixture(options);
  open.push(f);
  return f;
};

/** A Town stand-in whose only job is `session.getChannelStatus`, which is all
 * this unit reaches for through the registry. */
const townStub = (getChannelStatus: (options: { signal?: AbortSignal }) => Promise<unknown>) =>
  stubSubsystem('town', { session: { getChannelStatus } });

/** An orchestration stand-in that records what was accounted for. */
function ledgerStub() {
  const runs: { operation: string; serialized: boolean }[] = [];
  const records: unknown[] = [];
  let preparer: unknown = null;
  const installer = stubSubsystem('orchestration', {
    methods: {
      run: <T,>(_args: unknown[], options: { operation: string; serialized?: boolean }, body: () => T | Promise<T>) => {
        runs.push({ operation: options.operation, serialized: options.serialized === true });
        return Promise.resolve(body());
      },
    },
    register: (record: unknown) => { records.push(record); },
    setDraftPreparer: (prepare: unknown) => { preparer = prepare; },
  });
  return { installer, runs, records, preparer: () => preparer };
}

/** A tool-bridge stand-in: `links.open` is the only member this unit uses. */
function bridgeStub() {
  const opened: string[] = [];
  return { opened, installer: stubSubsystem('tools', { links: { open: (url: unknown) => { opened.push(String(url)); return { opened: true as const, tabId: 't1' }; } } }) };
}

const replyOnce = (options: RequestInit, status: string) => {
  const body = JSON.parse(String(options.body));
  const message = body.message as string;
  return sse(event('meta', { scene_id: body.scene_id })
    + event('content_block_delta', { scene_id: body.scene_id, delta: { text: JSON.stringify({
      protocol: 'being-desktop-channel-result/1',
      requestId: message.match(/^\[Being Desktop Town sync:([^\]]+)\]/)![1],
      route: message.match(/任务路线：([^。]+)。/)![1],
      beingId: message.match(/当前 Being：([^；]+)；/)![1],
      channel: message.match(/请为当前 Being 处理 (\w+) 渠道/)![1],
      status, detail: '实际服务结果。',
    }) } })
    + event('message_stop', { scene_id: body.scene_id }));
};

it('registers exactly its own channels and answers nobody but the shell', async () => {
  const f = await fixture();
  const registered = [...f.handlers.keys()].filter(channel => CHANNEL_CHANNELS.includes(channel));
  expect(registered).toEqual(CHANNEL_CHANNELS);
  // `beings:portal-deploy` is NOT here: integration decision §5.2 keeps
  // portal-desktop's own Portal ownership model, and the `TownController` that
  // BeingDesktop deployed through was deleted with unit I1.
  expect(f.handlers.has('beings:portal-deploy')).toBe(false);
  for (const channel of CHANNEL_CHANNELS) await expect(f.untrusted(channel)).rejects.toThrow(/Untrusted IPC sender/);
});

it('reports a channel failure as a code the page can branch on', async () => {
  const f = await fixture();
  // Nothing is bound: every Being-facing channel refuses with the same code, and
  // the page shows「请先在连接设置中连接 Being」rather than a wrong binding state.
  for (const channel of ['beings:channel-begin', 'beings:channel-check', 'beings:channel-inspect'])
    expect(await f.codeOf(channel, { channel: 'feishu', connectionRevision: 0 })).toBe('NOT_CONNECTED');
  await f.connect();
  const request = await f.request('feishu');
  // A malformed request never reaches the Being.
  for (const value of [null, 'feishu', [], {}, { channel: 'feishu' }, { channel: 'weibo', connectionRevision: 0 }, { ...request, extra: 1 }])
    expect(await f.codeOf('beings:channel-begin', value)).toBe('INVALID_REQUEST');
  expect(f.calls.filter(call => call.path === '/api/chat/stream')).toEqual([]);
  // A stale epoch is refused with its own code, not silently accepted.
  expect(await f.codeOf('beings:channel-begin', { channel: 'feishu', connectionRevision: request.connectionRevision + 9 })).toBe('SESSION_CHANGED');
});

it('never accepts an application secret, whatever it is wrapped in', async () => {
  const f = await fixture();
  await f.connect();
  for (const value of [{ appId: 'cli_x', appSecret: 's3cr3t' }, 'secret', null, undefined, []])
    expect(await f.codeOf('beings:channel-feishu', value)).toBe('INVALID_REQUEST');
  // The refusal says where a secret does belong, and nothing that was submitted
  // is echoed back or logged.
  const error = await f.call('beings:channel-feishu', { appSecret: 's3cr3t' }).then(() => null, (reason: Error) => reason);
  expect(error!.message).toBe('应用密钥须在渠道服务的专用配置入口提交，请按 Being 返回的连接说明操作。');
  expect(JSON.stringify(f.errors)).not.toContain('s3cr3t');
  expect(f.calls.filter(call => call.path === '/api/chat/stream')).toEqual([]);
});

it('a read is read-only: it asks the service and never the Being', async () => {
  let reads = 0;
  const f = await fixture({ extra: [townStub(async () => { reads++; return { channels: [{ channel: 'feishu', status: 'connected', detail: '' }, { channel: 'wechat', status: 'unknown', detail: '' }] }; })] });
  await f.connect();
  const result = await f.call('beings:channel-inspect', await f.request('feishu'));
  expect(reads).toBe(1);
  expect(result.channels.map((entry: any) => entry.channel)).toEqual(['feishu', 'wechat']);
  // docs/channel-sessions.md「打开消息渠道、切换渠道或刷新页面只读查询已有绑定，
  // 不创建会话、不发送 Being 消息、不重新登记渠道」.
  expect(f.calls.filter(call => call.path === '/api/chat/stream')).toEqual([]);
});

it('without a Town session the read refuses instead of claiming nothing is bound', async () => {
  const f = await fixture();
  await f.connect();
  expect(await f.codeOf('beings:channel-inspect', await f.request('feishu'))).toBe('SERVICE_ERROR');
});

it('the Being-facing pair are feature tasks under BeingDesktop’s own method names', async () => {
  const ledger = ledgerStub();
  const f = await fixture({ extra: [ledger.installer] });
  await f.connect();
  f.always('/api/chat/stream', (_url, options) => replyOnce(options, 'registered'));
  await f.call('beings:channel-begin', await f.request('feishu'));
  await f.call('beings:channel-check', await f.request('feishu'));
  // The ledger is keyed by BeingDesktop's METHOD names; a kebab channel name
  // would look fine here and record nothing at all
  // (docs/migration/i4-orchestration-features.md).
  expect(ledger.runs).toEqual([
    { operation: 'beginChannelConnection', serialized: false },
    { operation: 'checkChannelStatus', serialized: false },
  ]);
  // BeingDesktop's `registerFeatureRequest`: the outgoing request joins the
  // ledger, carrying the prompt and never the credential.
  expect(ledger.records.length).toBe(2);
  expect(Object.keys(ledger.records[0] as object).sort()).toEqual(['beingId', 'prompt', 'requestId', 'route']);
  expect(JSON.stringify(ledger.records)).not.toContain('c'.repeat(64));
});

it('a read is not a feature task, and works with no ledger installed at all', async () => {
  const ledger = ledgerStub();
  const f = await fixture({ extra: [ledger.installer, townStub(async () => ({ channels: [] }))] });
  await f.connect();
  await f.call('beings:channel-inspect', await f.request('feishu'));
  expect(ledger.runs).toEqual([]);
  // And with orchestration absent the two accounted channels still run, merely
  // unrecorded — BeingDesktop's own behaviour before a ledger is open.
  const bare = await fixture();
  await bare.connect();
  bare.always('/api/chat/stream', (_url, options) => replyOnce(options, 'connected'));
  expect((await bare.call('beings:channel-begin', await bare.request('feishu'))).status).toBe('connected');
});

it('a channel request is followed by one history read back, fenced on the same identity', async () => {
  const f = await fixture();
  await f.connect();
  const before = f.calls.filter(call => call.path === '/api/history').length;
  f.always('/api/chat/stream', (_url, options) => replyOnce(options, 'connected'));
  await f.call('beings:channel-begin', await f.request('feishu'));
  await settle();
  // BeingDesktop's `runChannel` tail (src/main.cjs lines 429-435): a channel can
  // reply outside the foreground reader, so its history is read back once.
  expect(f.calls.filter(call => call.path === '/api/history').length).toBeGreaterThan(before);
});

it('the catalogue crosses as data and its public pages open in the tool browser', async () => {
  const bridge = bridgeStub();
  const f = await fixture({ extra: [bridge.installer] });
  const catalog = await f.call('beings:town-catalog');
  expect(catalog.features.length).toBe(9);
  expect(catalog.sourceUrl).toBe('https://beings.town/');
  expect(await f.call('beings:town-page', 'grove')).toEqual({ opened: true });
  expect(bridge.opened).toEqual(['https://beings.town/grove']);
  // Only the three confirmed public pages, and only through the whitelist.
  for (const id of ['portal', 'channel', 'https://evil.example/', '__proto__', 42, null])
    await expect(f.call('beings:town-page', id)).rejects.toThrow();
  expect(bridge.opened.length).toBe(1);
  // Without the tool browser it says so rather than falling back to the system one.
  const bare = await fixture();
  await expect(bare.call('beings:town-page', 'home')).rejects.toThrow(/内置浏览器尚未就绪/);
});

it('one draft channel carries four kinds and refuses anything else', async () => {
  const f = await fixture();
  await f.connect();
  const place = async (request: unknown) => {
    const pending = f.call('beings:town-draft', request);
    await settle();
    const push = f.drafts().at(-1);
    if (push) await f.call('beings:composer-draft-ack', push.payload.id, 'placed');
    return { result: await pending, text: push?.payload.text as string };
  };
  expect((await place({ kind: 'feature', id: 'scroll' })).text).toMatch(/卷轴（Scroll）/);
  expect((await place({ kind: 'assistance', id: 'portal-setup' })).text).toMatch(/Portal 时遇到了问题/);
  expect((await place({ kind: 'pairing' })).text).toBe(PAIRING_DRAFT);
  const revision = await f.revision();
  expect((await place({ kind: 'fireside', draft: '晚上好', connectionRevision: revision })).text).toMatch(/尚未发送[\s\S]*晚上好$/);
  const before = f.drafts().length;
  // The outer shape is checked here; each kind's own argument is checked in
  // town-catalog.ts, where BeingDesktop checked it.
  for (const request of [null, 'feature', [], {}, { kind: 'other' }, { kind: 'feature', id: 'scroll', extra: 1 },
    { kind: 'feature', id: '' }, { kind: 'feature', id: 'x'.repeat(65) }, { kind: 'fireside', draft: 42 },
    { kind: 'fireside', draft: 'x', connectionRevision: 1.5 }, Object.assign(Object.create(null), { kind: 'pairing' })])
    await expect(f.call('beings:town-draft', request)).rejects.toThrow();
  // A fireside draft written under another epoch is never handed over.
  await expect(f.call('beings:town-draft', { kind: 'fireside', draft: '晚上好', connectionRevision: revision + 1 }))
    .rejects.toThrow(/连接身份已变化，草稿未转交/);
  expect(f.drafts().length).toBe(before);
});

it('the draft channel is serialized, so two drafts cannot race into one composer', async () => {
  const f = await fixture();
  await f.connect();
  const first = f.call('beings:town-draft', { kind: 'pairing' });
  const second = f.call('beings:town-draft', { kind: 'feature', id: 'scroll' });
  await settle();
  // The queue holds the second until the first is answered: one push in flight.
  expect(f.drafts().length).toBe(1);
  await f.call('beings:composer-draft-ack', f.drafts()[0].payload.id, 'placed');
  await expect(first).resolves.toEqual({ prepared: true });
  await settle();
  expect(f.drafts().length).toBe(2);
  await f.call('beings:composer-draft-ack', f.drafts()[1].payload.id, 'occupied');
  await expect(second).rejects.toThrow(/已有草稿/);
});

it('installs its preparer on the feature-task ledger once every subsystem exists', async () => {
  const ledger = ledgerStub();
  const f = await fixture({ extra: [ledger.installer] });
  await f.connect();
  // `linked()`, not the installer body: `setDraftPreparer` is an ASSIGNMENT onto
  // a peer, which no lazy getter can express (subsystems/types.ts).
  const preparer = ledger.preparer() as (prompt: string, current: () => unknown) => Promise<unknown>;
  expect(typeof preparer).toBe('function');
  const pending = preparer('一起看看这个任务', () => ({ connection: f.store.connection, generation: 1 }));
  await settle();
  const push = f.drafts().at(-1)!;
  expect(push.payload.text).toBe('一起看看这个任务');
  await f.call('beings:composer-draft-ack', push.payload.id, 'placed');
  await expect(pending).resolves.toEqual({ prepared: true });
  // The ledger's own fence runs first: a `current()` that throws is not overtaken
  // by this unit's context.
  await expect(preparer('第二次', () => { throw new Error('连接已变化，请重新选择任务。'); })).rejects.toThrow(/连接已变化/);
});

it('a disconnect ends the channel, even though `connectionCleared` is never called', async () => {
  const f = await fixture();
  await f.connect();
  expect((await f.call('beings:channel-status')).connected).toBe(true);
  // main.ts has never called `connectionCleared` (docs/migration/i0-seams.md), so
  // a disconnect arrives as `connectionVerified` with nothing bound. The page must
  // stop reporting a binding that is gone, and the epoch must move so a request
  // already in flight cannot come back and be believed.
  const before = (await f.call('beings:channel-status')).connectionRevision;
  f.store.connection = null;
  f.store.connectionAddress = '';
  f.extensions.connectionVerified(null);
  await settle();
  const after = await f.call('beings:channel-status');
  expect(after.connected).toBe(false);
  expect(after.connectionRevision).toBeGreaterThan(before);
  expect(after.status).toBe('unknown');
  expect(await f.codeOf('beings:channel-begin', { channel: 'feishu', connectionRevision: after.connectionRevision })).toBe('NOT_CONNECTED');
});

it('refuses every channel while the client is quitting', async () => {
  const f = await fixture();
  await f.connect();
  f.quit();
  for (const channel of CHANNEL_CHANNELS) await expect(f.invoke(channel, { kind: 'pairing' })).rejects.toThrow(/客户端正在退出/);
});
