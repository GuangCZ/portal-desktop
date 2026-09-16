// One stable conversation per (Being, Desktop, channel), end to end; 2026-09-16
// (integration unit I7).
//
// The claims under test are docs/channel-sessions.md's, which is a MEASURED
// record of the protocol, not a design note:
//
//   · 每个 Being、Desktop 和 channel 对应一个稳定的会话 ID
//   · 创建发生在首次请求发送前，不改变当前打开的会话或草稿
//   · 重启后保持关联，重命名不改变关联
//   · 切换 Being 后使用另一组会话
//   · 请求从第一条起携带 scene_id、scene_meta 和请求关联 ID
//   · 202 或中断后不重发操作，后续状态检查复用同一 scene
//
// tests/chat-sessions.test.ts already holds `ChatSessions.ensureChannel` to the
// first four at the store level. What is asserted HERE is the seam that file
// cannot reach: that the scene the channel worker actually PUTS ON THE WIRE is
// the one the conversation layer minted, through the registry, across a restart
// and across a Being switch — the wiring, which is this unit's.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  CONNECTION, channelFixture, event, json, settle, sse, type ChannelFixture,
} from './channel-fixture';
import type { Connection } from '../desktop/main/chat/connection';

const open: ChannelFixture[] = [];
afterEach(async () => { while (open.length) await open.pop()!.cleanup(); });
const fixture = async (options?: Parameters<typeof channelFixture>[0]) => {
  const f = await channelFixture(options);
  open.push(f);
  return f;
};

const OTHER_TOKEN = 'd'.repeat(64);
const OTHER_ADDRESS = `https://echo.beings.town/other_being/?token=${OTHER_TOKEN}`;
const OTHER: Connection = { endpoint: 'https://echo.beings.town/other_being', being: 'other_being', token: OTHER_TOKEN, relaySecret: OTHER_TOKEN, link: OTHER_ADDRESS };

/** The Being answering a channel request: one reply, in the contract's shape. */
const reply = (options: RequestInit, status: string, detail = '实际服务已连接。') => {
  const body = JSON.parse(String(options.body));
  const message = body.message as string;
  const contract = {
    protocol: 'being-desktop-channel-result/1',
    requestId: message.match(/^\[Being Desktop Town sync:([^\]]+)\]/)![1],
    route: message.match(/任务路线：([^。]+)。/)![1],
    beingId: message.match(/当前 Being：([^；]+)；/)![1],
    channel: message.match(/请为当前 Being 处理 (\w+) 渠道/)![1],
    status, detail,
  };
  return sse(event('meta', { scene_id: body.scene_id })
    + event('content_block_delta', { scene_id: body.scene_id, delta: { text: JSON.stringify(contract) } })
    + event('message_stop', { scene_id: body.scene_id }));
};

it('a channel request rides the conversation layer’s own scene, from the first POST', async () => {
  const f = await fixture();
  await f.connect();
  const feishu = f.chat()!.ensureChannel('feishu');
  f.always('/api/chat/stream', (_url, options) => reply(options, 'connected'));
  const result = await f.call('beings:channel-begin', await f.request('feishu'));
  expect(result.status).toBe('connected');
  const sent = f.calls.filter(call => call.path === '/api/chat/stream');
  expect(sent.length).toBe(1);
  // docs/channel-sessions.md: scene_id, scene_meta and a request-correlation id
  // from the FIRST request, and no legacy server session_id at all.
  expect(Object.keys(sent[0].body).sort()).toEqual(['client_ref', 'message', 'scene_id', 'scene_meta']);
  expect(sent[0].body.scene_id).toBe(feishu.sceneId);
  expect(sent[0].body.scene_meta).toEqual({ scene_label: '飞书 · Channel' });
  expect(sent[0].body.session_id).toBeUndefined();
  // The credential never appears in the prompt the Being is sent.
  expect(String(sent[0].body.message)).not.toContain(CONNECTION.token);
});

