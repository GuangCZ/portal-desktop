import { describe, expect, it } from 'vitest';
import {
  feedDisplayName, feedMessages, feedReplyAuthor, inboxMessages, mailReply,
} from '../desktop/renderer/town/models/feed';
import { mentionNames } from '../desktop/renderer/town/models/mentions';
import type { TownDesktopDirectMessage, TownDesktopMessage } from '../desktop/shared/desktop-types';

// 2026-09-16: the reply rules of tests/town-identity.test.ts, restated.
//
// That file mixed two subjects — the deleted `main/town/{client,live}.ts` and the
// renderer's feed model — and went away with the modules. Its renderer half did
// not: `mailReply` and `feedReplyAuthor` are still here, rewritten for the
// validated DTOs. The archaeology is what ended (a dozen spellings of "who sent
// this"; the main process now answers that before the message crosses IPC); the
// rules below are the ones it pinned, against the DTOs that replaced the
// envelopes. Where a rule deliberately changed it is marked and argued.
const direct = (overrides: Partial<TownDesktopDirectMessage> = {}): TownDesktopDirectMessage => ({
  id: 'letter', senderId: 't_RiverA', senderName: '河流', content: '你好', createdAt: '2026-09-12T00:00:00Z', ...overrides,
});
const feed = (overrides: Partial<TownDesktopMessage> = {}): TownDesktopMessage => ({
  id: '7', beingId: 't_RiverA', beingName: '河流', content: '篝火', createdAt: '2026-09-12T00:00:00Z',
  revisedAt: '', mentions: [], ...overrides,
});

describe('who a message can be answered to', () => {
  it('keeps display names separate from case-sensitive reply addresses in inbox and sent mail', () => {
    const [incoming, outgoing] = inboxMessages([
      direct({ id: 'dm-in', senderId: 't_RiverA', senderName: '同名 Being', recipientId: 't_Willow', content: '来信' }),
      direct({ id: 'dm-out', senderId: 't_Willow', senderName: '柳树', recipientId: 't_RiverB', recipientName: '同名 Being', content: '发信' }),
    ], { me: 't_Willow' });
    // Two beings share a display name; only the addresses tell them apart.
    expect(incoming).toMatchObject({ author: '同名 Being', authorId: 't_RiverA', received: true, mine: false });
    expect(outgoing).toMatchObject({ recipient: '同名 Being', recipientId: 't_RiverB', mine: true, received: false });
    // An incoming letter is answered to whoever wrote it.
    expect(mailReply(incoming)).toMatchObject({ id: 'dm-in', recipient: 't_RiverA', recipientName: '同名 Being' });
    // A letter of mine continues the conversation with the other end — replying
    // to it must not address me, which Town refuses outright
    // (docs/town-sdk-integration.md「私信与回复」).
    expect(mailReply(outgoing)).toMatchObject({ id: 'dm-out', recipient: 't_RiverB', recipientName: '同名 Being' });
  });

  it('answers the exact Town id and never a differently cased one', () => {
    // Town ids are opaque and case-sensitive (desktop/shared/town-identity.ts).
    const [message] = inboxMessages([direct({ id: 'dm-case', senderId: 't_willow', recipientId: 't_WILLOW' })], { me: 't_Willow' });
    expect(message.mine).toBe(false);
    expect(mailReply(message)?.recipient).toBe('t_willow');
  });

  it('never uses a feed sequence as a private message reply id', () => {
    // A bonfire message has a sequence, an author and no address at all. The
    // inbox composer takes a recipient, so a feed row is not one of its replies.
    const [bonfire] = feedMessages([feed({ id: '7' })], { me: 't_Willow' });
    expect(bonfire.seq).toBe(7);
    expect(mailReply(bonfire)).toBeUndefined();
  });

  it.each([
    ['an id Town cannot address', direct({ id: 'dm/1', recipientId: 't_Willow' })],
    ['an empty id', direct({ id: '', recipientId: 't_Willow' })],
    ['a sender with no usable address', direct({ id: 'dm-2', senderId: '', senderName: '同名 Being' })],
  ])('declines to offer a reply with %s', (_case, message) => {
    const [mapped] = inboxMessages([message], { me: 't_Willow' });
    expect(mailReply(mapped)).toBeUndefined();
  });

  it('declines a letter of mine that Town did not say who it was for', () => {
    // CHANGED from tests/town-identity.test.ts, which fell back to the display
    // name when no Town id came back. Only an address is an address: a display
    // name can name two beings, and Town answers that with NOT_SENT plus
    // candidates rather than a delivery. Offering the reply here would prefill a
    // recipient the send path cannot resolve, so it is not offered.
    const [mine] = inboxMessages([direct({ id: 'dm-3', senderId: 't_Willow', recipientName: '同名 Being' })], { me: 't_Willow' });
    // The name still shows — it says where the letter went — but it is display
    // only, and no reply is offered because there is nothing to address.
    expect(mine).toMatchObject({ mine: true, recipient: '同名 Being', recipientId: '' });
    expect(mailReply(mine)).toBeUndefined();
  });

  it('addresses a letter to me even when Town named no recipient', () => {
    const [message] = inboxMessages([direct({ id: 'dm-4', senderId: 't_RiverA' })], { me: 't_Willow' });
    expect(message).toMatchObject({ received: true, recipient: '我', recipientId: 't_Willow' });
    expect(mailReply(message)?.recipient).toBe('t_RiverA');
  });
});

describe('the author of a quoted parent', () => {
  const names = mentionNames([
    { id: 't_RiverA', name: '河流 (t_RiverA)', description: '' },
    { id: 't_Willow', name: '柳树', description: '' },
  ]);

  it('resolves through the member directory and falls back to the neutral label', () => {
    // The directory is the only name source (docs/interfaces.md §1.2
    // `beings:town-members`); message prose never names anybody.
    expect(feedReplyAuthor({ id: '6', beingId: 't_RiverA', preview: '原帖' }, names)).toBe('河流');
    expect(feedReplyAuthor({ id: '6', beingId: 't_Willow', preview: '原帖' }, names)).toBe('柳树');
    // An id the directory does not know stays anonymous rather than printing raw.
    expect(feedReplyAuthor({ id: '6', beingId: 't_Unknown', preview: '原帖' }, names)).toBe('原消息');
    expect(feedReplyAuthor({ id: '6', beingId: '', preview: '原帖' }, names)).toBe('原消息');
    expect(feedReplyAuthor(undefined, names)).toBe('原消息');
  });

  it('shows an unnamed being as unnamed rather than as its own id twice', () => {
    expect(feedDisplayName('河流', 't_RiverA')).toBe('河流');
    expect(feedDisplayName('t_RiverA', 't_RiverA')).toBe('未命名 Being');
    expect(feedDisplayName('', 't_RiverA')).toBe('未命名 Being');
  });
});
