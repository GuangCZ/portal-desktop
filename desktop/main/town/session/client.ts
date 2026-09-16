// Ported line by line from BeingDesktop 0.8.26 src/town-client.cjs on 2026-09-16.
// Public SDK protocol: jeremyliu16/beings-town-client-sdk @ ea56534, 2026-09-15.
//
// Injection points (BeingDesktop wiring in src/main.cjs boot()):
//   getContext       -> {key: sessionPartition(connection), beingId: state.connection.beingName,
//                        revision: generation, connected: ...}
//   store            -> new TownClientStore({directory, safeStorage})  (separate unit)
//   fetchImpl        -> (url, options) => net.fetch(url, options)
//   onChange/onEvent -> broadcast() / townBackground.notifyEvent(event)
//   sanitize         -> services.sanitizeText            (defaults to ./sanitize)
//   parseCandidates  -> renderer/town-mentions candidates (defaults to ./candidates)
//   validateResult   -> being-town-reader validateTownToolResult (defaults to ./result-contract)
//
// ---------------------------------------------------------------------------
// Overlap with portal-desktop's existing desktop/main/town/client.ts
// ---------------------------------------------------------------------------
// Capabilities BOTH implement (integration must pick one):
//   - Fixed origin https://beings.town, `credentials:'omit'`, `redirect:'error'`,
//     20s request timeout via AbortSignal.timeout.
//   - Pairing over POST /api/client/pair/confirm, `t_` prefixed identity sent as
//     `town_id` and otherwise as `being_id`, `data.ok !== true` refused, a returned
//     `town_id` required to carry the `t_` prefix, 429 given its own wording.
//   - Speak length ceilings counted in code points (bonfire 4000 / fireside 32000),
//     `reply_to`, refusing a direct message addressed to the current identity, and
//     reporting an unconfirmed send as "may have arrived, refresh before resending".
//   - A JSON reader that checks `content-type` and streams the body.
//
// Capabilities ONLY this port has (portal-desktop's client.ts lacks them):
//   - Strict DTO validation (wire.ts / library-contract.ts / session.ts); the other
//     client hands the raw `data` object to the renderer.
//   - hear pagination: `limit` (1-200) and `since` with the measured semantics, plus
//     `global_latest_seq` / `total_count`; the other client hardcodes the limit in
//     the route and has no `since`.
//   - The `error.code` catalogue from docs/interfaces.md §5 (AUTH_REQUIRED,
//     IDENTITY_MISMATCH, NOT_SENT, RESULT_UNKNOWN, RATE_LIMITED, PAIR_*, ...)
//     instead of a coarse {ok:false, code:'auth'|'forbidden'|'not-found'|'http'}.
//   - AUTH_REQUIRED classification: 403 on a read means "re-pair", 403 on a write
//     means "not a member of this fireside" -> NOT_SENT. The other client maps both
//     to `forbidden`.
//   - Response ceiling of 1MB (the other client allows 4MB), plus
//     `referrerPolicy:'no-referrer'` and `cache:'no-store'`.
//   - The SSE client stream (/api/client/stream, consumeEvents, hello verification,
//     90s activity watchdog, exponential reconnect) — portal-desktop's live.ts is a
//     separate implementation with a different state model.
//   - Epoch checks (_context / _epoch / SESSION_CHANGED) and single-flight guards
//     (_credentialLoading / _verification).
//   - First-time Town ID migration: REST and SSE must agree before bindTownId.
//   - _pairReceipt retained in memory after a storage failure + retryPairStorage().
//   - `mentions` receipts and ambiguous-recipient `recipient_warning.candidates`.
//
// Measured protocol notes kept verbatim: docs/town-sdk-integration.md
// ("替换范围", "发送路径（2026-09-11）", "私信与回复（2026-09-11）") and
// docs/architecture.md §7 (credentials omit, no-referrer, no redirects, body <= 1MB).

import { Buffer } from 'node:buffer';
import { errorCode, TownError, type SanitizeText, type TownCandidate, type TownClientContext, type TownClientEvent, type TownClientIdentity, type TownClientPin, type TownClientState, type TownCredentialStore, type TownDirectReceipt, type TownSpeakReceipt, type WireRecord } from './types';
import { candidates as defaultCandidates } from './candidates';
import { libraryQuery, libraryRoute } from './library-contract';
import { validateTownToolResult } from './result-contract';
import { sanitizeText as defaultSanitize } from './sanitize';
import { normalizeTownResponse, validId } from './wire';

