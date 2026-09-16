// Which `@` in a draft is an address, and which is just a word.
// Ported from BeingDesktop 0.8.26 renderer/town-mentions.js (`memberId`,
// `memberName`, `memberMap`, `resolve`, `unresolvedNotice`); 2026-09-16.
//
// NOT the same thing as `renderer/town/models/mentions.ts`, which belongs to the
// Town unit and projects an id into a display name for reading. This one runs the
// other way, over what the user is typing, and its whole point is that it
// recognizes EXACT IDS ONLY.
//
// The original says why, and it is worth repeating: names belong to a picker, not
// to a local replica of Town's name parser. Guessing that `@Alice` means
// `t_alice_9f` would notify a stranger, and an unrecognized `@word` is left
// exactly as the user typed it — the message still goes, it simply notifies
// nobody, and the composer says so before it is sent.
import type { ChatComposerEntry } from '../../../shared/desktop-types';

const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

/** A Town id already looks like one before any directory is consulted, so a
 * `t_`-prefixed mention resolves even while the member list is unavailable —
 * which is what keeps a reply working on a cold start. */
const TOWN_ID = /^t_[A-Za-z0-9_-]+$/;

export const memberName = (member: { name?: string } | undefined): string => member?.name || '';

export function memberMap(members: readonly ChatComposerEntry[] = []): Map<string, ChatComposerEntry> {
  const result = new Map<string, ChatComposerEntry>();
  for (const member of Array.isArray(members) ? members : []) if (VALID_ID.test(member?.id || '')) result.set(member.id, member);
  return result;
}

export interface ResolvedMentions { text: string; members: string[]; unresolved: string[] }

/**
 * The ids this text notifies, and the `@words` it does not.
 *
 * The boundary characters are the original's: a mention ends at whitespace, at
 * either script's punctuation, or at a bracket. `text` comes back unchanged —
 * nothing is rewritten on the way out, because the bytes the Being and Town see
 * have to be the bytes the user wrote.
 */
export function resolve(text: string, members: readonly ChatComposerEntry[] = []): ResolvedMentions {
  const byId = memberMap(members), mentions = new Set<string>(), unresolved: string[] = [];
  for (const match of String(text || '').matchAll(/(^|\s)@([^\s@/.,!?;:，。！？；：、()[\]{}]{1,100})(?=$|[\s.,!?;:，。！？；：、()[\]{}])/gu)) {
    const query = match[2];
    if (TOWN_ID.test(query) || byId.has(query)) mentions.add(query);
    else unresolved.push(query);
  }
  return { text, members: [...mentions], unresolved: [...new Set(unresolved)] };
}

/** The line the composer shows when a mention will not notify anyone. It is a
 * warning, never a refusal: the message is the user's to send. */
export function unresolvedNotice(text: string, members: readonly ChatComposerEntry[] = []): string {
  const unresolved = resolve(text, members).unresolved;
  return unresolved.length
    ? `未解析提及：${unresolved.map(name => '@' + name).join('、')}；按原文发送，可能不会触发通知。请从候选列表选择完整 Town ID。`
    : '';
}
