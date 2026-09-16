// Ported line for line from BeingDesktop 0.8.26 src/session-recovery.cjs
// (48 lines); 2026-09-16. The recovery file lives next to the Loom page's own
// session partition, so the partition name is part of the on-disk contract:
// `sessionPartition` comes from `common/loom-connection.ts` (BeingDesktop
// src/security.cjs lines 45-48) rather than being reproduced here a fourth time.
// `RecoveryConnection` is exactly the four fields that take part in the identity,
// which is why that function takes `ConnectionIdentity` and not a whole
// `LoomConnection`.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sessionPartition } from '../common/loom-connection';
import type { RecoveryConnection, SessionRecovery } from './types';

export async function readSessionRecovery(directory: string, connection: RecoveryConnection): Promise<SessionRecovery | null> {
  const file = path.join(directory, 'session-recovery', sessionPartition(connection).slice(8) + '.json');
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (data.origin !== new URL(connection.displayUrl).origin || !Array.isArray(data.entries) || typeof data.id !== 'string') return null;
    return data;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

// Runs before session initialization. Existing conversations are never overwritten.
//
// This body is serialized with `importSessionRecovery.toString()` and injected
// into the Loom page (BeingDesktop src/loom-sessions.cjs line 499), so it must
// stay self-contained: no imports, no module-scope helpers, nothing that the
// TypeScript emit would turn into a call to a runtime helper. Type annotations
// are erased before the string is taken, so they are safe; `SessionRecovery` is
// imported as a type only.
export function importSessionRecovery(recovery: SessionRecovery | null, desktopId?: string): void {
  if (!recovery || window !== window.top || recovery.origin !== location.origin) return;
  const legacyKey = 'being-desktop-sessions-v1:' + location.pathname;
  const owner = localStorage.getItem(legacyKey + ':desktop-owner');
  if (desktopId && ((owner && owner !== desktopId) || (recovery.desktopId && recovery.desktopId !== desktopId))) return;
  const scopedKey = desktopId && 'being-desktop-sessions-v2:' + desktopId + ':' + location.pathname;
  // Before the first migration, merge into the legacy store so initialization
  // can migrate the complete history. Subsequent recoveries use the new store.
  const key = scopedKey && localStorage.getItem(scopedKey) ? scopedKey : legacyKey;
  const marker = key + ':recovery:' + recovery.id;
  if (localStorage.getItem(marker) || localStorage.getItem(legacyKey + ':recovery:' + recovery.id)) return;
  const entries = new Map(recovery.entries);
  const incoming = JSON.parse(entries.get(legacyKey) || 'null');
  if (!incoming?.items?.length) return;
  const current = JSON.parse(localStorage.getItem(key) || 'null') || {active:incoming.active,items:[]};
  for (const item of incoming.items) {
    const saved = JSON.parse(entries.get(legacyKey + ':' + item.id) || 'null') || item;
    const existing = current.items.find((value: {id: string}) => value.id === item.id);
    if (existing) {
      const prior = JSON.parse(localStorage.getItem(key + ':' + item.id) || 'null') || existing;
      if (JSON.stringify(prior.messages || []) === JSON.stringify(saved.messages || []) && prior.context === saved.context) continue;
    }
    const id = existing ? crypto.randomUUID() : item.id;
    const restored = {...saved, id, title:existing ? `${saved.title}（恢复副本）` : saved.title,
      messages:(saved.messages || []).map((message: Record<string, unknown>)=>({...message,session_id:id}))};
    localStorage.setItem(key + ':' + id, JSON.stringify(restored));
    current.items.push({id,title:restored.title});
  }
  localStorage.setItem(key, JSON.stringify(current));
  localStorage.setItem(marker, '1');
}
