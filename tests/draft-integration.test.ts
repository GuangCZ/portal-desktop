// The native composer draft, end to end; 2026-09-16 (integration unit I7).
//
// New. BeingDesktop's equivalent was `prepareLoomDraft` and its `vm` document
// fixture (tests/town-channel-town-catalog.test.ts, before this unit rewrote it);
// what replaced it is a push to the renderer, an answer, and an epoch re-check,
// and this is the file that holds it to BeingDesktop's four promises:
//
//   请先连接 Being。                                   nothing bound, or not verified
//   已有草稿，已保留原文；…                             the composer already holds text
//   会话已变化，请重新选择。                             the identity moved mid-flight
//   对话页面尚未准备好，请稍后重试。                      nobody answered
//
// The fourth is this transport's own: the Loom document either answered
// `executeJavaScript` or raised, while a push to a window that has not mounted
// the conversation simply goes nowhere. Silence must not read as success.
import { afterEach, expect, it } from 'vitest';
import { channelFixture, settle, type ChannelFixture } from './channel-fixture';
import {
  createDraftAcks, createNativeDraft, DRAFT_ACK, DRAFT_PUSH, DRAFT_REFUSED, DRAFT_TIMEOUT_MS,
  requireDraftContext, type NativeDraftContext,
} from '../desktop/main/town/channel/draft';

const open: ChannelFixture[] = [];
afterEach(async () => { while (open.length) await open.pop()!.cleanup(); });
const fixture = async (options?: Parameters<typeof channelFixture>[0]) => {
  const f = await channelFixture(options);
  open.push(f);
  return f;
};

/** One object, because the fence compares the connection by IDENTITY — that is
 * BeingDesktop's own check (src/town.cjs `requireCurrentContext`), and it is the
 * point: a re-parse of the same address is a new binding. */
const BOUND = { url: 'https://echo.beings.town/cz_being/' };
const OTHER = { url: 'https://other.example/being/' };
const context = (patch: Partial<NativeDraftContext> = {}): NativeDraftContext =>
  ({ connection: BOUND, generation: 4, revision: 2, configured: true, status: 'connected', exiting: false, ...patch });

it('pushes one draft on the conversation channel and reports it prepared', async () => {
  const pushes: { channel: string; payload: any }[] = [];
  const acks = createDraftAcks();
  const prepare = createNativeDraft({
    push: (channel, payload: any) => { pushes.push({ channel, payload }); queueMicrotask(() => acks.settle(payload.id, 'placed')); },
    waitAck: (id, ms) => acks.wait(id, ms),
    newId: () => 'draft-1',
    now: () => 1_000,
    timeoutMs: 40,
  });
  expect(await prepare('把这段放进草稿', () => context())).toEqual({ prepared: true });
  expect(pushes).toEqual([{ channel: DRAFT_PUSH, payload: { id: 'draft-1', text: '把这段放进草稿', expiresAt: 1_040 } }]);
  expect(acks.pending).toBe(0);
});

it('refuses without a Being, keeps an existing draft, and refuses a changed session', async () => {
  const pushed: string[] = [];
  let answer: 'placed' | 'occupied' | 'unavailable' = 'placed';
  let current = context();
  const acks = createDraftAcks();
  const prepare = createNativeDraft({
    push: (_channel, payload: any) => { pushed.push(payload.id); queueMicrotask(() => acks.settle(payload.id, answer)); },
    waitAck: (id, ms) => acks.wait(id, ms),
    timeoutMs: 40,
  });
  const run = () => prepare('草稿正文', () => current);

  // 1 · Nothing bound, nothing verified, or already shutting down: refused before
  // anything is pushed. Four different reasons, one sentence — the user's next
  // action is the same for all of them.
  for (const patch of [{ connection: null }, { configured: false }, { status: 'connecting' }, { status: 'error' }, { exiting: true }]) {
    current = context(patch);
    await expect(run()).rejects.toThrow(DRAFT_REFUSED.notConnected);
  }
  expect(pushed).toEqual([]);

  // 2 · The composer already holds the user's own text. The refusal says the
  // original was kept, because that is what the user needs to know.
  current = context();
  answer = 'occupied';
  await expect(run()).rejects.toThrow(DRAFT_REFUSED.occupied);
  expect(pushed.length).toBe(1);

  // 3 · The identity moved while the answer was in flight. It is re-read AFTER
  // the round trip and BEFORE the answer is interpreted, so a draft that landed
  // under the previous Being is reported as a changed session, not a success.
  for (const patch of [{ generation: 5 }, { revision: 3 }, { connection: OTHER }]) {
    current = context();
    answer = 'placed';
    const moved = patch;
    const prepareMoving = createNativeDraft({
      push: (_channel, payload: any) => { queueMicrotask(() => { current = context(moved); acks.settle(payload.id, 'placed'); }); },
      waitAck: (id, ms) => acks.wait(id, ms),
      timeoutMs: 40,
    });
    await expect(prepareMoving('草稿正文', () => current)).rejects.toThrow(DRAFT_REFUSED.changed);
  }
});

