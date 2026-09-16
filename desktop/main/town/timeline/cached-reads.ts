// Ported line by line from BeingDesktop 0.8.26 src/town-cached-reads.cjs on 2026-09-16.
// Members are cached for 60 seconds per identity (docs/interfaces.md section 7); public
// directories share the fixed identity key 'public-town-v1' so they survive a disconnect.
// `scrollId` was inlined here from src/town-library-contract.cjs while the Town library unit had
// no port. It has one (../session/library-contract.ts), and the pattern and reserved set were
// identical, so the copy is gone: one owner for the rule, and nothing left to drift.
import { scrollId } from '../session/library-contract';
import type {
  TownCacheResult,
  TownCacheStore,
  TownCachedReadsContext,
  TownCodedError,
} from './types';


const PUBLIC_METHODS = new Set(['listBeings', 'getBeingMembers', 'getGroveCatalog', 'getGroveDetail']);
const MEMBER_METHODS = new Set(['getBeingMembers', 'listBeings', 'getFiresideMembers']);
const NO_ARGS = new Set(['listBeings', 'getBeingMembers', 'getFiresides']);
const miss = (): TownCacheResult => ({cached: false, data: null, lastSuccessAt: null});
const invalid = (): TownCodedError => Object.assign(new Error('Town 缓存读取参数无效。'), {code: 'INVALID_REQUEST'});
const changed = (): TownCodedError => Object.assign(new Error('Being 连接已变化，请重新读取。'), {code: 'SESSION_CHANGED'});

function fields(value: unknown, allowed: string[], required: string[] = []): Record<string, unknown> {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => !allowed.includes(key as string) || !Object.hasOwn(descriptors[key as string], 'value')) || required.some(key => !Object.hasOwn(descriptors, key))) throw invalid();
  return value as Record<string, unknown>;
}

function number(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw invalid();
  return value as number;
}

export interface TownResourceRequest {
  method: string;
  value: unknown;
  key: string;
  public: boolean;
}

export function resource(method: string, value: unknown): TownResourceRequest {
  let query: unknown;
  if (NO_ARGS.has(method)) query = {...fields(value === undefined ? {} : value, [])};
  else if (method === 'listScrolls') {
    const input = fields(value === undefined ? {} : value, ['offset', 'limit', 'visibility']);
    if (input.visibility !== undefined && !['private', 'shared', 'public'].includes(input.visibility as string)) throw invalid();
    query = {offset: number(input.offset, 0, 0, 4294967295), limit: number(input.limit, 50, 1, 200), ...(input.visibility === undefined ? {} : {visibility: input.visibility})};
  } else if (method === 'getScroll') {
    const input = fields(value, ['id', 'offset', 'limit'], ['id']);
    if (!scrollId(input.id)) throw invalid();
    query = {id: input.id, offset: number(input.offset, 0, 0, 4294967295), limit: number(input.limit, 10000, 1, 10000)};
  } else if (method === 'getGroveCatalog') {
    const input = fields(value === undefined ? {} : value, ['offset', 'limit']);
    query = {offset: number(input.offset, 0, 0, 100000), limit: number(input.limit, 30, 1, 100)};
  } else if (method === 'getGroveDetail') {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value)) throw invalid();
    query = value;
  } else if (method === 'getFiresideMembers') {
    if (typeof value !== 'string' || !/^[1-9]\d{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) throw invalid();
    query = value;
  } else throw invalid();
  return {method, value: query, key: JSON.stringify([method, query]), public: PUBLIC_METHODS.has(method)};
}

interface ResolvedContext {
  identityKey: string | false;
  revision: number;
  identityRevision: number;
  membersRevision?: number;
}

export interface TownCachedReadsOptions {
  cache: TownCacheStore;
  getContext: () => TownCachedReadsContext;
  now?: () => number;
  membersTtlMs?: number;
}

// Only successful, already sanitized read DTOs enter this cache. Mutations and
// live connection/installation status never use it.
export class TownCachedReads {
  // Assigned through Object.assign below, exactly as the CommonJS constructor did.
  cache!: TownCacheStore;
  getContext!: () => TownCachedReadsContext;
  now!: () => number;
  membersTtlMs!: number;
  _requests: Map<string, number>;
  _serial: number;
  _membersRevision: number;
  _membersInvalidatedAt: number;

  constructor({cache, getContext, now = Date.now, membersTtlMs = 60000}: TownCachedReadsOptions) {
    Object.assign(this, {cache, getContext, now, membersTtlMs});
    this._requests = new Map();
    this._serial = 0; this._membersRevision = 0; this._membersInvalidatedAt = -Infinity;
  }

  _context(request: TownResourceRequest): ResolvedContext {
    const context = this.getContext();
    const identityKey = request.public ? 'public-town-v1' : context.connected && context.identityKey;
    return {identityKey, revision: context.revision, identityRevision: context.identityRevision, ...(MEMBER_METHODS.has(request.method) ? {membersRevision: this._membersRevision} : {})};
  }

  _current(request: TownResourceRequest, context: ResolvedContext): boolean {
    return (!MEMBER_METHODS.has(request.method) || context.membersRevision === this._membersRevision) && (request.public || JSON.stringify(this._context(request)) === JSON.stringify(context));
  }

  async snapshot(value: unknown): Promise<TownCacheResult> {
    fields(value, ['method', 'value'], ['method']);
    const selector = value as {method: string; value?: unknown};
    const request = resource(selector.method, selector.value);
    const context = this._context(request);
    if (!context.identityKey) return miss();
    const result = await this.cache.load(context.identityKey, request.key);
    if (!this._current(request, context)) throw changed();
    if (MEMBER_METHODS.has(request.method) && result.cached) {
      const at = typeof result.lastSuccessAt === 'number' ? result.lastSuccessAt : Date.parse(result.lastSuccessAt as unknown as string);
      if (!Number.isFinite(at) || at <= this._membersInvalidatedAt || this.now() - at >= this.membersTtlMs) return miss();
    }
    return result;
  }

  invalidateMembers(): void { this._membersRevision++; this._membersInvalidatedAt = this.now(); }

  async read<T>(method: string, value: unknown, read: (query: unknown) => T | Promise<T>): Promise<T> {
    const request = resource(method, value);
    const context = this._context(request);
    if (!context.identityKey) throw Object.assign(new Error('请先连接 Being。'), {code: 'NOT_CONNECTED'});
    const key = JSON.stringify([context.identityKey, request.key]);
    const serial = ++this._serial;
    this._requests.set(key, serial);
    try {
      const result = await read(request.value);
      if (!this._current(request, context)) throw changed();
      if (this._requests.get(key) === serial) {
        try { void Promise.resolve(this.cache.save(context.identityKey as string, request.key, result)).catch(() => {}); } catch { /* Keep the successful live result if persistence fails. */ }
      }
      return result;
    } finally {
      if (this._requests.get(key) === serial) this._requests.delete(key);
    }
  }
}
