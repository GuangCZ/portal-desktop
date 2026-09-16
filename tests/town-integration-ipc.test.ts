// Town's IPC surface as the renderer meets it; 2026-09-16 (integration unit I1).
//
// New. BeingDesktop registers these handlers inline in src/main.cjs (lines
// 1256-1372) and has no test that calls them as channels; the modules behind them
// are covered file by file (tests/town-session-*.test.ts,
// tests/town-timeline-*.test.ts, tests/town-channel-*.test.ts). What is asserted
// here is the seam those files cannot reach: the registered channel set, the
// argument validation that happens at the boundary, the error-code envelope, and
// the connection epoch a send is fenced against.
//
// It replaces the deleted tests/town-ipc.test.ts, which asserted the same four
// things about the nine channels of the Town layer decision §5.1 removed.
import { afterEach, expect, it } from 'vitest';
import { FOREIGN_TOWN_CHANNELS, PLAIN_CHANNELS, TOWN_CHANNELS, townFixture, type TownFixture } from './town-fixture';
import { json, settle } from './town-fixture';

const open: TownFixture[] = [];
afterEach(async () => { while (open.length) await open.pop()!.cleanup(); });
const fixture = async (options?: Parameters<typeof townFixture>[0]) => {
  const f = await townFixture(options);
  open.push(f);
  return f;
};

it('registers the documented channel set and answers nobody but the shell', async () => {
  const f = await fixture();
  expect([...f.handlers.keys()].filter(channel => channel.startsWith('beings:town') && !FOREIGN_TOWN_CHANNELS.has(channel))).toEqual(TOWN_CHANNELS);
  // The two catalogue channels are the survivors of the deleted town/ipc.ts; the
  // nine private ones it also registered (`townLive`, `reconnectTown`, `sendTown`,
  // `townAuth`, `pairTown`, `autoPairTown`, `cancelTownPair`, `saveTownToken`,
  // `onTownLive`) are gone rather than renamed.
  for (const gone of ['beings:town-live', 'beings:town-send', 'beings:town-auth', 'beings:town-pair', 'beings:town-save-token'])
    expect(f.handlers.has(gone)).toBe(false);
  for (const channel of TOWN_CHANNELS)
    await expect(f.untrusted(channel)).rejects.toThrow();
});

it('reports every failure as a catalogue code rather than a sentence', async () => {
  const f = await fixture();
  await f.connect();
  // Nothing is paired, so every authenticated surface answers the one code the
  // pairing panel branches on. A sentence could not be branched on at all.
  for (const channel of ['beings:town-bonfire', 'beings:town-inbox', 'beings:town-firesides', 'beings:town-scrolls'])
    expect(await f.codeOf(channel)).toBe('AUTH_REQUIRED');
  // The member directory is the exception, and deliberately: Town's public
  // homepage carries it, so names render before this client has a credential —
  // which is what lets an unpaired page show 「@河流」 rather than 「@t_River」
  // (desktop/main/town/session/session.ts `getMembers`).
  const directory = await f.call('beings:town-members');
  expect(directory.members).toEqual([{ id: 't_River', name: '河流', description: '' }]);
  expect(f.calls.find(call => call.path === '/api')!.headers).not.toHaveProperty('Authorization');
  expect(await f.codeOf('beings:town-speak', { kind: 'bonfire', content: '你好', connectionRevision: 1 })).toBe('AUTH_REQUIRED');
  // And the envelope is an envelope, not a rejection: a thrown Error would arrive
  // with its `code` stripped (desktop/shared/town-desktop-errors.ts).
  const envelope = await f.invoke('beings:town-inbox');
  expect(envelope).toMatchObject({ __townError: true, code: 'AUTH_REQUIRED' });
  expect(typeof (envelope as { message: string }).message).toBe('string');
});

it('refuses a read selector it does not recognise, field by field', async () => {
  const f = await fixture();
  await f.connect();
  const before = f.calls.length;
  for (const request of [
    undefined,
    'bonfire',
    { kind: 'inbox' },
    { kind: 'bonfire', firesideId: '1', selectionRevision: 1 },
    { kind: 'bonfire', includeRooms: true },
    { kind: 'fireside', firesideId: '1', selectionRevision: -1 },
    { kind: 'fireside', firesideId: '1', selectionRevision: 1.5 },
    { kind: 'fireside', firesideId: '1', includeRooms: 'yes' },
    { kind: 'bonfire', limit: 10 },
    JSON.parse('{"kind":"bonfire","__proto__":{"polluted":true}}'),
    Object.defineProperty({ kind: 'bonfire' }, 'firesideId', { get: () => '1', enumerable: true, configurable: true }),
  ]) expect(await f.codeOf('beings:town-read', request)).toBe('INVALID_REQUEST');
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  // None of them reached the network: an argument this layer does not understand
  // is refused here, not turned into a request nobody can explain.
  expect(f.calls.length).toBe(before);
});