const ORIGIN = 'https://beings.town';
const MAX = 1024 * 1024;
const IDENTITY_QUERY = { since_id: '9223372036854775807' };
const ROUTES = new Map<string, string[]>([
  ['/api/bonfire/hear', ['since', 'limit', 'compact']], ['/api/bonfire/mentions', ['since_id']],
  ['/api/fireside/list', []], ['/api/fireside/members', ['fireside_id']], ['/api/fireside/hear', ['fireside_id', 'since', 'limit', 'compact']],
  ['/api/messages', []],
]);
const MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: '请用 Being 提供的六位配对码连接 Town。', IDENTITY_MISMATCH: 'Town 授权身份与当前 Being 不一致，请重新配对。',
  NOT_CONNECTED: '请先连接 Being。', SESSION_CHANGED: 'Being 连接已变化，旧 Town 请求已取消。', INVALID_REQUEST: 'Town 请求参数无效。',
  INVALID_RESPONSE: 'Town 返回格式无效，已保留上次同步内容。', NETWORK_ERROR: 'Town 连接中断，请稍后重试。', RATE_LIMITED: 'Town 请求过于频繁，请稍后重试。',
  SERVICE_ERROR: 'Town 服务暂时不可用。', ABORTED: 'Town 请求已取消。', BUSY: 'Town 正在配对，请等待完成。',
  NOT_SENT: '本次消息未发送。', RESULT_UNKNOWN: '发送结果未确认，请刷新消息核对后再决定是否重发。',
};
MESSAGES.STORAGE_ERROR = 'Town 身份对应关系未能保存，现有配对已保留，请重试。';
MESSAGES.PAIR_CODE_INVALID = '配对码无效、已过期或已使用，请向 Being 获取新码。';
MESSAGES.PAIR_RESULT_UNKNOWN = '配对请求的结果未确认，请先核对；不要重复提交同一码。';
MESSAGES.PAIR_STORAGE_ERROR = '已取得 Town 授权，但未能保存到本机。请保持应用打开，点击「重试保存配对」。';
const fail = (code: string) => new TownError(code, MESSAGES[code] || MESSAGES.SERVICE_ERROR);
const failWith = (code: string, message: string) => new TownError(code, message);
// Bonfire truncates past its limit silently; fireside returns 400. Both are rejected locally instead.
const SPEAK_LIMIT: Record<string, number> = { bonfire: 4000, fireside: 32000 };

export function readQuery(route: string, query: unknown = {}): Record<string, unknown> {
  if (libraryRoute(route)) return libraryQuery(route, query);
  if (!ROUTES.has(route) || !query || Object.getPrototypeOf(query) !== Object.prototype || Object.keys(query as object).some(k => !ROUTES.get(route)!.includes(k))) throw fail('INVALID_REQUEST');
  const value = query as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'since_id') { if (item !== IDENTITY_QUERY.since_id) throw fail('INVALID_REQUEST'); }
    else if (key === 'compact') { if (![true, false, 'true', 'false'].includes(item as boolean | string)) throw fail('INVALID_REQUEST'); }
    else if (!['string', 'number'].includes(typeof item) || (typeof item === 'string' && !/^(0|[1-9]\d*)$/.test(item)) || !Number.isSafeInteger(Number(item)) || Number(item) < (key === 'since' ? 0 : 1) || (key === 'limit' && Number(item) > 200)) throw fail('INVALID_REQUEST');
  }
  if ((route === '/api/bonfire/mentions' && value.since_id !== IDENTITY_QUERY.since_id) || (['/api/fireside/hear', '/api/fireside/members'].includes(route) && !value.fireside_id)) throw fail('INVALID_REQUEST');
  return value;
}

export async function consumeEvents(
  body: ReadableStream<Uint8Array> | null,
  onEvent: (type: string, data: unknown) => void | Promise<void>,
  onActivity: () => void = () => {},
): Promise<void> {
  if (!body) throw fail('INVALID_RESPONSE');
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '', type = '', data: string[] = [], size = 0;
  async function line(value: string) {
    if (!value) { if (data.length) { let parsed; try { parsed = JSON.parse(data.join('\n')); } catch { throw fail('INVALID_RESPONSE'); } await onEvent(type, parsed); } type = ''; data = []; size = 0; return; }
    size += value.length; if (size > MAX) throw fail('INVALID_RESPONSE');
    if (value.startsWith(':')) return;
    const at = value.indexOf(':'), key = at < 0 ? value : value.slice(0, at), content = at < 0 ? '' : value.slice(at + 1).replace(/^ /, '');
    if (key === 'event') type = content;
    if (key === 'data') data.push(content);
  }
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break; onActivity();
      pending += decoder.decode(part.value, { stream: true });
      let match;
      while ((match = /\r\n|\r(?!$)|\n/.exec(pending))) { await line(pending.slice(0, match.index)); pending = pending.slice(match.index + match[0].length); }
      if (pending.length + size > MAX) throw fail('INVALID_RESPONSE');
    }
    // Incomplete EOF events are discarded; reconnect reconciles via REST.
  } finally { void reader.cancel().catch(() => {}); }
}

