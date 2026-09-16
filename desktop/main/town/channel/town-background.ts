// Ported from BeingDesktop src/town-background.cjs on 2026-09-16.
// Paging semantics are measured, not inferred: see docs/town-sdk-integration.md and the
// Town hear paging notes (since is the earliest N, there is no before, sequence numbers are sparse).
//
// IPC surface registered by BeingDesktop main.cjs boot() (registration belongs to the
// integration stage, see docs/interfaces.md section 1):
//   townSnapshot({kind, firesideId?})        -> envelope, synchronous local read
//   townCachedSnapshot({kind, firesideId?})  -> envelope after the disk restore settles
//   townRefresh({kind, firesideId?})         -> envelope after one transport read
//   townRequestRead({kind, firesideId?})     -> envelope after one explicit Being-executed read
//   townLoadOlder({kind, firesideId?})       -> envelope after one bounded older-history walk
// Feed updates reach the renderer through onUpdate, diagnostics through onStatus.
//
// TownRefresh, TownSession and BonfireCache are ported by other migration units; here they are
// injected. Electron is never imported.
import type { BonfireCache, TownBackgroundClock, TownEnvelope, TownIdentity, TownReadOptions, TownRefreshFactory, TownRefreshLike, TownSession, TownSnapshot } from './types';

function invalid(message = '请选择有效的 Town 消息来源。') {
  const error = new Error(message) as Error & { code: string };
  error.code = 'INVALID_REQUEST';
  return error;
}

export interface TownRequest { kind: 'bonfire' | 'fireside'; firesideId: string }

export function requestDto(value: unknown): TownRequest {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!Object.hasOwn(descriptors, 'kind') || !Object.hasOwn(descriptors.kind, 'value')) throw invalid();
  const keys = descriptors.kind.value === 'bonfire' ? ['kind'] : ['kind', 'firesideId'];
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some((key) => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value'))) throw invalid();
  const request = value as { kind?: unknown; firesideId?: unknown };
  if (request.kind === 'bonfire') return { kind: 'bonfire', firesideId: '' };
  if (request.kind !== 'fireside' || typeof request.firesideId !== 'string' || !/^[1-9]\d{0,15}$/.test(request.firesideId) || !Number.isSafeInteger(Number(request.firesideId))) throw invalid();
  return { kind: 'fireside', firesideId: request.firesideId };
}

export interface TownBackgroundOptions {
  townSession: TownSession;
  getIdentity: () => TownIdentity | null;
  readCachedSnapshot?: ((options: { kind: string; firesideId: string; limit: number; signal: AbortSignal }) => Promise<TownSnapshot> | TownSnapshot) | null;
  direct?: boolean;
  limit?: number;
  bonfireCache?: BonfireCache | null;
  getCacheKey?: () => string;
  onUpdate?: (value: TownEnvelope) => void;
  onStatus?: () => void;
  clock?: TownBackgroundClock;
  /** BeingDesktop constructed TownRefresh directly; the factory keeps that module injectable. */
  createRefresh: TownRefreshFactory;
}

export interface TownLiveEvent { type: string; firesideId?: string }

// Cached feeds own one public feed and at most one selected private room.
// The automatic transport reads existing results. Only requestRead may ask
// Being to execute a new read when a cache transport is configured.
export class TownBackground {
  private townSession: TownSession;
  private getIdentity: () => TownIdentity | null;
  private readCachedSnapshot: TownBackgroundOptions['readCachedSnapshot'];
  private direct: boolean;
  private limit: number;
  private bonfireCache: BonfireCache | null;
  private getCacheKey: () => string;
  private onUpdate: (value: TownEnvelope) => void;
  private onStatus: () => void;
  private clock: TownBackgroundClock;
  private createRefresh: TownRefreshFactory;
  private _cacheGeneration = 0;
  private _restorePromise: Promise<void> | null = null;
  private _roomRestorePromise: Promise<void> | null = null;
  private _roomGeneration = 0;
  private _allowedRooms: Set<string> | null = null;
  private _enabled = false;
  private _identityKey = '';
  private _room: TownRefreshLike | null = null;
  private _roomId = '';
  private _bonfire: TownRefreshLike;

