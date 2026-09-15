// Ported line by line from BeingDesktop 0.8.26 src/main.cjs on 2026-09-16: the boot() closures
// loadCachedFiresides / loadCachedFiresideMembers, which test/town-cache-handlers.test.cjs
// exercised by slicing them out of main.cjs. They carry no IPC, so they are lifted here as a
// factory whose injected accessors stand in one for one for the boot() variables they closed over
// (townRoomCache, townMemberCache, generation, identityRevision, townCachedReads, townBackground).
// The integration phase should call this factory from main.ts instead of re-inlining the bodies.
import type { TownCacheResult, TownCodedError } from './types';

export interface TownRoomEntry {
  id: string | number;
  [key: string]: unknown;
}

export interface TownRoomCache {
  owned: TownRoomEntry[];
  joined: TownRoomEntry[];
  cached: boolean;
  lastSuccessAt?: number | string | null;
}

export interface TownMemberCache {
  members: unknown[];
  cached: boolean;
  lastSuccessAt?: number | string | null;
}

export interface CachedRoomDeps {
  // townCachedReads
  reads: {snapshot(value: unknown): Promise<TownCacheResult>};
  // townRoomCache (a boot() variable replaced wholesale, so identity comparison still detects a
  // newer live result landing while a disk read was in flight).
  getRooms(): TownRoomCache;
  setRooms(value: TownRoomCache): void;
  // townMemberCache
  members: Map<string, TownMemberCache>;
  // generation / identityRevision
  getRevisions(): {generation: number; identityRevision: number};
  // townBackground.reconcileRooms
  reconcileRooms(value: unknown): void;
  now?: () => number;
}

export interface CachedRoomLoaders {
  loadCachedFiresides(): Promise<TownRoomCache>;
  loadCachedFiresideMembers(value: string): Promise<TownMemberCache>;
}

export function createCachedRoomLoaders(deps: CachedRoomDeps): CachedRoomLoaders {
  const now = deps.now || Date.now;

  async function loadCachedFiresides(): Promise<TownRoomCache> {
    if (deps.getRooms().cached) return structuredClone(deps.getRooms());
    const previous = deps.getRooms();
    const result = await deps.reads.snapshot({method: 'getFiresides'});
    if (previous === deps.getRooms() && result.cached) {
      deps.setRooms({...(result.data as TownRoomCache), cached: true, lastSuccessAt: result.lastSuccessAt});
      deps.reconcileRooms(result.data);
    }
    return structuredClone(deps.getRooms());
  }

  async function loadCachedFiresideMembers(value: string): Promise<TownMemberCache> {
    const {generation: revision, identityRevision: identity} = deps.getRevisions();
    const current = () => {
      const state = deps.getRevisions();
      if (revision !== state.generation || identity !== state.identityRevision) throw Object.assign(new Error('Being 连接已变化。'), {code: 'SESSION_CHANGED'}) as TownCodedError;
    };
    const rooms = await loadCachedFiresides();
    current();
    if (rooms.cached && ![...rooms.owned, ...rooms.joined].some(room => String(room.id) === value)) return {members: [], cached: false};
    const previous = deps.members.get(value);
    const result = await deps.reads.snapshot({method: 'getFiresideMembers', value});
    current();
    if (previous && now() - (typeof previous.lastSuccessAt === 'number' ? previous.lastSuccessAt : Date.parse(previous.lastSuccessAt as string) || 0) >= 60000) deps.members.delete(value);
    if (!deps.members.has(value) && result.cached) deps.members.set(value, {...(result.data as TownMemberCache), cached: true, lastSuccessAt: result.lastSuccessAt});
    return structuredClone(deps.members.get(value) || {members: [], cached: false});
  }

  return {loadCachedFiresides, loadCachedFiresideMembers};
}
