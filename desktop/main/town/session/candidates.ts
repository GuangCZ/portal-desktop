// Ported line by line from BeingDesktop 0.8.26 renderer/town-mentions.js `candidates`
// (plus its local `clean` / `validId` helpers) on 2026-09-16.
//
// BeingDesktop's TownClient imports this from the renderer bundle. portal-desktop's
// architecture test forbids main -> renderer imports, so the main process carries its
// own copy here and exposes it as TownClient's injectable `parseCandidates`.
//
// docs/town-sdk-integration.md "SDK 配对升级（2026-09-15）": the disambiguation
// choices for a rejected direct message come from `recipient_warning.candidates`.

import type { TownCandidate } from './types';

const clean = (value: unknown, limit = 100): string =>
  typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f‪-‮⁦-⁩]/g, '').slice(0, limit) : '';
const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);

export function candidates(value: unknown): TownCandidate[] {
  const seen = new Set<string>();
  return (Array.isArray(value) ? value : []).slice(0, 100)
    .filter((item: unknown) => {
      const id = (item as { town_id?: unknown } | null | undefined)?.town_id;
      return validId(id) && !seen.has(id) && !!seen.add(id);
    })
    .map((item: { town_id: string; display_name?: unknown }) => ({ town_id: item.town_id, display_name: clean(item.display_name) || item.town_id }));
}