  constructor({ townSession, getIdentity, readCachedSnapshot = null, direct = false, limit = 10, bonfireCache = null, getCacheKey = () => '', onUpdate = () => {}, onStatus = () => {}, clock = {}, createRefresh }: TownBackgroundOptions) {
    if (readCachedSnapshot !== null && typeof readCachedSnapshot !== 'function') throw new TypeError('Invalid Town cache reader');
    this.townSession = townSession;
    this.getIdentity = getIdentity;
    this.readCachedSnapshot = readCachedSnapshot;
    this.direct = direct;
    this.limit = limit;
    this.bonfireCache = bonfireCache;
    this.getCacheKey = getCacheKey;
    this.onUpdate = onUpdate;
    this.onStatus = onStatus;
    this.clock = clock;
    this.createRefresh = createRefresh;
    this._bonfire = this._create('bonfire', '');
  }

  private _create(kind: string, firesideId: string): TownRefreshLike {
    const current = () => kind === 'bonfire' || this._roomId === firesideId;
    const publish = () => {
      if (!current()) return;
      try { this.onUpdate(this._envelope(kind, firesideId)); } catch { /* Observers do not affect reading. */ }
    };
    return this.createRefresh({
      getIdentity: this.getIdentity, clock: this.clock, limit: this.limit, automatic: this.direct || Boolean(this.readCachedSnapshot), cached: Boolean(this.readCachedSnapshot), pageable: this.direct,
      readSnapshot: ({ signal, limit, since }) => this.readCachedSnapshot
        ? this.readCachedSnapshot({ kind, firesideId, limit, signal })
        : this._requestRead(kind, firesideId, { signal, limit, since }),
      onSnapshot: publish,
      onSuccess: (value) => {
        if (!current() || !this.bonfireCache || this._identityKey !== JSON.stringify(this.getIdentity())) return;
        const key = this._cacheKey(kind, firesideId);
        if (key) void Promise.resolve(this.bonfireCache.save(key, value)).catch(() => {});
      },
      onStatus: () => { if (current()) { try { this.onStatus(); } catch { /* Observers do not affect reading. */ } publish(); } },
    });
  }

  // Coalesce bursts, but reconcile again if an event arrives during a REST read.
  notifyEvent(event: TownLiveEvent) {
    if (!this.direct || !this._enabled) return;
    const kinds = event.type === 'hello' ? ['bonfire', 'fireside'] : [event.type];
    for (const kind of kinds) {
      if (kind !== 'bonfire' && kind !== 'fireside') continue;
      const reader = kind === 'bonfire' ? this._bonfire : this._room;
      if (!reader || kind === 'fireside' && event.type !== 'hello' && event.firesideId !== this._roomId) continue;
      reader._townDirty = true;
      if (reader._townEventTimer || reader._townEventFlight) continue;
      const generation = this._cacheGeneration;
      reader._townEventTimer = setTimeout(async () => {
        reader._townEventTimer = null; reader._townEventFlight = true;
        try {
          do {
            reader._townDirty = false;
            if (!this._enabled || generation !== this._cacheGeneration || kind === 'fireside' && reader !== this._room) break;
            await reader.refresh().catch(() => {});
          } while (reader._townDirty);
        } finally { reader._townEventFlight = false; }
      }, 250);
      reader._townEventTimer.unref?.();
    }
  }

  private _requestRead(kind: string, firesideId: string, { signal, limit, since }: TownReadOptions) {
    const page = { limit, ...(since === undefined ? {} : { since }) };
    return kind === 'bonfire'
      ? this.townSession.getBonfireMessages(page, { signal })
      : this.townSession.getFiresideMessages({ firesideId, ...page }, { signal });
  }

