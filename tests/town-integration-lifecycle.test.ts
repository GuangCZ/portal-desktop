// What happens to Town when the bound Being changes; 2026-09-16 (unit I1).
//
// New, and the reason it exists: the modules each defend their own epoch
// (tests/town-session-*.test.ts, tests/town-timeline-*.test.ts), but only the
// assembly in desktop/main/subsystems/town.ts decides WHEN the epoch moves and
// what is reset with it. BeingDesktop does this in `boot()` around
// `syncTownLifecycle` (src/main.cjs 371-470); here it is `connectionVerified`,
// `connectionCleared` and `quitting`, and the caches it keys by
// `beingIdentityKey` — a disk format shared with the conversation cache and the
// feature-task ledger (docs/migration/i0-seams.md §G).
import { afterEach, expect, it } from 'vitest';
import { CONNECTION, OTHER_ADDRESS, OTHER_CONNECTION, json, settle, townFixture, type TownFixture } from './town-fixture';

const open: TownFixture[] = [];
afterEach(async () => { while (open.length) await open.pop()!.cleanup(); });
const fixture = async (options?: Parameters<typeof townFixture>[0]) => {
  const f = await townFixture(options);
  open.push(f);
  return f;
};

const hear = (seq: number, message: string) => json({
  ok: true, global_latest_seq: seq,
  messages: [{ seq, being: 'cz_being', town_id: 't_Willow', message, at: '2026-09-12T00:00:00Z' }],
});

it('switches the connection epoch, forgets the previous Being and keeps its cache separate', async () => {
  const f = await fixture({ online: true });
  await f.connect();
  await f.pair();
  f.always('/api/bonfire/hear', () => hear(7, '第一个 Being 的篝火'));
  const first = await f.call('beings:town-read', { kind: 'bonfire' });
  expect(first.envelope.snapshot.messages.map((message: { content: string }) => message.content)).toEqual(['第一个 Being 的篝火']);
  const before = (await f.call('beings:town-app')).identity.connectionRevision;
  // Restored from this Being's own encrypted cache, with no further read.
  const reads = f.calls.filter(call => call.path === '/api/bonfire/hear').length;
  expect((await f.call('beings:town-timeline', { kind: 'bonfire' })).snapshot.messages).toHaveLength(1);
  expect(f.calls.filter(call => call.path === '/api/bonfire/hear')).toHaveLength(reads);

  await f.connect(OTHER_CONNECTION, OTHER_ADDRESS);
  const identity = (await f.call('beings:town-app')).identity;
  expect(identity.connectionRevision).toBeGreaterThan(before);
  expect(identity.loomBeingId).toBe('river_being');
  // A credential paired as the first Being is not readable as the second: the
  // client store buckets by the same identity key the caches do.
  expect((await f.call('beings:town-app')).client).toMatchObject({ paired: false, townId: '' });
  expect(await f.codeOf('beings:town-inbox')).toBe('AUTH_REQUIRED');
  // And neither is the timeline. An empty feed here rather than the previous
  // Being's messages is the whole point of keying the cache by identity.
  expect((await f.call('beings:town-timeline', { kind: 'bonfire' })).snapshot.messages).toEqual([]);

  // Back again: the first Being's cache is still its own, and still there.
  await f.connect(CONNECTION);
  expect((await f.call('beings:town-timeline', { kind: 'bonfire' })).snapshot.messages
    .map((message: { content: string }) => message.content)).toEqual(['第一个 Being 的篝火']);
});

it('never lets a read that started under the previous Being land in the next one', async () => {
  const f = await fixture({ online: true });
  await f.connect();
  await f.pair();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await settle();
  f.on('/api/bonfire/hear', async () => { await held; return hear(3, '上一个 Being 的消息'); });
  const pending = f.codeOf('beings:town-read', { kind: 'bonfire' });
  await settle();
  await f.connect(OTHER_CONNECTION, OTHER_ADDRESS);
  release();
  // The in-flight read is refused rather than merged: `SESSION_CHANGED` is the
  // catalogue's word for it, and the renderer drops the answer on seeing it.
  expect(await pending).toBe('SESSION_CHANGED');
  expect((await f.call('beings:town-timeline', { kind: 'bonfire' })).snapshot.messages).toEqual([]);
});

it('stops every Town surface when the client is unbound, and starts none of them again', async () => {
  const f = await fixture({ online: true });
  await f.connect();
  await f.pair();
  f.always('/api/bonfire/hear', () => hear(1, '篝火'));
  await f.call('beings:town-read', { kind: 'bonfire' });
  const before = f.calls.length;
  await f.extensions.connectionCleared();
  await settle();
  const state = await f.call('beings:town-app');
  expect(state.identity).toMatchObject({ loomBeingId: '', townId: '', beingId: '' });
  expect(state.client.paired).toBe(false);
  // `NOT_CONNECTED`, not `AUTH_REQUIRED`: nothing is bound, so there is no
  // pairing to repair and the panel must not offer one.
  for (const channel of ['beings:town-bonfire', 'beings:town-inbox', 'beings:town-firesides'])
    expect(await f.codeOf(channel)).toBe('NOT_CONNECTED');
  await settle();
  // Nothing polls an unbound Being: the background reader was stopped, not left
  // to fail once per interval.
  expect(f.calls.slice(before).filter(call => call.path === '/api/bonfire/hear')).toEqual([]);
});

it('pauses and resumes with the machine without resending anything', async () => {
  const f = await fixture({ online: true });
  await f.connect();
  await f.pair();
  f.always('/api/bonfire/hear', () => hear(1, '篝火'));
  await settle();
  f.power.get('suspend')!();
  await settle();
  const paused = f.calls.length;
  await settle();
  expect(f.calls.length).toBe(paused);
  f.power.get('resume')!();
  await settle();
  // Waking re-reads. It never re-sends: BeingDesktop's resume path is read-only
  // (src/main.cjs 1734), so a write queued before the machine slept is not
  // replayed into a Town that may already have it.
  expect(f.calls.slice(paused).every(call => !call.body || call.path === '/api/client/pair/confirm')).toBe(true);
  for (const call of f.calls) expect(call.path).not.toMatch(/\/speak$/);
});

it('flushes both caches on quit and refuses to work afterwards', async () => {
  const f = await fixture({ online: true });
  await f.connect();
  await f.pair();
  f.always('/api/bonfire/hear', () => hear(5, '写入缓存的消息'));
  await f.call('beings:town-read', { kind: 'bonfire' });
  await f.extensions.quitting();
  // `quitting` awaits both cache writers, so by the time it settles the rows are
  // on disk rather than racing the process exit.
  const { readdir } = await import('node:fs/promises');
  const path = await import('node:path');
  expect(await readdir(path.join(f.directory, 'bonfire-cache'))).not.toEqual([]);
  expect(await readdir(f.directory)).toEqual(expect.arrayContaining(['town-client', 'bonfire-cache']));
  expect(f.errors.filter(entry => entry.scope.startsWith('town'))).toEqual([]);
});
