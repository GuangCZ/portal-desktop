// Ported line by line from BeingDesktop 0.8.26 src/loom-town-sync.cjs lines 5-29;
// 2026-09-16.
//
// `FeatureTaskHistory` takes this as a required injection (docs/migration/u7-features.md
// 「注入点」): it is what decides which of a Being's own request/receipt pairs are
// enrolled in the ledger, and it is applied on the way in AND on the way back out
// of disk, so a record that would not be accepted today is dropped from a file
// written by an older client.
//
// Only `normalizeTownSyncRecords` is ported. The rest of the source module —
// `matchTownSyncMessage`, `installTownSync`, `applyLoomTownSync` — projects those
// records onto the Loom page's DOM in an isolated world, and this shell has no
// Loom page: the native conversation renders its own rows. Nothing in this file
// touches a document.
//
// The validation is deliberately hostile to its input, because `register` is
// reached from a Being's answer: the value must be an array, each item a plain
// object with exactly the four expected own data properties, and every field must
// pass its own format check before the record is kept. A getter, an inherited
// property, a fifth field or a prompt that does not announce its own requestId is
// not repaired — the record is skipped.

import { libraryRoute } from '../town/session/library-contract';
import type { TownSyncRecord } from './types';

const MAX_RECORDS = 256;

export function normalizeTownSyncRecords(value: unknown): TownSyncRecord[] {
  if (!Array.isArray(value)) return [];
  const result = new Map<string, TownSyncRecord>(), conflicts = new Set<string>();
  const routes = new Set(['/api/bonfire/hear', '/api/bonfire/mentions', '/api/bonfire/speak', '/api/fireside/speak', '/api/fireside/list', '/api/fireside/members', '/api/fireside/hear']);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  for (let index = Math.max(0, value.length - MAX_RECORDS); index < value.length; index++) {
    const item = Object.getOwnPropertyDescriptor(value, index)?.value;
    if (!item || Object.getPrototypeOf(item) !== Object.prototype) continue;
    const fields: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(item), keys = ['requestId', 'route', 'beingId', 'prompt'];
    if (Reflect.ownKeys(fields).length !== keys.length || keys.some(key => !fields[key] || !Object.hasOwn(fields[key], 'value') || typeof fields[key].value !== 'string')) continue;
    const next = Object.fromEntries(keys.map(key => [key, fields[key].value as string])) as unknown as TownSyncRecord;
    if (!uuid.test(next.requestId) || !routes.has(next.route) && !libraryRoute(next.route) && !/^\/desktop\/channel\/(feishu|wechat)\/(begin|status)$/.test(next.route) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(next.beingId)
      || next.prompt.length > 160000 || !next.prompt.startsWith(`[Being Desktop Town sync:${next.requestId}]`)) continue;
    next.prompt = next.prompt.replace(/\s+/g, ' ').trim();
    if (conflicts.has(next.requestId)) continue;
    const previous = result.get(next.requestId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(next)) { result.delete(next.requestId); conflicts.add(next.requestId); }
    else result.set(next.requestId, next);
  }
  return [...result.values()];
}