export interface TownClientOptions {
  getContext: () => TownClientContext | null | undefined;
  store: TownCredentialStore;
  fetchImpl?: typeof fetch;
  onChange?: (state: TownClientState) => void;
  onEvent?: (event: TownClientEvent) => void;
  retryMs?: number;
  /** Text redaction. BeingDesktop injects services.sanitizeText. */
  sanitize?: SanitizeText;
  /** Ambiguous-recipient choices. BeingDesktop injects renderer/town-mentions candidates. */
  parseCandidates?: (value: unknown) => TownCandidate[];
  /** Result contract. BeingDesktop injects being-town-reader validateTownToolResult. */
  validateResult?: (value: unknown, route: string, beingId: string, query?: Record<string, unknown>) => unknown;
}

interface PairReceipt { ctx: TownClientPin; token: string; townId: string; display: string }

export class TownClient {
  getContext: () => TownClientContext | null | undefined;
  store: TownCredentialStore;
  fetchImpl: typeof fetch;
  onChange: (state: TownClientState) => void;
  onEvent: (event: TownClientEvent) => void;
  retryMs: number;
  sanitize: SanitizeText;
  parseCandidates: (value: unknown) => TownCandidate[];
  validateResult: (value: unknown, route: string, beingId: string, query?: Record<string, unknown>) => unknown;
  _epoch = 0;
  _requests = new Set<AbortController>();
  _token: string | null = null;
  _townId = '';
  _credentialLoading: Promise<void> | null = null;
  _verification: Promise<void> | null = null;
  _verified = '';
  _stream: AbortController | null = null;
  _timer: ReturnType<typeof setTimeout> | null = null;
  _enabled = false;
  _pairing = false;
  _pairReceipt: PairReceipt | null = null;
  _state: TownClientState;

  constructor({ getContext, store, fetchImpl = globalThis.fetch, onChange = () => {}, onEvent = () => {}, retryMs = 1000, sanitize = defaultSanitize, parseCandidates = defaultCandidates, validateResult = validateTownToolResult }: TownClientOptions) {
    this.getContext = getContext; this.store = store; this.fetchImpl = fetchImpl;
    this.onChange = onChange; this.onEvent = onEvent; this.retryMs = retryMs;
    this.sanitize = sanitize; this.parseCandidates = parseCandidates; this.validateResult = validateResult;
    this._state = { status: 'unpaired', paired: false, beingId: '', loomBeingId: '', townId: '', displayName: '', errorCode: '', authReason: '', pairingPending: false, pairErrorCode: '' };
  }

  state(): TownClientState { return { ...this._state }; }
  get pairing(): boolean { return this._pairing; }

  _set(value: Partial<TownClientState>) {
    const keys = Object.keys(value) as (keyof TownClientState)[];
    if (keys.every(key => this._state[key] === value[key])) return;
    Object.assign(this._state, value);
    try { this.onChange(this.state()); } catch { /* View updates cannot change results. */ }
  }

  _context(expected?: TownClientPin): TownClientPin {
    const c = this.getContext();
    if (!c?.connected || !c.key || !validId(c.loomBeingId || c.beingId)) throw fail('NOT_CONNECTED');
    const next: TownClientPin = { key: c.key, loomBeingId: (c.loomBeingId || c.beingId)!, revision: c.revision, epoch: this._epoch };
    if (expected && JSON.stringify(next) !== JSON.stringify(expected)) throw fail('SESSION_CHANGED');
    return next;
  }

  reset() {
    this._epoch++; this._enabled = false; if (this._timer) clearTimeout(this._timer); this._timer = null;
    for (const c of this._requests) c.abort(); this._requests.clear(); this._stream = null; this._token = null; this._townId = ''; this._credentialLoading = null; this._verification = null; this._verified = '';
    this._pairReceipt = null;
    this._set({ status: 'unpaired', paired: false, beingId: '', loomBeingId: '', townId: '', displayName: '', errorCode: '', authReason: '', pairingPending: false, pairErrorCode: '' });
  }

  async _credential(ctx: TownClientPin): Promise<string> {
    if (!this._token) {
      if (!this._credentialLoading) {
        const pending = (async () => {
          let saved;
          try {
            if (this.store.loadCredential) saved = await this.store.loadCredential(ctx.key, ctx.loomBeingId);
            else {
              const load = this.store.load;
              if (typeof load !== 'function') throw new TypeError('this.store.load is not a function');
              saved = { token: await load(ctx.key, ctx.loomBeingId) };
            }
          } catch (error) {
            this._context(ctx);
            if (errorCode(error) === 'AUTH_REQUIRED') {
              const reason = (error as { reason?: unknown }).reason;
              this._set({ authReason: ['SECURE_STORAGE_UNAVAILABLE', 'CREDENTIAL_UNREADABLE'].includes(reason as string) ? reason as string : 'CREDENTIAL_UNREADABLE' });
            }
            throw error;
          }
          this._context(ctx); this._token = saved?.token || null; this._townId = saved?.townId || '';
          if (typeof saved?.display === 'string') this._set({ displayName: this.sanitize(saved.display).slice(0, 100) });
        })();
        this._credentialLoading = pending;
        void pending.finally(() => { if (this._credentialLoading === pending) this._credentialLoading = null; }).catch(() => {});
      }
      await this._credentialLoading; this._context(ctx);
    }
    if (!this._token) { this._set({ authReason: 'NO_SAVED_CREDENTIAL' }); throw fail('AUTH_REQUIRED'); }
    this._set({ paired: true, beingId: ctx.loomBeingId, loomBeingId: ctx.loomBeingId, authReason: '' });
    return this._token;
  }