it('refuses a send whose envelope does not match its kind', async () => {
  const f = await fixture();
  await f.connect();
  const before = f.calls.length;
  for (const request of [
    undefined,
    { kind: 'scroll', content: 'x', connectionRevision: 1 },
    { kind: 'bonfire', content: 'x' },
    { kind: 'bonfire', content: 'x', connectionRevision: '1' },
    { kind: 'bonfire', content: 'x', connectionRevision: -1 },
    { kind: 'bonfire', content: 'x', connectionRevision: 1, recipient: 'river' },
    { kind: 'dm', recipient: 'river', content: 'x', connectionRevision: 1, mentions: [] },
    { kind: 'fireside', firesideId: '1', content: 'x', connectionRevision: 1, recipient: 'river' },
  ]) expect(await f.codeOf('beings:town-speak', request)).toBe('INVALID_REQUEST');
  expect(f.calls.length).toBe(before);
});

it('refuses a send composed under a connection that has since changed', async () => {
  const f = await fixture();
  await f.connect();
  const revision = (await f.call('beings:town-app')).identity.connectionRevision;
  expect(revision).toBeGreaterThan(0);
  await f.pair();
  const before = f.calls.length;
  // The composer always knows which revision it was showing. One that is not the
  // live one is refused before anything is sent — the addition over BeingDesktop
  // noted at `beings:town-speak`, applied to all three kinds.
  for (const request of [
    { kind: 'bonfire', content: '你好', connectionRevision: revision + 1 },
    { kind: 'fireside', firesideId: '12', content: '你好', connectionRevision: revision + 1 },
    { kind: 'dm', recipient: 't_River', content: '你好', connectionRevision: revision + 1 },
  ]) expect(await f.codeOf('beings:town-speak', request)).toBe('SESSION_CHANGED');
  expect(f.calls.length).toBe(before);
});

it('pairs with six characters, and never spends a code it could not have used', async () => {
  const f = await fixture();
  await f.connect();
  expect((await f.call('beings:town-app')).client).toMatchObject({ paired: false, status: 'unpaired' });
  const before = f.calls.length;
  for (const request of [
    undefined, { code: undefined }, { code: '' }, { code: 'ABC' }, { code: 'ABCDEFG' },
    { code: 'K7M2N!' }, { code: { code: 'K7M2N4' } }, { code: 'K7M2N4', beingId: 't_Willow' },
  ]) expect(await f.codeOf('beings:town-client-pair', request)).toBe('INVALID_REQUEST');
  expect(f.calls.length).toBe(before);

  const state = await f.pair('k7m2n4');
  // Lower case is accepted and upper-cased; the code goes up exactly once.
  const confirm = f.calls.filter(call => call.path === '/api/client/pair/confirm');
  expect(confirm).toHaveLength(1);
  expect(confirm[0].body).toMatchObject({ code: 'K7M2N4' });
  expect(state).toMatchObject({ paired: true, townId: 't_Willow' });
  // No credential crosses the boundary, in either direction.
  expect(JSON.stringify(state)).not.toContain('a'.repeat(64));
  expect((await f.call('beings:town-app')).client.paired).toBe(true);
});

it('forgets a pairing locally and reports the client unpaired again', async () => {
  const f = await fixture();
  await f.connect();
  await f.pair();
  const state = await f.call('beings:town-client-forget');
  expect(state).toMatchObject({ paired: false, status: 'unpaired' });
  expect((await f.call('beings:town-app')).client.paired).toBe(false);
  expect(await f.codeOf('beings:town-inbox')).toBe('AUTH_REQUIRED');
});

it('reads the inbox over the client token once paired, and pushes no message body', async () => {
  const f = await fixture();
  await f.connect();
  await f.pair();
  f.on('/api/messages', () => json({
    ok: true,
    messages: [{ id: 'letter-1', sender_town_id: 't_River', sender_display_name: '河流', content: '你好', created_at: '2026-09-12T00:00:00Z' }],
  }));
  const inbox = await f.call('beings:town-inbox');
  expect(inbox.messages).toHaveLength(1);
  expect(inbox.messages[0]).toMatchObject({ id: 'letter-1', senderId: 't_River', content: '你好' });
  const read = f.calls.filter(call => call.path === '/api/messages').at(-1)!;
  expect(read.headers.Authorization).toBe('Bearer ' + 'a'.repeat(64));
  // The private body is answered to the caller and never broadcast: every push on
  // the messages channel is either a timeline or the payload-free inbox hint.
  for (const push of f.pushes.filter(push => push.channel === 'beings:town-messages'))
    expect(JSON.stringify(push.payload)).not.toContain('你好');
});