it('gives up on an unanswered push rather than reporting success', async () => {
  const acks = createDraftAcks();
  const prepare = createNativeDraft({
    // Nothing settles this one: no window, or a window with no conversation.
    push: () => { /* silence */ },
    waitAck: (id, ms) => acks.wait(id, ms),
    timeoutMs: 20,
  });
  const started = Date.now();
  await expect(prepare('草稿正文', () => context())).rejects.toThrow(DRAFT_REFUSED.unanswered);
  expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  expect(acks.pending).toBe(0);
  // A renderer that answers after the deadline is not an error, and must not
  // resurrect the request.
  expect(acks.settle('anything', 'placed')).toBe(false);
});

it('refuses a prompt that is empty, not a string or past the cap, before pushing', async () => {
  const pushed: unknown[] = [];
  const prepare = createNativeDraft({ push: (_channel, payload) => { pushed.push(payload); }, waitAck: async () => 'placed', timeoutMs: 20 });
  for (const value of [undefined, null, 42, {}, [], '', '  \n\t', 'x'.repeat(32_001)]) {
    await expect(prepare(value, () => context())).rejects.toThrow(/草稿内容无效/);
  }
  expect(pushed).toEqual([]);
});

it('reads the context the way BeingDesktop did, in the same order', () => {
  // A valid context comes back unchanged, and `expected` is the second half of
  // the fence rather than a different check.
  const current = context();
  expect(requireDraftContext(() => current)).toBe(current);
  expect(requireDraftContext(() => current, current)).toBe(current);
  expect(() => requireDraftContext(() => context({ connection: null }), current)).toThrow(DRAFT_REFUSED.notConnected);
  expect(() => requireDraftContext(() => context({ generation: 9 }), current)).toThrow(DRAFT_REFUSED.changed);
});

it('lands in the CURRENT conversation: the shell is asked, never a new session', async () => {
  const f = await fixture();
  await f.connect();
  const before = f.chat()!.ensureChannel('feishu');
  const sessions = (f.extensions as unknown as { chat: { snapshot(): { sessions: unknown[]; active: string } } }).chat;
  const active = sessions.snapshot().active, count = sessions.snapshot().sessions.length;
  // Answer the draft the way a mounted conversation does.
  const draft = f.call('beings:town-draft', { kind: 'pairing' });
  await settle();
  const push = f.drafts().at(-1)!;
  expect(push.payload.text).toMatch(/一次性 Town 配对码/);
  expect(await f.call(DRAFT_ACK, push.payload.id, 'placed')).toEqual({ settled: true });
  expect(await draft).toEqual({ prepared: true });
  // Nothing about the conversation list changed: the draft went into whatever the
  // user is looking at, and no session was created for it.
  expect(sessions.snapshot().active).toBe(active);
  expect(sessions.snapshot().sessions.length).toBe(count);
  expect(f.chat()!.ensureChannel('feishu')).toEqual(before);
});

it('the ack channel refuses ids and verdicts it does not recognise', async () => {
  const f = await fixture();
  await f.connect();
  for (const id of [null, 42, '', {}, 'x'.repeat(201)]) expect(await f.call(DRAFT_ACK, id, 'placed')).toEqual({ settled: false });
  for (const verdict of ['ok', 'PLACED', null, 1, {}]) expect(await f.call(DRAFT_ACK, 'draft-1', verdict)).toEqual({ settled: false });
  // A well-formed answer to a draft nobody is waiting for is not an error either.
  expect(await f.call(DRAFT_ACK, 'draft-1', 'placed')).toEqual({ settled: false });
});

it('the default deadline is the shell’s own composer timeout', () => {
  // renderer/app/models/workspace.ts waits 3s for the same reply on its own path;
  // two timeouts into one composer that disagreed would be a bug in waiting.
  expect(DRAFT_TIMEOUT_MS).toBe(3000);
});
