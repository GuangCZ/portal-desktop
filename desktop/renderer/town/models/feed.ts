import { normalizeTownIdentity } from '../../../shared/town-identity';
import type {
  TownDesktopDirectMessage, TownDesktopMessage, TownDesktopReplyPreview,
} from '../../../shared/desktop-types';
import type { MentionNames } from './mentions';

// The feed's display projection.
//
// REWRITTEN 2026-09-16 for the direct Town client. The previous version read raw
// Town envelopes and had to guess which of a dozen field spellings carried the
// author, the recipient and the reply — `sender_display`, `sender_name`,
// `speaker_name`, `being`, nested objects, and so on. None of that survives: the
// main process validates every message against the DTO in
// desktop/main/town/session/session.ts before it crosses IPC, so the author IS
// `beingName`, the reply IS `replyTo`, and a field that is absent is absent
// because Town did not send it — not because this file looked in the wrong place.
//
// What remains here is the part that is genuinely the renderer's: whether a
// message is mine, addressed to me, or mentions me, and how the list is filtered
// and ordered.

export interface FeedFilters {
  relation: string;
  order: string;
  days: string;
  author: string;
}

export interface FeedReply {
  id: string | number;
  author: string;
  preview: string;
  recipient?: string;
  recipientName?: string;
}

export const newFeedFilters = (): FeedFilters => ({
  relation: 'all',
  order: 'newest',
  days: 'all',
  author: '',
});

export interface FeedMessage {
  /** Stable key. Town's sequence for a feed, its message id for a direct message. */
  id: string;
  /** The numeric parent a reply would address. 0 when this feed has none. */
  seq: number;
  index: number;
  authorId: string;
  author: string;
  recipient: string;
  recipientId: string;
  content: string;
  mentioned: boolean;
  mine: boolean;
  received: boolean;
  related: boolean;
  rawDate: string;
  time: number;
  revised: boolean;
  via: string;
  replyTo?: TownDesktopReplyPreview;
}

const time = (value: string) => Date.parse(value);

/** Bonfire and fireside. `me` is the paired profile's Town id, empty when unpaired. */
export function feedMessages(messages: readonly TownDesktopMessage[], options: { me: string }): FeedMessage[] {
  const me = normalizeTownIdentity(options.me);
  return messages.map((message, index) => {
    const authorId = (message.townId || message.beingId || '').trim();
    // Town resolves the mention list server-side. When it sent one, that list is
    // the answer; only a feed that carried none falls back to reading the text,
    // and then only for exact `@id` tokens.
    const mentioned = Boolean(me && (message.mentions?.length
      ? message.mentions.some(id => normalizeTownIdentity(id) === me)
      : [...message.content.matchAll(/@([a-zA-Z0-9_-]+)/g)].some(match => normalizeTownIdentity(match[1]) === me)));
    const mine = Boolean(me && normalizeTownIdentity(authorId) === me);
    return {
      id: message.id,
      seq: Number.isSafeInteger(Number(message.id)) ? Number(message.id) : 0,
      index,
      authorId,
      author: message.beingName || authorId || '未知',
      recipient: '', recipientId: '',
      content: message.content,
      mentioned, mine, received: false, related: mentioned || mine,
      rawDate: message.createdAt,
      time: time(message.createdAt),
      revised: Boolean(message.revisedAt),
      via: message.via || '',
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    };
  });
}

/** The inbox. Town's `/api/messages` returns both directions; `senderId` is the
 * only address either way, so a message not from me is one to me. */
export function inboxMessages(messages: readonly TownDesktopDirectMessage[], options: { me: string }): FeedMessage[] {
  const me = normalizeTownIdentity(options.me);
  return messages.map((message, index) => {
    const authorId = (message.senderId || '').trim();
    const mine = Boolean(me && normalizeTownIdentity(authorId) === me);
    return {
      id: message.id,
      seq: 0,
      index,
      authorId,
      author: message.senderName || authorId || '未知',
      recipient: mine ? '' : '我',
      recipientId: mine ? '' : options.me,
      content: message.content,
      mentioned: false,
      mine,
      received: !mine,
      related: true,
      rawDate: message.createdAt,
      time: time(message.createdAt),
      revised: false,
      via: message.via || '',
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    };
  });
}

/** The quoted parent's author, through the member directory. A Town id the
 * directory does not know stays anonymous rather than being printed raw. */
export function feedReplyAuthor(reply: TownDesktopReplyPreview | undefined, names: MentionNames): string {
  const name = reply?.beingId ? names.get(reply.beingId)?.name : '';
  return name || '原消息';
}

export const feedDisplayName = (name: string, id: string) =>
  !name || (name === id && id.startsWith('t_')) ? '未命名 Being' : name;

/** The reply a direct message can be answered with. Only a Town id is a usable
 * address — a display name is not unique, and Town resolves the ambiguity by
 * refusing (docs/town-sdk-integration.md「私信与回复」). */
export function mailReply(message: FeedMessage): FeedReply | undefined {
  const recipient = message.mine ? message.recipientId : message.authorId;
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(message.id) || !recipient || !/^[a-zA-Z0-9_-]{1,160}$/.test(recipient)) return;
  const author = feedDisplayName(message.author, message.authorId);
  return {
    id: message.id,
    author,
    preview: message.content.slice(0, 500),
    recipient,
    recipientName: message.mine ? feedDisplayName(message.recipient, message.recipientId) : author,
  };
}

export function filterMessages(messages: FeedMessage[], filters: FeedFilters, search: string) {
  const query = search.trim().toLowerCase();
  const cutoff = filters.days === 'all' ? -Infinity : Date.now() - Number(filters.days) * 86400000;
  return messages
    .filter(message =>
      (filters.relation === 'all'
        || (filters.relation === 'about' && message.related)
        || (filters.relation === 'mentions' && message.mentioned)
        || (filters.relation === 'mine' && message.mine))
      && (!filters.author || (message.authorId || message.author) === filters.author)
      && (cutoff === -Infinity || (Number.isFinite(message.time) && message.time >= cutoff))
      && (!query || [message.author, message.authorId, message.recipient, message.content].join(' ').toLowerCase().includes(query)))
    .sort((a, b) => {
      const delta = (Number.isFinite(a.time) ? a.time : 0) - (Number.isFinite(b.time) ? b.time : 0);
      const tie = a.seq - b.seq || a.index - b.index;
      return (delta || tie) * (filters.order === 'newest' ? -1 : 1);
    });
}