  private _cacheKey(kind: string, firesideId: string): string {
    const key = this.getCacheKey();
    return key && (kind === 'bonfire' ? key : `${key}:fireside:${firesideId}`);
  }

  private _envelope(kind: string, firesideId: string): TownEnvelope {
    const reader = (kind === 'bonfire' ? this._bonfire : this._room)!;
    const snapshot = reader.snapshot();
    // An empty, initial error still carries its public connection identity.
    if (!snapshot.identity && snapshot.messages.length === 0) snapshot.identity = this.getIdentity();
    return { kind, firesideId, snapshot, status: reader.status() };
  }

  metadata() {
    return { bonfire: this._bonfire.status(), fireside: this._room?.status() || null };
  }

  lifecycle({ enabled, reason = 'offline' }: { enabled?: boolean; reason?: string }) {
    const identity = this.getIdentity();
    const key = JSON.stringify(identity);
    const changed = key !== this._identityKey;
    if (changed) {
      this._identityKey = key;
      this._enabled = false;
      this._bonfire.stop(); this._bonfire.reset();
      this.clearRoom();
      this._allowedRooms = null;
      const generation = ++this._cacheGeneration;
      const cacheKey = identity && this.bonfireCache ? this.getCacheKey() : '';
      this._restorePromise = cacheKey ? Promise.resolve().then(() => this.bonfireCache!.load(cacheKey)).then((value) => {
        if (generation === this._cacheGeneration && key === JSON.stringify(this.getIdentity()) && cacheKey === this.getCacheKey()) this._bonfire.restoreCache(value);
      }).catch(() => {}) : null;
    }
    const next = Boolean(enabled && identity);
    if (this._enabled === next) return;
    this._enabled = next;
    for (const reader of [this._bonfire, this._room].filter(Boolean) as TownRefreshLike[]) {
      if (next) {
        const restoration = reader === this._bonfire ? this._restorePromise : this._roomRestorePromise;
        if (restoration && !reader.status().running) {
          const generation = this._cacheGeneration;
          void restoration.then(() => { if (generation === this._cacheGeneration && this._enabled && (reader === this._bonfire || reader === this._room)) this._start(reader); });
        } else this._start(reader);
      }
      else reader.pause(reason);
    }
  }

  private _start(reader: TownRefreshLike) { if (reader.status().running) reader.resume(); else reader.start(); }

  async restore(): Promise<void> {
    let pending: Promise<void> | null;
    do { pending = this._restorePromise; await pending; } while (pending !== this._restorePromise);
  }

  clearRoom() {
    const previous = this._room;
    this._roomGeneration++;
    this._roomRestorePromise = null;
    this._room = null; this._roomId = '';
    previous?.stop(); previous?.reset();
    if (previous) { try { this.onStatus(); } catch { /* Observers do not affect reading. */ } }
  }

  reconcileRooms(rooms: { owned?: { id: unknown }[]; joined?: { id: unknown }[] }) {
    const ids = new Set([...(rooms.owned || []), ...(rooms.joined || [])].map((room) => String(room.id)));
    this._allowedRooms = ids;
    if (this._room && !ids.has(this._roomId)) this.clearRoom();
  }

  private _select(value: unknown): TownRequest {
    const request = requestDto(value);
    if (request.kind === 'fireside' && this._allowedRooms && !this._allowedRooms.has(request.firesideId)) {
      const error = new Error('当前 Being 已无法访问此围炉，请刷新围炉目录。') as Error & { code: string };
      error.code = 'AUTH_REQUIRED';
      throw error;
    }
    if (request.kind === 'fireside' && request.firesideId !== this._roomId) {
      this.clearRoom();
      this._roomId = request.firesideId;
      this._room = this._create('fireside', request.firesideId);
      const reader = this._room;
      const generation = this._roomGeneration;
      const identityKey = this._identityKey;
      const cacheKey = this.getIdentity() && this.bonfireCache ? this._cacheKey(request.kind, request.firesideId) : '';
      const current = () => generation === this._roomGeneration && reader === this._room && identityKey === JSON.stringify(this.getIdentity()) && cacheKey === this._cacheKey(request.kind, request.firesideId);
      this._roomRestorePromise = cacheKey ? Promise.resolve().then(() => this.bonfireCache!.load(cacheKey)).then((value) => {
        if (current()) reader.restoreCache(value);
      }).catch(() => {}).then(() => { if (current() && this._enabled) this._start(reader); }) : null;
      if (this._enabled && !this._roomRestorePromise) this._start(reader);
    }
    return request;
  }

