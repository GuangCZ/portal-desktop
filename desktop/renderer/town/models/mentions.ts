import { normalizeTownDisplay, validTownIdentity } from '../../../shared/town-identity';
import type { TownDesktopMember } from '../../../shared/desktop-types';

export type MentionNames = ReadonlyMap<string, { name: string; at: number }>;

/**
 * The member directory, as the map a mention is rendered through.
 *
 * REWRITTEN 2026-09-16 for the direct Town client. The previous version mined
 * names out of message envelopes, because the shell's only source of identity
 * was whatever a feed happened to carry. The paired client has an actual
 * directory — `beings:town-members`, cached for 60 seconds and invalidated by a
 * `profile_changed` event — so names come from there and from nowhere else.
 * BeingDesktop's rule, verbatim: message prose is never a name directory.
 *
 * `at` is kept so a later entry wins over an earlier one for the same id; the
 * directory is read whole, so it is the read's own ordinal.
 */
export function mentionNames(members: readonly TownDesktopMember[] = [], previous: MentionNames = new Map()): MentionNames {
  const names = new Map(previous);
  let at = 0;
  for (const member of members) {
    at += 1;
    const id = member?.id;
    if (!validTownIdentity(id) || !id.startsWith('t_')) continue;
    // A directory entry whose name is just the id again says nothing; leaving it
    // out keeps `@t_abc` rendering as itself rather than as a second copy of itself.
    const name = normalizeTownDisplay(member.name).replace(/\s+\(t_[a-zA-Z0-9_-]+\)$/, '');
    if (!name || /^@?t_[a-zA-Z0-9_-]+$/.test(name)) continue;
    names.set(id, { name, at });
  }
  return names;
}

/** One more name than the directory holds: the paired profile's own. */
export function withSelf(names: MentionNames, townId: string, displayName: string): MentionNames {
  return mentionNames([{ id: townId, name: displayName, description: '' }], names);
}

export function mentionParts(text: string, names: MentionNames): { text: string; id?: string }[] {
  const parts: { text: string; id?: string }[] = [];
  let end = 0;
  // Exact, case-sensitive IDs only; don't guess short prefixes or touch URLs/emails.
  for (const match of text.matchAll(/(?<![\w@/])@(t_[a-zA-Z0-9_-]{1,62})(?![a-zA-Z0-9_-])/g)) {
    const name = names.get(match[1])?.name;
    if (!name) continue;
    parts.push({ text: text.slice(end, match.index) }, { text: '@' + name, id: match[1] });
    end = match.index + match[0].length;
  }
  parts.push({ text: text.slice(end) });
  return parts;
}

export const mentionText = (text: string, names: MentionNames) =>
  mentionParts(text, names).map(part => part.text).join('');
