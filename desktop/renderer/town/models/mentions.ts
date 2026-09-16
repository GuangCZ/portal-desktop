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

/** One `mention_warnings` entry Town returned with an accepted message.
 *
 * Ported from BeingDesktop renderer/town-mentions.js `warnings()`/`renderReceipt()`.
 * Town has sent this in several shapes across versions — a bare string, and
 * objects keyed `mention`/`name`/`display_name`/`query`/`token`/`input` with the
 * explanation under `message`/`reason`/`warning` — so the shapes are all read
 * here rather than assumed. The message itself was ACCEPTED: a warning is never
 * a reason to resend, only a reason to address the mention differently.
 */
export interface MentionWarning {
  mention: string;
  detail: string;
  candidates: { town_id: string; display_name: string }[];
}

const warningText = (value: unknown, cap = 120) => normalizeTownDisplay(value).slice(0, cap);

export function mentionWarnings(value: unknown): MentionWarning[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map(item => {
    if (typeof item === 'string') return { mention: '', detail: warningText(item, 500), candidates: [] };
    const entry = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const offered = Array.isArray(entry.candidates) ? entry.candidates : [];
    return {
      mention: warningText(entry.mention ?? entry.name ?? entry.display_name ?? entry.query ?? entry.token ?? entry.input),
      detail: warningText(entry.message ?? entry.reason ?? entry.warning, 500),
      // Only a real Town ID is offered as a choice; a candidate without one
      // could not be used as an address and would only invite a second send.
      candidates: offered
        .map(choice => (choice && typeof choice === 'object' ? choice : {}) as Record<string, unknown>)
        .filter(choice => validTownIdentity(choice.town_id) && String(choice.town_id).startsWith('t_'))
        .slice(0, 10)
        .map(choice => ({ town_id: String(choice.town_id), display_name: warningText(choice.display_name) || String(choice.town_id) })),
    };
  });
}