it('keeps the public catalogue anonymous and opens only the allowed Town links', async () => {
  const f = await fixture();
  await f.connect();
  f.on('/api/embers', () => json({ scrolls: [] }));
  const before = f.calls.length;
  const result = await f.call('beings:town', { kind: 'embers' });
  expect(result).toMatchObject({ ok: true });
  const request = f.calls.slice(before).find(call => call.path === '/api/embers')!;
  expect(Object.keys(request.headers)).toEqual(['Accept']);
  // The catalogue channels are outside the envelope: they answer `TownResult`,
  // which carries its own `ok`/`code`, and a contract error is a rejection.
  expect(PLAIN_CHANNELS.has('beings:town')).toBe(true);
  await expect(f.invoke('beings:town', { kind: 'inbox' })).rejects.toThrow();
  await f.call('beings:town-open', '/embers/story-7');
  expect(f.opened).toEqual(['https://beings.town/embers/story-7']);
  for (const route of ['/api/messages', 'https://elsewhere.example/', '/embers/../api/messages', 7])
    await expect(f.invoke('beings:town-open', route)).rejects.toThrow();
  expect(f.opened).toHaveLength(1);
});

it('P1 identity keeps the Loom name, the verified Town ID and the display name separate across IPC', async () => {
  // Ported from tests/town-channel-p1-identity.test.ts, which asserted this of
  // `TownController.state()`. That module went with decision §5.2; the identity
  // triple it carried is now built in desktop/main/subsystems/town.ts and reaches
  // the renderer through `beings:town-app`, so the rule is asserted there.
  // See docs/p1-town-identity-mentions-2026-09-15.md: three fields, never collapsed.
  const f = await fixture();
  await f.connect();
  const unpaired = structuredClone(await f.call('beings:town-app')).identity;
  expect(unpaired).toMatchObject({ loomBeingId: 'cz_being', townId: '', beingId: 'cz_being', sendAs: 'cz_being' });
  f.on('/api/client/pair/confirm', () => json({ ok: true, token: 'a'.repeat(64), town_id: 't_IzYOPP3G0ABJuK2M', display: 'Neuromancer' }));
  await f.call('beings:town-client-pair', { code: 'K7M2N4' });
  // structuredClone stands in for the IPC boundary, exactly as the original did.
  const identity = structuredClone(await f.call('beings:town-app')).identity as Record<string, unknown>;
  expect(identity.loomBeingId).toBe('cz_being');
  expect(identity.townId).toBe('t_IzYOPP3G0ABJuK2M');
  expect(identity.displayName).toBe('Neuromancer');
  // `sendAs` was `'being'` while sends went through a Being turn. The direct
  // client speaks as itself, so it is the verified Town ID — and in neither case
  // is it the Loom name.
  expect(identity.sendAs).toBe('t_IzYOPP3G0ABJuK2M');
  expect(identity.sendAs).not.toBe(identity.loomBeingId);
  expect(identity.beingId).toBe('t_IzYOPP3G0ABJuK2M');
});

it('invalidates the directory on a rename and leaves the feeds exactly where they were', async () => {
  const f = await fixture({ online: true });
  await f.connect();
  await f.pair();
  const hear = json({
    ok: true, global_latest_seq: 9,
    messages: [{ seq: 9, being: 'cz_being', town_id: 't_Willow', message: '改名前后都在的一句', at: '2026-09-12T00:00:00Z' }],
  });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  f.on('/api/bonfire/hear', async () => { await held; return hear; });
  const pending = f.call('beings:town-read', { kind: 'bonfire' });
  await settle();

  // A rename lands while that read is in flight. `identityRevision` is part of the
  // identity TownBackground and TownRefresh fence against — raise it here and the
  // read above is refused with SESSION_CHANGED on arrival
  // (town/channel/town-background.ts line 258), the accumulated timeline is
  // dropped (town/timeline/refresh.ts line 533) and the bonfire reader is stopped
  // and reset on the next lifecycle sync (town-background.ts line 163).
  // BeingDesktop does not raise it in `invalidateTownMembers` (src/main.cjs line
  // 455) and neither does this: a rename changes names, not feeds.
  const before = (await f.call('beings:town-app')).identity.identityRevision;
  await f.call('beings:town-profile-changed');
  await settle();
  release();

  const envelope = await pending;
  expect(envelope.envelope.snapshot.messages.map((message: { content: string }) => message.content))
    .toEqual(['改名前后都在的一句']);
  const after = await f.call('beings:town-app');
  expect(after.identity.identityRevision).toBe(before);
  expect(after.sync.bonfire.lastSuccessAt).toBeGreaterThan(0);
  expect((await f.call('beings:town-timeline', { kind: 'bonfire' })).snapshot.messages).toHaveLength(1);

  // What the channel IS for still happens: the directory is invalidated and every
  // consumer is told, so the names are re-read while the messages stay put.
  expect(f.pushes.some(push => push.channel === 'beings:town-members-invalidated')).toBe(true);
});