  _identity(value: unknown, ctx: TownClientPin, legacy: string): string {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('INVALID_RESPONSE');
    const source = value as WireRecord;
    if (Object.hasOwn(source, 'town_id')) {
      if (!validId(source.town_id)) throw fail('INVALID_RESPONSE');
      if ((this._townId && source.town_id !== this._townId) || (Object.hasOwn(source, legacy) && source[legacy] !== ctx.loomBeingId)) throw fail('IDENTITY_MISMATCH');
      return source.town_id;
    }
    if (!validId(source[legacy])) throw fail('INVALID_RESPONSE');
    if (source[legacy] !== ctx.loomBeingId) throw fail('IDENTITY_MISMATCH');
    return '';
  }

  _hello(value: unknown, ctx: TownClientPin): string {
    const source = value as WireRecord | null | undefined;
    if (source?.anonymous === true) throw fail('AUTH_REQUIRED');
    if (source?.anonymous !== false || source?.token_kind !== 'client') throw fail('INVALID_RESPONSE');
    return this._identity(value, ctx, 'being_id');
  }

  async _probeHello(ctx: TownClientPin, token: string, signal?: AbortSignal): Promise<string> {
    const controller = new AbortController(); this._requests.add(controller);
    const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(20000), ...(signal ? [signal] : [])]);
    const complete = Symbol('hello'); let identity = '';
    try {
      const res = await this.fetchImpl(new URL('/api/client/stream', ORIGIN).href, { headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` }, signal: combined, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store' });
      if ([401, 403].includes(res.status)) { await res.body?.cancel(); throw fail('AUTH_REQUIRED'); }
      if (!res.ok || res.redirected || !res.headers.get('content-type')?.includes('text/event-stream')) { await res.body?.cancel(); throw fail('INVALID_RESPONSE'); }
      await consumeEvents(res.body, (type, data) => {
        this._context(ctx); if (combined.aborted) throw fail('ABORTED');
        if (type !== 'hello') throw fail('INVALID_RESPONSE');
        identity = this._hello(data, ctx); throw complete;
      });
      throw fail('NETWORK_ERROR');
    } catch (error) {
      this._context(ctx);
      if (error !== complete) throw Object.hasOwn(MESSAGES, errorCode(error)) ? error : fail('NETWORK_ERROR');
      return identity;
    } finally { controller.abort(); this._requests.delete(controller); }
  }

  async _verifyIdentity(ctx: TownClientPin, token: string, { signal, hello }: { signal?: AbortSignal; hello?: unknown } = {}) {
    if (!this._verification) {
      const pending = (async () => {
        const identity = await this._json('/api/bonfire/mentions', { ctx, query: IDENTITY_QUERY, token, signal });
        const townId = this._identity(identity, ctx, 'being');
        if (townId && !this._townId) {
          // The unchanged encrypted token is already bound to this Loom identity.
          // Resolve its new Town namespace only when two authenticated endpoints agree.
          const streamed = hello ? this._hello(hello, ctx) : await this._probeHello(ctx, token, signal);
          if (streamed !== townId) throw fail('IDENTITY_MISMATCH');
          this._context(ctx);
          try { await this.store.bindTownId?.(ctx.key, ctx.loomBeingId, token, townId, () => { try { this._context(ctx); return true; } catch { return false; } }); }
          catch (error) { throw ['IDENTITY_MISMATCH', 'SESSION_CHANGED'].includes(errorCode(error)) ? error : fail('STORAGE_ERROR'); }
          this._context(ctx); this._townId = townId;
        }
        this._context(ctx); this._verified = ctx.key;
        const profile = identity as WireRecord;
        const displayName = typeof profile.display_name === 'string' ? this.sanitize(profile.display_name).slice(0, 100)
          : typeof profile.display === 'string' ? this.sanitize(profile.display).slice(0, 100) : this._state.displayName;
        const renamed = this._state.townId === this._townId && this._state.displayName && displayName && this._state.displayName !== displayName;
        this._set({ loomBeingId: ctx.loomBeingId, townId: this._townId, displayName });
        if (renamed) { try { this.onEvent({ type: 'profile_changed', townId: this._townId }); } catch { /* A profile notification cannot invalidate verified identity. */ } }
      })();
      this._verification = pending;
      void pending.finally(() => { if (this._verification === pending) this._verification = null; }).catch(() => {});
    }
    await this._verification; this._context(ctx);
    if (hello) { const id = this._hello(hello, ctx); if (id && id !== this._townId) throw fail('IDENTITY_MISMATCH'); }
  }

  async _json(route: string, { ctx, query, token, body, signal, write = false }: { ctx: TownClientPin; query?: Record<string, unknown>; token?: string; body?: unknown; signal?: AbortSignal; write?: boolean }): Promise<WireRecord> {
    const pairing = route === '/api/client/pair/confirm';
    const controller = new AbortController(); this._requests.add(controller);
    const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(20000), ...(signal ? [signal] : [])]);
    const url = new URL(route, ORIGIN); for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
    try {
      if (combined.aborted) throw fail('ABORTED');
      const res = await this.fetchImpl(url.href, { method: body ? 'POST' : 'GET', headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: combined, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store' });
      try {
        this._context(ctx);
        if (res.status === 401) throw fail('AUTH_REQUIRED');
        // A client token is never forbidden on a read; on speak, 403 means "not a member of this fireside".
        if (res.status === 403) throw write ? failWith('NOT_SENT', '你不是该围炉的成员；本次消息未发送。') : fail('AUTH_REQUIRED');
        if (res.status === 429) throw fail('RATE_LIMITED');
        if (pairing && res.status === 400) throw fail('PAIR_CODE_INVALID');
        const rejected = write && res.status === 400;
        if ((!res.ok && !rejected) || res.redirected) throw fail('SERVICE_ERROR');
        if (!res.headers.get('content-type')?.includes('application/json') || Number(res.headers.get('content-length')) > MAX) throw fail('INVALID_RESPONSE');
        let length = 0; const chunks: Buffer[] = [];
        // Node's WHATWG ReadableStream is async-iterable; the DOM lib type is not.
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) { length += chunk.length; if (length > MAX) throw fail('INVALID_RESPONSE'); chunks.push(Buffer.from(chunk)); }
        this._context(ctx);
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as WireRecord | null;
        if (rejected) {
          const warning = (value as { recipient_warning?: { candidates?: unknown } } | null)?.recipient_warning?.candidates;
          const errorField = (value as { error?: unknown } | null)?.error;
          const choices = this.parseCandidates(warning || (value as { candidates?: unknown } | null)?.candidates || (errorField as { candidates?: unknown } | null | undefined)?.candidates);
          const detail = this.sanitize(typeof errorField === 'string' ? errorField : typeof (value as { message?: unknown } | null)?.message === 'string' ? (value as { message: string }).message : '').slice(0, 500);
          const rejection = failWith('NOT_SENT', choices.length ? '收件人有歧义；本次私信未发送，请选择 Town ID。' : 'Town 拒绝了本次发送参数；消息未发送。');
          rejection.candidates = choices;
          if (detail) rejection.detail = detail;
          throw rejection;
        }
        if (!value || typeof value !== 'object' || value.ok === false || Object.hasOwn(value, 'error')) throw fail('INVALID_RESPONSE');
        return value;
      } finally { void res.body?.cancel().catch(() => {}); }
    } catch (error) {
      this._context(ctx);
      if (signal?.aborted) throw fail('ABORTED');
      // Errors raised above already carry their own wording; only opaque failures are classified here.
      if (Object.hasOwn(MESSAGES, errorCode(error))) throw error;
      const code = error instanceof SyntaxError ? 'INVALID_RESPONSE' : 'NETWORK_ERROR';
      // A write may already have reached Town. Never report an unconfirmed send as "not sent".
      throw fail(pairing && code === 'NETWORK_ERROR' ? 'PAIR_RESULT_UNKNOWN' : write && code === 'NETWORK_ERROR' ? 'RESULT_UNKNOWN' : code);
    } finally { controller.abort(); this._requests.delete(controller); }
  }

  async pair(value: unknown): Promise<TownClientState> {
    const request = value as { code?: unknown } | null;
    if (!request || Object.getPrototypeOf(request) !== Object.prototype || Object.keys(request).some(k => k !== 'code') || typeof request.code !== 'string' || !/^[A-Z0-9]{6}$/.test(request.code.toUpperCase())) throw fail('INVALID_REQUEST');
    if (this._pairing) throw fail('BUSY');
    if (this._pairReceipt) throw fail('PAIR_STORAGE_ERROR');
    this._pairing = true;
    let ctx: TownClientPin | undefined;
    try {
      ctx = this._context();
      this._set({ pairErrorCode: '' });
      this.store.assertAvailable?.();
      let boundTownId = this._townId;
      if (!boundTownId && this.store.loadCredential) {
        try { boundTownId = (await this.store.loadCredential(ctx.key, ctx.loomBeingId))?.townId || ''; }
        catch (error) { if (errorCode(error) !== 'AUTH_REQUIRED') throw error; } // Re-pairing can repair an unreadable old file.
        this._context(ctx);
      }
      const identity = ctx.loomBeingId.startsWith('t_') ? { town_id: ctx.loomBeingId } : { being_id: ctx.loomBeingId };
      const data = await this._json('/api/client/pair/confirm', { ctx, body: { ...identity, code: request.code.toUpperCase() } });
      if (typeof data.token !== 'string' || !/^[a-f0-9]{64}$/.test(data.token) || data.ok !== true) throw fail('INVALID_RESPONSE');
      const modern = Object.hasOwn(data, 'town_id');
      if (modern && (!validId(data.town_id) || !data.town_id.startsWith('t_'))) throw fail('INVALID_RESPONSE');
      if ((!modern || Object.hasOwn(data, 'being_id')) && data.being_id !== ctx.loomBeingId) throw fail('IDENTITY_MISMATCH');
      if (modern && ((ctx.loomBeingId.startsWith('t_') && !(data.town_id as string).startsWith(ctx.loomBeingId)) || (boundTownId && boundTownId !== data.town_id))) throw fail('IDENTITY_MISMATCH');
      // The authenticated confirm exchange binds the one-time code to the requested identity.
      // Persist its returned token + Town ID before opening another network connection.
      this._pairReceipt = { ctx, token: data.token, townId: modern ? data.town_id as string : '', display: typeof data.display === 'string' ? this.sanitize(data.display).slice(0, 100) : '' };
      return await this._savePairReceipt();
    } catch (error) {
      if (ctx) { this._context(ctx); this._set({ pairErrorCode: Object.hasOwn(MESSAGES, errorCode(error)) ? errorCode(error) : 'STORAGE_ERROR' }); }
      throw error;
    } finally { this._pairing = false; }
  }

  async _savePairReceipt(): Promise<TownClientState> {
    const receipt = this._pairReceipt;
    if (!receipt) throw fail('INVALID_REQUEST');
    const { ctx, token, townId, display } = receipt;
    this._context(ctx);
    try {
      const save = this.store.save;
      if (typeof save !== 'function') throw new TypeError('this.store.save is not a function');
      await save(ctx.key, ctx.loomBeingId, token, townId, display, () => { try { this._context(ctx); return true; } catch { return false; } });
    } catch {
      this._context(ctx);
      // Keep the new token in main-process memory; retry only persistence, never confirm.
      this.lifecycle({ enabled: false });
      this._set({ status: 'pair_storage_error', pairingPending: true, errorCode: 'PAIR_STORAGE_ERROR' });
      throw fail('PAIR_STORAGE_ERROR');
    }
    this._context(ctx);
    this.reset(); this._token = token; this._townId = townId;
    this._set({ status: 'connecting', paired: true, beingId: ctx.loomBeingId, loomBeingId: ctx.loomBeingId, townId, displayName: display, errorCode: '' });
    this.lifecycle({ enabled: true }); return this.state();
  }

  async retryPairStorage(): Promise<TownClientState> {
    if (this._pairing) throw fail('BUSY');
    this._pairing = true;
    try { return await this._savePairReceipt(); } finally { this._pairing = false; }
  }

  async forget(): Promise<TownClientState> {
    if (this._pairing) throw fail('BUSY');
    const ctx = this._context();
    this.reset();
    const remove = this.store.remove;
    if (typeof remove !== 'function') throw new TypeError('this.store.remove is not a function');
    await remove(ctx.key);
    return this.state();
  }

  async read(route: string, { query = {}, signal }: { query?: unknown; signal?: AbortSignal } = {}): Promise<unknown> {
    let resolved = readQuery(route, query);
    if (['/api/bonfire/hear', '/api/fireside/hear'].includes(route)) resolved = { compact: false, ...resolved };
    const ctx = this._context(); const token = await this._credential(ctx);
    if (this._verified !== ctx.key) await this._verifyIdentity(ctx, token, { signal });
    const value = await this._json(route, { ctx, query: resolved, token, signal }); this._context(ctx);
    if (Object.hasOwn(value, 'town_id')) { const id = this._identity(value, ctx, 'being'); if (!this._townId || id !== this._townId) throw fail('IDENTITY_MISMATCH'); }
    return this.validateResult(normalizeTownResponse(value, route, ctx.loomBeingId), route, ctx.loomBeingId, resolved);
  }

  async identity({ signal, force = false }: { signal?: AbortSignal; force?: boolean } = {}): Promise<TownClientIdentity> {
    const ctx = this._context(), token = await this._credential(ctx);
    if (force || this._verified !== ctx.key) await this._verifyIdentity(ctx, token, { signal });
    this._context(ctx);
    return { loomBeingId: ctx.loomBeingId, townId: this._townId, displayName: this._state.displayName };
  }

  async speak(value: unknown): Promise<TownSpeakReceipt> {
    const request = value as { kind?: unknown; message?: unknown; firesideId?: unknown; replyTo?: unknown; signal?: AbortSignal } | null;
    if (!request || Object.getPrototypeOf(request) !== Object.prototype
      || Object.keys(request).some(key => !['kind', 'message', 'firesideId', 'replyTo', 'signal'].includes(key))) throw fail('INVALID_REQUEST');
    const { kind, message, firesideId = '', replyTo = '', signal } = request;
    if (!['bonfire', 'fireside'].includes(kind as string)) throw fail('INVALID_REQUEST');
    if (typeof message !== 'string' || !message.trim() || message.includes('\0')) throw failWith('NOT_SENT', '请输入要发送的内容；本次消息未发送。');
    if ([...message].length > SPEAK_LIMIT[kind as string]) throw failWith('NOT_SENT', `消息超过 ${SPEAK_LIMIT[kind as string]} 字上限；本次消息未发送。`);
    if (kind === 'fireside' && (!/^[1-9]\d{0,15}$/.test(String(firesideId)) || !Number.isSafeInteger(Number(firesideId)))) throw failWith('NOT_SENT', '围炉无效；本次消息未发送。');
    // Town rejects a parent that does not exist, or that lives in another fireside or conversation.
    if (replyTo !== '' && (!/^[1-9]\d{0,15}$/.test(String(replyTo)) || !Number.isSafeInteger(Number(replyTo)))) throw failWith('NOT_SENT', '被回复的消息无效；本次消息未发送。');
    const ctx = this._context();
    const token = await this._credential(ctx);
    if (this._verified !== ctx.key) await this._verifyIdentity(ctx, token, { signal });
    const body = { message, ...(kind === 'fireside' ? { fireside_id: Number(firesideId) } : {}), ...(replyTo !== '' ? { reply_to: Number(replyTo) } : {}) };
    const result = await this._json(`/api/${kind}/speak`, { ctx, token, body, signal, write: true });
    this._context(ctx);
    try { const id = this._identity(result, ctx, 'being'); if (id && id !== this._townId) throw fail('IDENTITY_MISMATCH'); }
    catch { throw fail('RESULT_UNKNOWN'); }
    if (result.ok !== true || !Number.isSafeInteger(result.seq) || (result.seq as number) < 1) throw fail('RESULT_UNKNOWN');
    const mentions = Array.isArray(result.mentions) ? result.mentions.filter((name: unknown) => typeof name === 'string').slice(0, 20).map((name: string) => name.slice(0, 100)) : [];
    // via is "client:<name>" here, but an IP-trusted Hearth host is short-circuited to "being".
    // Both are legitimate; the value is surfaced, never asserted.
    return { ok: true, id: String(result.seq), seq: result.seq as number, mentions, ...(Object.hasOwn(result, 'mention_warnings') ? { mention_warnings: result.mention_warnings } : {}), via: typeof result.via === 'string' ? result.via.slice(0, 120) : '' };
  }

  async sendDirectMessage(value: unknown): Promise<TownDirectReceipt> {
    const request = value as { recipient?: unknown; content?: unknown; replyTo?: unknown; signal?: AbortSignal } | null;
    if (!request || Object.getPrototypeOf(request) !== Object.prototype
      || Object.keys(request).some(key => !['recipient', 'content', 'replyTo', 'signal'].includes(key))) throw fail('INVALID_REQUEST');
    const { recipient, content, replyTo = '', signal } = request;
    // Town resolves a recipient by being_id, then display name; it must land on exactly one being.
    if (typeof recipient !== 'string' || !recipient.trim() || recipient.length > 100 || recipient.includes('\0')) throw failWith('NOT_SENT', '请填写有效的收件人；本次私信未发送。');
    if (typeof content !== 'string' || !content.trim() || content.includes('\0')) throw failWith('NOT_SENT', '请输入要发送的内容；本次私信未发送。');
    if ([...content].length > SPEAK_LIMIT.fireside) throw failWith('NOT_SENT', `私信超过 ${SPEAK_LIMIT.fireside} 字上限；本次私信未发送。`);
    if (replyTo !== '' && (typeof replyTo !== 'string' || !replyTo.trim() || replyTo.length > 200)) throw failWith('NOT_SENT', '被回复的私信无效；本次私信未发送。');
    const ctx = this._context();
    if (recipient.trim() === ctx.loomBeingId) throw failWith('NOT_SENT', 'Town 不允许给自己发私信；本次私信未发送。');
    const token = await this._credential(ctx);
    if (this._verified !== ctx.key) await this._verifyIdentity(ctx, token, { signal });
    if (recipient.trim() === this._townId) throw failWith('NOT_SENT', 'Town 不允许给自己发私信；本次私信未发送。');
    const body = { recipient: recipient.trim(), content, ...(replyTo !== '' ? { reply_to: replyTo } : {}) };
    const result = await this._json('/api/messages', { ctx, token, body, signal, write: true });
    this._context(ctx);
    if (result.ok !== true || typeof result.message_id !== 'string' || !result.message_id) throw fail('RESULT_UNKNOWN');
    const resolvedRecipient = result.recipient_town_id ?? result.recipient;
    return { ok: true, id: result.message_id.slice(0, 200), recipient: typeof resolvedRecipient === 'string' ? resolvedRecipient.slice(0, 100) : '',
      via: typeof result.via === 'string' ? result.via.slice(0, 120) : '' };
  }

  lifecycle({ enabled }: { enabled: boolean }) {
    if (!enabled) {
      this._enabled = false; if (this._timer) clearTimeout(this._timer); this._timer = null;
      for (const controller of this._requests) controller.abort();
      this._stream = null; this._verified = '';
      if (['connected', 'connecting', 'reconnecting'].includes(this._state.status)) this._set({ status: 'paused' });
      return;
    }
    this._enabled = true;
    if (!this._stream && !this._timer && !this._pairReceipt && !['auth_required', 'identity_mismatch'].includes(this._state.status)) void this._connect();
  }

  async _connect() {
    let ctx: TownClientPin; try { ctx = this._context(); } catch { return; }
    const controller = new AbortController(); this._stream = controller; this._requests.add(controller);
    let hello = false, timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const token = await this._credential(ctx); if (controller.signal.aborted) return;
      this._set({ status: 'connecting', errorCode: '' });
      timer = setTimeout(() => controller.abort(), 20000);
      const url = new URL('/api/client/stream', ORIGIN); // Main-process fetch supports headers; no token in URLs.
      const res = await this.fetchImpl(url.href, { headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` }, signal: controller.signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store' });
      try {
        this._context(ctx);
        if ([401, 403].includes(res.status)) throw fail('AUTH_REQUIRED');
        if (!res.ok || res.redirected || !res.headers.get('content-type')?.includes('text/event-stream')) throw fail('SERVICE_ERROR');
        await consumeEvents(res.body, async (type, data) => {
          this._context(ctx); if (controller.signal.aborted) throw fail('ABORTED');
          if (type === 'hello') {
            if (hello) throw fail('INVALID_RESPONSE');
            const townId = this._hello(data, ctx);
            if (townId && !this._townId) await this._verifyIdentity(ctx, token, { signal: controller.signal, hello: data });
            this._context(ctx); if (controller.signal.aborted) throw fail('ABORTED');
            hello = true; this.retryMs = 1000; clearTimeout(timer); timer = setTimeout(() => controller.abort(), 90000); this._verified = ctx.key; this._set({ status: 'connected', loomBeingId: ctx.loomBeingId, townId: this._townId, errorCode: '' }); this.onEvent({ type: 'hello' });
          } else if (['bonfire', 'fireside', 'dm'].includes(type)) {
            if (!hello || !data || typeof data !== 'object' || Array.isArray(data)) throw fail('INVALID_RESPONSE');
            // Payload is an invalidation hint. REST remains authoritative.
            // A dm payload is an invalidation hint like the others; the inbox is re-read on demand.
            this.onEvent({ type, ...(type === 'fireside' ? { firesideId: String((data as WireRecord).fireside_id || '') } : {}) } as TownClientEvent);
          } else if (type === 'error') throw fail('SERVICE_ERROR');
        }, () => { if (hello) { clearTimeout(timer); timer = setTimeout(() => controller.abort(), 90000); } });
      } finally { void res.body?.cancel().catch(() => {}); }
      throw fail('NETWORK_ERROR');
    } catch (error) {
      if (ctx.epoch !== this._epoch || !this._enabled || this._stream !== controller) return;
      const code = Object.hasOwn(MESSAGES, errorCode(error)) ? errorCode(error) : 'NETWORK_ERROR';
      this._verified = '';
      const blocked = ['AUTH_REQUIRED', 'IDENTITY_MISMATCH'].includes(code);
      this._set({ status: code === 'AUTH_REQUIRED' ? 'auth_required' : code === 'IDENTITY_MISMATCH' ? 'identity_mismatch' : 'reconnecting', errorCode: code });
      if (!blocked) { this._timer = setTimeout(() => { this._timer = null; if (this._enabled) void this._connect(); }, this.retryMs); this.retryMs = Math.min(this.retryMs * 2, 30000); (this._timer as { unref?: () => void }).unref?.(); }
    } finally { clearTimeout(timer); controller.abort(); this._requests.delete(controller); if (this._stream === controller) this._stream = null; }
  }
}
