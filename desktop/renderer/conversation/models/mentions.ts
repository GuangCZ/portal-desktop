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

// ── the other direction: reading ─────────────────────────────────────────────
// Everything above decides what an `@` in a DRAFT costs. What follows projects an
// `@id` in a FINISHED message into the name behind it, and is the port of
// BeingDesktop 0.8.26 renderer/town-mentions.js `displayText` (line 33), applied
// by renderer/chat-app.js line 102 to every text node of a rendered message.
//
// Display only, and the word is load-bearing: `view.rows` and `sent` keep the
// bytes the Being and Town saw, and only what is painted changes. 0.8.26 pins
// that with its own assertion (test/chat-composer-ui.cjs line 100), because a
// transcript that rewrote history would make the message the user can read a
// different message from the one that was sent.

const CONTROL = /[\x00-\x1f\x7f‪-‮⁦-⁩]/g;
/** A display name arrives from Town, is written by its owner, and lands between
 * the user's own words. Bidirectional overrides are removed with the control
 * characters: a name is allowed to be anything except a way to reorder the
 * sentence around it. */
const clean = (value: unknown, limit = 100): string =>
  typeof value === 'string' ? value.replace(CONTROL, '').slice(0, limit) : '';

/** The directory as the transcript reads it: id → the name to paint.
 *
 * Built once per directory rather than once per message. A conversation is long,
 * a member list is not, and `displayText` runs over every text node of every
 * bubble on every repaint. */
export function displayNames(members: readonly ChatComposerEntry[] = []): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const [id, member] of memberMap(members)) {
    const name = clean(memberName(member));
    // A name that is just the id again says nothing, and painting it would only
    // replace `@t_abc` with a second copy of itself.
    if (name && name !== id && name !== '@' + id) names.set(id, name);
  }
  return names;
}

/**
 * `@<id>` becomes `@<name>`, for reading.
 *
 * The regex is 0.8.26's, including the first alternative that exists only to be
 * thrown away: a URL is consumed whole so that `https://example.invalid/@t_x`
 * keeps its address. The rest requires the `@` to open a word — start of text, or
 * whitespace or an opening bracket/punctuation in either script — and to close on
 * one, which is what keeps an e-mail address and `a@b` out of it.
 *
 * An id the directory does not know is left exactly as written. Guessing is the
 * one thing this must not do: the id IS the address, and a wrong name here would
 * tell the reader they are talking to somebody they are not.
 */
export function displayText(
  text: string,
  members: readonly ChatComposerEntry[] | ReadonlyMap<string, string> = [],
): string {
  const names = members instanceof Map ? members : displayNames(members as readonly ChatComposerEntry[]);
  if (!names.size) return String(text ?? '');
  return String(text ?? '').replace(
    /(?:https?:\/\/|mailto:)\S+|(^|[\s，。！？；：、（【“‘(\[{])@([A-Za-z0-9][A-Za-z0-9_-]{0,99})(?=$|[\s.,!?;:，。！？；：、()\[\]{}）】”’])/gu,
    (whole: string, before: string | undefined, id: string | undefined) => {
      const name = id ? names.get(id) : '';
      return name ? before + '@' + name : whole;
    },
  );
}
