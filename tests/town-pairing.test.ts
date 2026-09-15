import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseConnection } from '../desktop/main/chat/connection';
import { requestTownPairCode } from '../desktop/main/town/pairing';
import { registerTownIpc } from '../desktop/main/town/ipc';
import { TownClient, TownCredentials } from '../desktop/main/town/client';
import { TownLive } from '../desktop/main/town/live';
import type { SettingsStore } from '../desktop/main/app/settings';

const connection = parseConnection('https://fixture.test/willow/?token=loom-private-fixture');
const requestId = '11111111-2222-4333-8444-555555555555';
const event = (type: string, data: unknown) => `event: ${type}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
function stream(source: string, cancel = vi.fn()) {
  return new Response(new ReadableStream({ start(controller) {
    // Exercise CRLF and UTF-8 split at every possible byte boundary.
    for (const byte of new TextEncoder().encode(source)) controller.enqueue(Uint8Array.of(byte));
  }, cancel }), { headers: { 'Content-Type': 'text/event-stream' } });
}
const reply = () => stream(event('text', { text: 'AB3' }) + event('content_block_delta', { delta: { type: 'text_delta', text: 'XY9' } }) + event('message_stop', {}));
const confirmed = () => Response.json({ ok: true, token: 'town-private-fixture', town_id: 't_WillowFull', display: '柳树 (t_Willow)' });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

describe('SDK 284bef4 automatic pairing via authenticated chat', () => {
  it('reads split assistant text, ignores tool/metadata decoys, and closes the dedicated stream', async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn(async () => stream(event('meta', { text: 'BAD123' }) + event('tool_result', { content: 'TOOL99' }) + event('thinking', { text: 'THINK9' }) + event('text', { text: '配对码：AB3' }) + event('content_block_delta', { delta: { text: 'XY9' } }) + event('message_stop', {}), cancel));
    expect(await requestTownPairCode(connection, requestId, new AbortController().signal, fetcher as typeof fetch)).toBe('AB3XY9');
    const [url, init] = (fetcher.mock.calls as unknown as [string, RequestInit][])[0];
    expect(url).toBe('https://fixture.test/willow/api/chat/stream?token=loom-private-fixture');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error' });
    expect(new Headers(init.headers).has('authorization')).toBe(false);
    expect(JSON.parse(String(init.body))).toMatchObject({ session_id: 'town-pair-' + requestId, scene_id: 'town-pair-' + requestId, scene_meta: { client: 'being-desktop', scene_label: 'Town 配对' } });
    expect(JSON.parse(String(init.body)).chat_id).toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it.each([
    event('text', { text: 'AB3XY9' }) + event('text', { text: 'MORE' }),
    event('text', { text: 'AB3XY9 或 CD4YZ8' }),
    event('tool_result', { text: 'AB3XY9' }),
    event('text', { text: 'AB3' }) + event('message_stop', {}) + event('text', { text: 'XY9' }),
  ])('does not confirm a prefix, ambiguous reply or tool output', async source => {
    await expect(requestTownPairCode(connection, requestId, new AbortController().signal, async () => stream(source + event('message_stop', {}) + event('done', {})))).rejects.toThrow('唯一');
  });
  it('waits across a yielded reply while the Being obtains the code', async () => {
    const source = event('text', { text: '正在获取配对码。' }) + event('message_stop', {})
      + event('tool_result', { text: 'BAD123' }) + event('text', { text: 'AB3XY9' }) + event('message_stop', {});
    await expect(requestTownPairCode(connection, requestId, new AbortController().signal, async () => stream(source))).resolves.toBe('AB3XY9');
  });
  it('accepts a default message event and an EOF without a final blank line', async () => {
    const response = new Response('data: {"text":"AB3XY9"}', { headers: { 'Content-Type': 'text/event-stream' } });
    await expect(requestTownPairCode(connection, requestId, new AbortController().signal, async () => response)).resolves.toBe('AB3XY9');
  });
  it('aborts a stalled read and never exposes an authenticated URL in an error', async () => {
    const controller = new AbortController(), cancel = vi.fn();
    const pending = requestTownPairCode(connection, requestId, controller.signal, async () => stream('', cancel));
    await new Promise(resolve => setTimeout(resolve, 0));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
    await expect(requestTownPairCode(connection, requestId, new AbortController().signal, async () => { throw new Error(connection.link); })).rejects.toThrow('无法读取 Being 配对回复');
  });
});

async function fixture(options: { chat?: typeof fetch; confirm?: typeof fetch; timeout?: number; exclusive?: <T>(operation: () => Promise<T>) => Promise<T> } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'town-auto-pair-'));
  const storage = { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(text), decryptString: (value: Buffer) => value.toString() };
  const credentials = new TownCredentials(directory, storage);
  const chat = vi.fn(options.chat || (async () => reply()));
  const confirm = vi.fn(options.confirm || (async () => confirmed()));
  const town = new TownClient(() => credentials.token, confirm as typeof fetch);
  const live = new TownLive(() => credentials.token, () => credentials.beingId, () => {});
  const restart = vi.spyOn(live, 'restart').mockImplementation(() => {});
  const store = { connection: { ...connection }, settings: { being: 'willow' } } as SettingsStore;
  const handlers = new Map<string, (...args: any[]) => any>();
  const dispose = registerTownIpc({ handle: (name, handler) => { handlers.set(name, handler); }, exclusive: options.exclusive || (operation => operation()),
    town, townLive: live, townCredentials: credentials, store, secretStorage: storage, fetcher: chat as typeof fetch,
    pairTimeoutMs: options.timeout, getWarning: () => undefined, clearWarning: vi.fn(), open: vi.fn() });
  cleanups.push(async () => { dispose(); live.dispose(); await rm(directory, { recursive: true, force: true }); });
  const start = () => handlers.get('beings:town-auto-pair')!({ requestId, beingId: 'willow' });
  const cancel = () => handlers.get('beings:town-pair-cancel')!(requestId);
  return { credentials, chat, confirm, store, restart, handlers, start, cancel, dispose };
}

describe('automatic pairing IPC ownership', () => {
  it('confirms exactly once without Loom credentials and persists only the confirmed Town identity', async () => {
    const f = await fixture();
    await expect(f.start()).resolves.toBeUndefined();
    expect(f.confirm).toHaveBeenCalledOnce();
    const [url, init] = (f.confirm.mock.calls as unknown as [string, RequestInit][])[0];
    expect(url).toBe('https://beings.town/api/client/pair/confirm');
    expect(JSON.parse(String(init.body))).toEqual({ being_id: 'willow', code: 'AB3XY9' });
    expect(new Headers(init.headers).has('authorization')).toBe(false);
    expect(f.credentials).toMatchObject({ token: 'town-private-fixture', beingId: 't_WillowFull', display: '柳树 (t_Willow)' });
    expect(f.restart).toHaveBeenCalledOnce();
    expect(f.handlers.get('beings:town-auth')!()).toMatchObject({ chatBeing: 'willow', pairedBeingId: 't_WillowFull' });
  });
  it('rejects absent or changed chat identity before sending anything', async () => {
    const f = await fixture();
    f.store.connection = null;
    await expect(f.start()).rejects.toThrow('先连接');
    f.store.connection = parseConnection('https://fixture.test/river/?token=other-fixture');
    await expect(f.start()).rejects.toThrow('Being 已改变');
    expect(f.chat).not.toHaveBeenCalled();
  });
  it('cancels waiting without blocking other IPC or starting a duplicate request', async () => {
    const f = await fixture({ chat: async () => stream('') });
    const first = f.start();
    const failed = expect(first).rejects.toThrow('取消');
    await expect(f.start()).rejects.toThrow('正在配对');
    expect(f.handlers.get('beings:town-auth')!().configured).toBe(false);
    expect(f.cancel()).toBe(true);
    await failed;
    expect(f.confirm).not.toHaveBeenCalled();
  });
  it('has a real deadline even when the stream never emits another byte', async () => {
    const f = await fixture({ chat: async () => stream(''), timeout: 20 });
    await expect(f.start()).rejects.toThrow('90 秒');
    expect(f.confirm).not.toHaveBeenCalled();
  });
  it('discards a late confirmation after cancel or a Being change', async () => {
    for (const mode of ['cancel', 'change']) {
      let resolve!: (response: Response) => void;
      const f = await fixture({ confirm: () => new Promise(done => { resolve = done; }) });
      const first = f.start();
      const failed = expect(first).rejects.toThrow(mode === 'cancel' ? '取消' : '身份已改变');
      await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce());
      if (mode === 'cancel') f.cancel();
      else f.store.connection = parseConnection('https://fixture.test/river/?token=other-fixture');
      resolve(confirmed());
      await failed;
      expect(f.credentials.token).toBe('');
      expect(f.restart).not.toHaveBeenCalled();
    }
  });
  it('rechecks cancellation before a queued credential save', async () => {
    let commit!: () => Promise<void>;
    const f = await fixture({ exclusive: operation => new Promise((resolve, reject) => { commit = async () => { try { resolve(await operation()); } catch (error) { reject(error); } }; }) });
    const first = f.start();
    const failed = expect(first).rejects.toThrow('取消');
    await vi.waitFor(() => expect(commit).toBeTypeOf('function'));
    f.cancel(); await commit(); await failed;
    expect(f.credentials.token).toBe('');
  });
});