  snapshot(value: unknown): TownEnvelope {
    const request = this._select(value);
    return this._envelope(request.kind, request.firesideId);
  }

  async cachedSnapshot(value: unknown): Promise<TownEnvelope> {
    const request = this._select(value);
    const reader = request.kind === 'bonfire' ? this._bonfire : this._room;
    const identityKey = JSON.stringify(this.getIdentity());
    await (request.kind === 'bonfire' ? this.restore() : this._roomRestorePromise);
    this._assertCurrent(request, reader, identityKey);
    return this._envelope(request.kind, request.firesideId);
  }

  private _assertCurrent(request: TownRequest, reader: TownRefreshLike | null, identityKey: string) {
    if (identityKey !== JSON.stringify(this.getIdentity()) || request.kind === 'fireside' && (reader !== this._room || request.firesideId !== this._roomId)) {
      const error = new Error('连接身份或选定围炉已变化，请重新读取消息。') as Error & { code: string };
      error.code = 'SESSION_CHANGED';
      throw error;
    }
  }

  async refresh(value: unknown): Promise<TownEnvelope> {
    return this._refresh(value, false);
  }

  async requestRead(value: unknown): Promise<TownEnvelope> {
    return this._refresh(value, true);
  }

  // Older history for the selected feed, one bounded walk per call. Only the direct SDK read can
  // page, so a Being-relayed feed refuses.
  async loadOlder(value: unknown): Promise<TownEnvelope> {
    const request = this._select(value);
    const reader = request.kind === 'bonfire' ? this._bonfire : this._room;
    const identityKey = JSON.stringify(this.getIdentity());
    if (request.kind === 'bonfire' && this._restorePromise) await this.restore();
    if (request.kind === 'fireside' && this._roomRestorePromise) await this._roomRestorePromise;
    this._assertCurrent(request, reader, identityKey);
    if (!this._enabled) { const error = new Error('连接 Being 后再读取更早的消息。') as Error & { code: string }; error.code = 'NOT_CONNECTED'; throw error; }
    await reader!.loadOlder();
    this._assertCurrent(request, reader, identityKey);
    return this._envelope(request.kind, request.firesideId);
  }

  private async _refresh(value: unknown, explicit: boolean): Promise<TownEnvelope> {
    const request = this._select(value);
    const reader = request.kind === 'bonfire' ? this._bonfire : this._room;
    const identityKey = JSON.stringify(this.getIdentity());
    if (request.kind === 'bonfire' && this._restorePromise) await this.restore();
    if (request.kind === 'fireside' && this._roomRestorePromise) await this._roomRestorePromise;
    this._assertCurrent(request, reader, identityKey);
    if (!this._enabled) { const error = new Error('连接 Being 后再刷新 Town 消息。') as Error & { code: string }; error.code = 'NOT_CONNECTED'; throw error; }
    if (explicit && this.readCachedSnapshot) await reader!.requestRead((options) => this._requestRead(request.kind, request.firesideId, options));
    else await reader!.refresh();
    this._assertCurrent(request, reader, identityKey);
    return this._envelope(request.kind, request.firesideId);
  }

  stop() {
    this._enabled = false;
    this._cacheGeneration++;
    this._roomGeneration++;
    this._bonfire.stop();
    this._room?.stop();
  }
}