it('the two channels get two scenes, and a later status check reuses the same one', async () => {
  const f = await fixture();
  await f.connect();
  f.always('/api/chat/stream', (_url, options) => reply(options, 'registered', '已登记，等待确认。'));
  await f.call('beings:channel-begin', await f.request('feishu'));
  await f.call('beings:channel-begin', await f.request('wechat'));
  await f.call('beings:channel-check', await f.request('feishu'));
  const scenes = f.calls.filter(call => call.path === '/api/chat/stream').map(call => call.body.scene_id);
  expect(scenes[0]).not.toBe(scenes[1]);
  expect(scenes[2]).toBe(scenes[0]);
  expect(f.calls.filter(call => call.path === '/api/chat/stream').map(call => call.body.scene_meta.scene_label))
    .toEqual(['飞书 · Channel', '微信 · Channel', '飞书 · Channel']);
});

it('the scene survives a restart and a rename, and does not disturb the open conversation', async () => {
  // One profile directory across two client lifetimes: the fixture only removes a
  // directory it created itself, so this one outlives the first client.
  const profile = await mkdtemp(path.join(os.tmpdir(), 'channel-restart-test-'));
  const first = await fixture({ directory: profile });
  await first.connect();
  const sessions = (first.extensions as unknown as { chat: any }).chat;
  const active = sessions.snapshot().active;
  first.always('/api/chat/stream', (_url, options) => reply(options, 'connected'));
  await first.call('beings:channel-begin', await first.request('wechat'));
  const scene = first.calls.find(call => call.path === '/api/chat/stream')!.body.scene_id;
  const wechat = first.chat()!.ensureChannel('wechat');
  expect(scene).toBe(wechat.sceneId);
  // 「创建…不改变当前打开的会话」
  expect(sessions.snapshot().active).toBe(active);
  sessions.rename(wechat.sessionId, '我的微信');
  await settle();
  await first.cleanup();
  open.pop();

  // A restart against the same profile directory and the same Being.
  const restarted = await fixture({ directory: profile });
  await restarted.connect();
  restarted.always('/api/chat/stream', (_url, options) => reply(options, 'connected'));
  await restarted.call('beings:channel-begin', await restarted.request('wechat'));
  expect(restarted.calls.find(call => call.path === '/api/chat/stream')!.body.scene_id).toBe(scene);
  const restoredSessions = (restarted.extensions as unknown as { chat: any }).chat;
  expect(restoredSessions.snapshot().sessions.find((session: any) => session.id === wechat.sessionId).title).toBe('我的微信');
  await rm(profile, { recursive: true, force: true });
});

it('another Being gets another set of scenes', async () => {
  const f = await fixture();
  await f.connect();
  f.always('/api/chat/stream', (_url, options) => reply(options, 'connected'));
  await f.call('beings:channel-begin', await f.request('wechat'));
  const first = f.calls.find(call => call.path === '/api/chat/stream')!.body.scene_id;

  await f.connect(OTHER, OTHER_ADDRESS);
  f.always('/api/chat/stream', (_url, options) => reply(options, 'connected'));
  await f.call('beings:channel-begin', await f.request('wechat'));
  const second = f.calls.filter(call => call.path === '/api/chat/stream').at(-1)!.body.scene_id;
  expect(second).not.toBe(first);
});

it('a 202 is reported as pending and nothing is resent', async () => {
  const f = await fixture();
  await f.connect();
  // The Being accepted the request but is busy; docs/channel-sessions.md says the
  // operation is NOT retried and the status is not claimed.
  f.always('/api/chat/stream', () => json({ accepted: true }, 202));
  const result = await f.call('beings:channel-begin', await f.request('feishu'));
  expect(result.status).toBe('pending');
  expect(result.detail).toMatch(/请求已发送给 Being/);
  expect(f.calls.filter(call => call.path === '/api/chat/stream').length).toBe(1);
  // The follow-up status check reuses the same scene rather than opening another.
  const scene = f.calls.find(call => call.path === '/api/chat/stream')!.body.scene_id;
  f.always('/api/chat/stream', (_url, options) => reply(options, 'registered', '已登记。'));
  await f.call('beings:channel-check', await f.request('feishu'));
  expect(f.calls.filter(call => call.path === '/api/chat/stream').at(-1)!.body.scene_id).toBe(scene);
});

it('without a conversation layer the channel refuses instead of inventing a scene', async () => {
  const f = await fixture({ withChat: false });
  await f.connect();
  expect(await f.codeOf('beings:channel-begin', await f.request('feishu'))).toBe('NOT_CONNECTED');
  expect(f.calls.filter(call => call.path === '/api/chat/stream')).toEqual([]);
});
