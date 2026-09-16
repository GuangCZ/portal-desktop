// How one conversation is laid out: durable rows, the transient tail, and the
// grouping Loom's page used. Ported line for line from BeingDesktop 0.8.26
// renderer/chat-app.js (`epoch`, `clock`, `interleave`, and the `render` loop's
// grouping); 2026-09-16. Protocol notes behind the `after` field:
// docs/desktop-message-layer.md §八「暂存项与历史行的对齐」.
//
// Pure by design — no DOM, no React — so the ordering rules can be tested
// against the fixtures without a renderer.
import type {
  ChatLiveReply, ChatRow, ChatRowImage, ChatView,
} from '../../../shared/desktop-types';

/** Loom's grouping rules: the same speaker within a minute shares one meta line;
 * more than five minutes of silence gets a divider (chat-app.js line 22). */
export const GROUP_MS = 60000, GAP_MS = 300000;

export const epoch = (at?: string | number): number => {
  const value = new Date(at || '').getTime();
  return Number.isNaN(value) ? 0 : value;
};

/** `13:44:23`, matching the meta line Desktop drew under Loom's theme. An
 * unparsable timestamp draws nothing rather than `Invalid Date`. */
export const clock = (at?: string | number): string => {
  const value = epoch(at);
  return value ? new Date(value).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
};

export interface TranscriptItem {
  /** Stable across renders for one projection: `row-<seq>`, `sent-<n>`, `replied-<n>`, `live`.
   * Not called `key`: `interleave` uses that name for its numeric sort position,
   * exactly as BeingDesktop does. */
  id: string;
  role: 'user' | 'being';
  text: string;
  at: string;
  seq?: number;
  after?: number;
  pending?: boolean;
  partial?: boolean;
  live?: boolean;
  think?: string;
  images?: ChatRowImage[];
  /** Filled by `group`: this bubble shares the previous one's meta line. */
  consecutive?: boolean;
  /** Filled by `group`: draw `— hh:mm:ss —` above this bubble. */
  gap?: string;
}

interface Placed { at?: string; after?: number }

/**
 * Newest at the bottom. Durable rows keep their `seq` order; a transient item
 * goes after every row that already existed when it was made (`after`, so a
 * skewed clock cannot lift it above them), then in time order among the rows
 * that landed since — an unconfirmed reply sits where it was spoken, not under
 * whatever came later (chat-app.js line 400).
 */
export function interleave<R extends { seq?: number; at?: string }, T extends Placed>(
  rows: readonly R[], transient: readonly T[],
): ((R | T) & { key: number })[] {
  const place = (item: Placed) => {
    const at = epoch(item.at);
    let index = 0;
    while (index < rows.length && Number.isFinite(rows[index].seq) && (rows[index].seq as number) <= (item.after || 0)) index++;
    while (index < rows.length && (!at || epoch(rows[index].at) <= at)) index++;
    return index - 0.5;
  };
  return [
    ...rows.map((row, index) => ({ ...row, key: index })),
    ...transient.map(item => ({ ...item, key: place(item) })),
  ].sort((left, right) => left.key - right.key || epoch(left.at) - epoch(right.at));
}

/** Everything one conversation shows, in order. `live` is passed separately
 * because the renderer accumulates it from the event stream between
 * projections — `view.live` is only the last broadcast's copy. */
export function transcript(view: ChatView | null, live: ChatLiveReply | null): TranscriptItem[] {
  // `seq` is the server's own and unique within a conversation (the store
  // replaces a row of the same seq rather than appending), so it is also what
  // the search panel jumps to.
  const rows = (view?.rows || []).map((row: ChatRow): TranscriptItem & { seq: number } => ({
    id: `row-${row.seq}`, role: row.role === 'user' ? 'user' : 'being',
    text: row.content, at: row.at, seq: row.seq, images: row.images,
  }));
  const items = interleave<TranscriptItem & { seq: number }, TranscriptItem>(rows, [
    ...(view?.sent || []).map((item, index): TranscriptItem => ({
      id: `sent-${index}`, role: 'user', text: item.text, at: item.at, after: item.after,
      pending: true, images: item.images,
    })),
    ...(view?.replied || []).map((item, index): TranscriptItem => ({
      id: `replied-${index}`, role: 'being', text: item.text, at: item.at, after: item.after,
      pending: true, partial: item.partial === true, think: item.think,
    })),
  ]).map(({ key: _key, ...item }) => item as TranscriptItem);
  // The reply being streamed is always last: it is happening now.
  if (live && (live.text || live.think))
    items.push({ id: 'live', role: 'being', text: live.text, think: live.think, at: live.at, live: true });
  return group(items);
}

/** Loom's meta-line grouping and silence dividers, applied in one pass. */
export function group(items: TranscriptItem[]): TranscriptItem[] {
  let lastRole = '', lastAt = 0;
  return items.map(item => {
    const at = epoch(item.at);
    const gap = lastAt && at ? Math.abs(at - lastAt) : 0;
    const marked: TranscriptItem = {
      ...item,
      ...(gap > GAP_MS ? { gap: `— ${clock(lastAt)} —` } : {}),
      // A pending or live bubble always keeps its own meta line: it is the one
      // carrying「等待记录确认」or the cursor.
      consecutive: item.role === lastRole && gap <= GROUP_MS && !item.pending && !item.live,
    };
    lastRole = item.role;
    if (at) lastAt = at;
    return marked;
  });
}
