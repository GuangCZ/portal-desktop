// Ported line by line from BeingDesktop 0.8.26 src/town-session.cjs on 2026-09-16.
//
// Contracts: https://beings.town/api/{bonfire,fireside,beings,scrolls,channels}/help (2026-09-07).
// Production protected reads use the Town client SDK. A Loom token is never a Town credential.
//
// Injection points (BeingDesktop wiring in src/main.cjs boot()):
//   getContext -> {configured, connected, exiting, connectionId: generation,
//                  identityRevision, beingName, townId: townClient.state().townId}
//   writeImpl  -> townSpeak(request)               (Being relay fallback; separate unit)
//   getIdentity-> options => townClient.identity(options)
//   fetchImpl  -> (url, options) => net.fetch(url, {...options, credentials:'omit', referrerPolicy:'no-referrer'})
//   readImpl   -> (route, options) => townClient.read(route, options)
//   now        -> Date.now (member cache TTL clock)
// Note that _request deliberately does NOT set referrerPolicy itself: main.cjs adds
// it in the injected fetchImpl, and the integration stage must keep that wrapper
// (docs/architecture.md §7: credentials omit, no-referrer, no redirects, body <= 1MB).
//
// Measured pagination semantics kept verbatim (docs/town-sdk-integration.md
// "时间线累积（2026-09-11）"): `since` returns the EARLIEST N messages with
// seq > since, there is no `before`, limit is 1-200, and sequence numbers are sparse.

import { Buffer } from 'node:buffer';
import { errorCode, errorMessage, isRecord, isSequence, TownError, type TownAreaState, type TownBeingEntry, type TownChannelStatus, type TownDirectMessage, type TownFiresideMember, type TownFiresideRoom, type TownGetIdentity, type TownMember, type TownMessage, type TownMessagePage, type TownReadImpl, type TownScrollDetail, type TownScrollList, type TownSendResult, type TownSessionArea, type TownSessionContext, type TownSessionPin, type TownSessionState, type TownVerifiedIdentity, type TownWriteImpl, type WireRecord } from './types';
import { beingsDto, libraryRoute, scrollDto, scrollId, scrollListDto } from './library-contract';
import { relaySource } from './result-source';
import { matchesTownIdentity, memberId, normalizeTownResponse } from './wire';

const TOWN_ORIGIN = 'https://beings.town';
export const TOWN_AUTH_DETAIL = 'Town 拒绝了本机的 GET 读取请求（401/403），当前连接没有消息读取权限。';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_QR_BYTES = 256 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const ROUTES = new Set(['/api', '/api/bonfire/mentions', '/api/bonfire/hear', '/api/bonfire/speak', '/api/fireside/list', '/api/fireside/members', '/api/fireside/hear', '/api/channels/status', '/api/channels/register', '/api/channels/credentials']);

function failure(code: string, message: string) { return new TownError(code, message); }
const record = isRecord;
function text(value: unknown, limit = 2000): string {
  return typeof value === 'string' ? value.slice(0, limit * 2).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f‪-‮⁦-⁩]/g, '').slice(0, limit) : '';
}
const sequence = isSequence;
function validId(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }
function firesideId(value: unknown): number {
  const number = typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || (number as number) < 1) throw failure('INVALID_REQUEST', '请选择有效的围炉。');
  return number as number;
}
function checkAborted(signal?: AbortSignal) { if (signal?.aborted) throw failure('ABORTED', '读取已取消。'); }
function plainRequest<T extends object>(value: unknown, allowed: string[], required: string[] = allowed): T {
  if (!record(value) || Object.getPrototypeOf(value) !== Object.prototype) throw failure('INVALID_REQUEST', '请求格式无效。');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !allowed.includes(key) || !Object.hasOwn(descriptors[key as string], 'value')) || required.some(key => !Object.hasOwn(descriptors, key))) throw failure('INVALID_REQUEST', '请求格式无效。');
  return value as T;
}

function imageData(bytes: Buffer, mime: string): string {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_QR_BYTES) return '';
  const valid = (mime === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    || (mime === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    || (mime === 'image/webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP');
  return valid ? `data:${mime};base64,${bytes.toString('base64')}` : '';
}

function inlineQr(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_QR_BYTES * 1.4) return '';
  const match = value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[2].length % 4) return '';
  const bytes = Buffer.from(match[2], 'base64');
  return bytes.toString('base64') === match[2] ? imageData(bytes, match[1]) : '';
}

function membersDto(value: unknown): TownMember[] {
  if (!record(value) || !Array.isArray(value.community)) throw failure('INVALID_RESPONSE', 'Town 成员目录格式发生变化，请稍后重试。');
  const seen = new Set<unknown>();
  return value.community.slice(0, 2000).filter((member: unknown) => record(member) && validId(memberId(member)) && !seen.has(memberId(member)) && !!seen.add(memberId(member)))
    .map((member: WireRecord) => ({ id: memberId(member) as string, name: text(member.display_name, 100) || memberId(member) as string, description: text(member.about, 500) }));
}

// Town reports who actually spoke ("being" or "client:<name>"). Carried only when present,
// so fixtures and cached payloads without it keep their existing shape.
const viaField = (item: WireRecord) => { const via = text(item.via, 120); return via ? { via } : {}; };
// Reply metadata as reported by Town. Carried only when a parent exists, so plain
// messages keep their existing shape in fixtures and caches.
const replyField = (item: WireRecord) => sequence(item.reply_to)
  ? { replyTo: { id: String(item.reply_to), beingId: validId(item.reply_to_being) ? item.reply_to_being : '', preview: text(item.reply_to_preview, 200) } }
  : {};

export function messagesDto(value: unknown, members: { id: string; name?: string }[] = []): TownMessagePage {
  if (!record(value) || value.ok !== true || !Array.isArray(value.messages) || !sequence(value.global_latest_seq)) throw failure('INVALID_RESPONSE', '篝火消息格式发生变化，请稍后重试。');
  const seen = new Set<unknown>();
  const messages = value.messages.slice(0, 200).filter((item: unknown) => record(item) && sequence(item.seq) && typeof item.message === 'string' && typeof item.being === 'string' && !seen.has(item.seq) && !!seen.add(item.seq))
    .map((item: WireRecord) => {
      // Display names, including formerly unique names, cannot establish a historical author.
      const byId = members.find(member => member.id === item.being);
      const beingId = validId(item.town_id) ? item.town_id : validId(item.being_id) ? item.being_id : byId?.id || (/^t_/.test(item.being as string) && validId(item.being) ? item.being : '');
      return { id: String(item.seq), beingId, ...(validId(item.town_id) ? { townId: item.town_id } : {}), ...(!beingId ? { authorUnknown: true as const } : {}), beingName: text(item.speaker_name, 100) || text(item.being, 100), content: text(item.message, 4000), createdAt: text(item.at, 64), revisedAt: text(item.revised_at, 64), mentions: [] as string[], ...viaField(item), ...replyField(item) };
    })
    .sort((left, right) => Number(left.id) - Number(right.id));
  return { messages, latestSeq: value.global_latest_seq, ...(sequence(value.total_count) ? { total: value.total_count } : {}), ...relaySource(value) };
}

export function directMessagesDto(value: unknown): { messages: TownDirectMessage[] } {
  if (!record(value) || !Array.isArray(value.messages)) throw failure('INVALID_RESPONSE', '私信格式发生变化，请稍后重试。');
  const seen = new Set<unknown>();
  // Town returns the inbox newest first, capped at 100. That order is preserved for display.
  const messages = value.messages.slice(0, 100)
    .filter((item: unknown) => record(item) && typeof item.id === 'string' && item.id && typeof item.content === 'string' && !seen.has(item.id) && !!seen.add(item.id))
    .map((item: WireRecord) => {
      const senderId = validId(item.sender) ? item.sender : validId(item.sender_being_id) ? item.sender_being_id : '';
      const reply = typeof item.reply_to === 'string' && item.reply_to
        ? { replyTo: { id: text(item.reply_to, 200), beingId: validId(item.reply_to_sender) ? item.reply_to_sender : '', preview: text(item.reply_to_preview, 200) } }
        : {};
      return { id: text(item.id, 200), senderId, senderName: text(item.sender_name, 100) || senderId || '未知',
        content: text(item.content, 32000), createdAt: text(item.created_at, 64) || text(item.at, 64),
        ...viaField(item), ...reply };
    });
  return { messages };
}

function firesidesDto(value: unknown): { owned: TownFiresideRoom[]; joined: TownFiresideRoom[] } {
  if (!record(value) || !Array.isArray(value.owned) || !Array.isArray(value.joined)) throw failure('INVALID_RESPONSE', '围炉列表格式发生变化，请稍后重试。');
  const seen = new Set<unknown>();
  const rooms = (entries: unknown[]): TownFiresideRoom[] => entries.slice(0, 2000).filter((room: unknown): room is WireRecord => record(room) && Number.isSafeInteger(room.id) && (room.id as number) > 0 && typeof room.name === 'string' && !seen.has(room.id) && !!seen.add(room.id))
    .map((room: WireRecord) => ({ id: room.id as number, name: text(room.name, 200), ...(sequence(room.member_count) ? { member_count: room.member_count } : {}) }));
  // Owned rings can contain private invite keys. Only display fields leave main.
  return { owned: rooms(value.owned), joined: rooms(value.joined) };
}

function firesideMembersDto(value: unknown): { members: TownFiresideMember[] } {
  if (!Array.isArray(value)) throw failure('INVALID_RESPONSE', '围炉成员格式发生变化，请稍后重试。');
  const seen = new Set<unknown>();
  return { members: value.slice(0, 2000).filter((member: unknown) => record(member) && validId(member.being_id) && !seen.has(member.being_id) && !!seen.add(member.being_id))
    .map((member: WireRecord) => ({ being_id: member.being_id as string, display_name: text(member.display_name, 100) || member.being_id as string, joined_at: text(member.joined_at, 64) })) };
}

export function firesideMessagesDto(value: unknown, expected: { beingId: string }): TownMessagePage {
  if (!record(value) || value.being !== expected.beingId) throw failure('IDENTITY_MISMATCH', 'Town 授权身份与当前 Being 不一致，请检查连接。');
  if (!Array.isArray(value.messages) || !sequence(value.latest_seq) || value.messages.some((item: unknown) => record(item) && item.truncated === true)) throw failure('INVALID_RESPONSE', '围炉消息格式发生变化，请稍后重试。');
  const seen = new Set<unknown>();
  const messages = value.messages.slice(0, 200).filter((item: unknown) => record(item) && sequence(item.seq) && validId(item.being) && typeof item.message === 'string' && !seen.has(item.seq) && !!seen.add(item.seq))
    .map((item: WireRecord) => ({ id: String(item.seq), beingId: item.being as string, beingName: text(item.speaker_name, 100) || item.being as string, content: text(item.message, 32000), createdAt: text(item.at, 64), revisedAt: text(item.revised_at, 64), mentions: Array.isArray(item.mentions) ? [...new Set(item.mentions.filter(validId))].slice(0, 20) : [], ...viaField(item), ...replyField(item) }))
    .sort((left, right) => Number(left.id) - Number(right.id));
  return { messages, latestSeq: value.latest_seq, ...(sequence(value.total_count) ? { total: value.total_count } : {}) };
}

function channelDto(value: unknown, channel: string): TownChannelStatus {
  const source: WireRecord = record(value) ? value : {};
  const known = new Set(['connected', 'disconnected', 'pending', 'registered', 'disabled', 'waiting', 'expired', 'error']);
  const status = known.has(source.status as string) ? source.status as string : source.ready === true ? 'connected' : source.ready === false ? 'registered' : 'unknown';
  // Channel response prose can contain credentials. Keep the UI description local.
  const result: TownChannelStatus = { channel, status, detail: status === 'unknown' ? '渠道状态尚未确认，请刷新后查看。' : '' };
  if (typeof source.app_id === 'string' && /^cli_[A-Za-z0-9_-]{1,120}$/.test(source.app_id)) result.appId = source.app_id;
  // Registration may return a QR image. Only pass images on documented service domains.
  const qr = source.qr_code_url || source.qrcode_url || source.qr_url || source.qrcode || source.qr_code;
  const inline = inlineQr(qr);
  if (inline) result.qrCodeDataUrl = inline;
  if (typeof qr === 'string' && qr.length <= 4096) {
    try {
      const url = new URL(qr);
      if (url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && ['beings.town', 'weixin.qq.com', 'wx.qq.com', 'open.weixin.qq.com'].includes(url.hostname)) result.qrCodeUrl = url.href;
    } catch { /* Unknown QR formats stay unavailable instead of becoming active content. */ }
  }
  return result;
}

const emptyState = (): TownSessionState => ({
  bonfire: { status: 'unknown', detail: '' }, fireside: { status: 'unknown', detail: '' },
  channel: { status: 'unknown', detail: '' }, scroll: { status: 'unknown', detail: '' },
  beings: { status: 'unknown', detail: '' },
});

export interface TownSessionOptions {
  getContext: () => TownSessionContext;
  fetchImpl?: typeof fetch;
  readImpl?: TownReadImpl | null;
  writeImpl?: TownWriteImpl | null;
  getIdentity?: TownGetIdentity | null;
  onChange?: (state: TownSessionState) => void;
  now?: () => number;
  membersTtlMs?: number;
}

type RequestFn = (route: string, options?: { query?: Record<string, unknown>; body?: unknown }) => Promise<unknown>;

export class TownSession {
  getContext: () => TownSessionContext;
  fetchImpl: typeof fetch;
  readImpl: TownReadImpl | null;
  writeImpl: TownWriteImpl | null;
  getIdentity: TownGetIdentity | null;
  onChange: (state: TownSessionState) => void;
  now: () => number;
  membersTtlMs: number;
  _membersRevision = 0;
  _membersExpiresAt = 0;
  _epoch = 0;
  _requests = new Set<AbortController>();
  _mutations = new Set<string>();
  _members: Map<string, TownMember> | null = null;
  _state: TownSessionState;

  constructor({ getContext, fetchImpl = globalThis.fetch, readImpl = null, writeImpl = null, getIdentity = null, onChange = () => {}, now = Date.now, membersTtlMs = 60000 }: TownSessionOptions) {
    if (typeof getContext !== 'function' || typeof fetchImpl !== 'function' || (readImpl !== null && typeof readImpl !== 'function')) throw new Error('Town 会话配置无效。');
    this.getContext = getContext; this.fetchImpl = fetchImpl; this.readImpl = readImpl; this.writeImpl = writeImpl;
    this.getIdentity = getIdentity; this.onChange = onChange; this.now = now; this.membersTtlMs = membersTtlMs;
    this._membersExpiresAt = 0; this._membersRevision++;
    this._state = emptyState();
  }

  state(): TownSessionState { return Object.fromEntries(Object.entries(this._state).map(([area, value]) => [area, { ...value }])); }

  reset() {
    this._epoch++;
    for (const controller of this._requests) controller.abort();
    this._requests.clear();
    this._mutations.clear();
    this._members = null;
    this._membersExpiresAt = 0; this._membersRevision++;
    this._state = emptyState();
  }

  _set(area: string, status: string, detail = '') {
    this._state[area] = { status, detail } as TownAreaState;
    try { this.onChange(this.state()); } catch { /* View updates cannot change results. */ }
  }

  _context(expected?: TownSessionPin, connectionRevision?: unknown): TownSessionPin {
    const current = this.getContext();
    const loomBeingId = current.loomBeingId || current.beingId || current.beingName;
    const beingId = loomBeingId;
    if (!current.configured || !current.connected || current.exiting || !validId(beingId) || !sequence(current.connectionId)) throw failure('NOT_CONNECTED', '请先连接 Being 并等待会话加载完成。');
    const identity: TownSessionPin = { beingId, loomBeingId: loomBeingId as string, connectionId: current.connectionId, identityRevision: current.identityRevision, epoch: this._epoch };
    if ((expected && (Object.keys(identity) as (keyof TownSessionPin)[]).some(key => identity[key] !== expected[key])) || (connectionRevision !== undefined && current.connectionId !== connectionRevision)) throw failure('SESSION_CHANGED', '连接身份已变化，请在当前 Being 下重新操作。');
    return identity;
  }

  async _request(route: string, { query, body, expected, mutation = false, signal }: { query?: Record<string, unknown>; body?: unknown; expected?: TownSessionPin; mutation?: boolean; signal?: AbortSignal } = {}): Promise<unknown> {
    if (!ROUTES.has(route) && !libraryRoute(route)) throw failure('INVALID_REQUEST', '不支持此 Town 操作。');
    if (expected) this._context(expected);
    checkAborted(signal);
    const url = new URL(route, TOWN_ORIGIN);
    if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    this._requests.add(controller);
    try {
      const response = await this.fetchImpl(url.href, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
      });
      if (expected) this._context(expected);
      checkAborted(signal);
      if (response.status === 401 || response.status === 403) throw failure('AUTH_REQUIRED', TOWN_AUTH_DETAIL);
      if (response.status === 429) throw failure('RATE_LIMITED', 'Town 请求过于频繁，请稍后重试。');
      if (!response.ok) throw failure(mutation ? 'RESULT_UNKNOWN' : 'SERVICE_ERROR', mutation ? '操作未获确认，请先刷新状态；不要重复提交。' : 'Town 暂时不可用，请稍后重试。');
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.toLowerCase().includes('application/json')) throw failure(mutation ? 'RESULT_UNKNOWN' : 'INVALID_RESPONSE', 'Town 返回了无法识别的结果，请先刷新状态。');
      const declaredLength = Number(response.headers.get('content-length'));
      if (declaredLength > MAX_RESPONSE_BYTES) throw failure('INVALID_RESPONSE', 'Town 返回的数据过大。');
      const reader = response.body?.getReader();
      if (!reader) throw failure('INVALID_RESPONSE', 'Town 返回的数据不完整。');
      const chunks: Buffer[] = [];
      let length = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > MAX_RESPONSE_BYTES) throw failure('INVALID_RESPONSE', 'Town 返回的数据过大。');
          chunks.push(Buffer.from(part.value));
        }
      } finally { try { await reader.cancel(); } catch { /* A completed response needs no cancellation. */ } }
      if (expected) this._context(expected);
      checkAborted(signal);
      let value: unknown;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure(mutation ? 'RESULT_UNKNOWN' : 'INVALID_RESPONSE', 'Town 返回了无法识别的结果，请先刷新状态。'); }
      const envelope = value as WireRecord | null;
      if ((!record(value) && !(['/api/fireside/members', '/api/beings'].includes(route) && Array.isArray(value))) || envelope?.ok === false || (envelope !== null && typeof envelope === 'object' && Object.hasOwn(envelope, 'error'))) throw failure(mutation ? 'RESULT_UNKNOWN' : 'SERVICE_ERROR', mutation ? '操作未获确认，请先刷新状态；不要重复提交。' : 'Town 暂时无法完成此操作。');
      return value;
    } catch (error) {
      if (expected) this._context(expected);
      checkAborted(signal);
      const code = errorCode(error);
      if (code && ['AUTH_REQUIRED', 'RATE_LIMITED', 'RESULT_UNKNOWN', 'SERVICE_ERROR', 'INVALID_RESPONSE', 'SESSION_CHANGED', 'NOT_CONNECTED'].includes(code)) throw error;
      throw failure(mutation ? 'RESULT_UNKNOWN' : 'NETWORK_ERROR', mutation ? '连接中断，操作结果未知，请先刷新状态；不要重复提交。' : '无法连接 Town，请检查网络后重试。');
    } finally { signal?.removeEventListener('abort', abort); controller.abort(); this._requests.delete(controller); }
  }

  async _authorized(area: string, expected: TownSessionPin, { signal }: { signal?: AbortSignal } = {}) {
    try {
      // This read neither marks mentions nor fetches message history. Its identity
      // binds IP Trust to the selected Loom Being before any write is attempted.
      const identity = await this._request('/api/bonfire/mentions', { expected, signal, query: { since_id: '9223372036854775807' } });
      const verified = await this._townIdentity(expected, signal);
      if (!matchesTownIdentity(identity, verified)) throw failure('IDENTITY_MISMATCH', 'Town 授权身份与当前 Being 不一致，请检查连接。');
      this._context(expected);
      checkAborted(signal);
      this._set(area, 'ready');
    } catch (error) {
      this._context(expected);
      if (errorCode(error) === 'ABORTED') throw error;
      this._set(area, errorCode(error) === 'AUTH_REQUIRED' ? 'auth_required' : 'error', errorMessage(error));
      throw error;
    }
  }

  async _townIdentity(expected: TownSessionPin, signal?: AbortSignal): Promise<TownVerifiedIdentity> {
    let townId = this.getContext().townId || '';
    if (!townId && this.getIdentity) {
      try { const identity = await this.getIdentity({ signal }); this._context(expected); townId = identity.townId || ''; }
      catch (error) { if (errorCode(error) !== 'AUTH_REQUIRED') throw error; }
    }
    this._context(expected);
    return { loomBeingId: expected.loomBeingId, townId };
  }

  memberCacheState(): { revision: number; expiresAt: number } { return { revision: this._membersRevision, expiresAt: this._membersExpiresAt }; }
  memberDisplayName(townId: string): string { return this.now() < this._membersExpiresAt ? this._members?.get(townId)?.name || '' : ''; }
  invalidateMembers(): { revision: number; expiresAt: number } {
    this._members = null; this._membersExpiresAt = 0; this._membersRevision++;
    try { this.onChange(this.state()); } catch { /* Read cache invalidation does not change a send result. */ }
    return this.memberCacheState();
  }

  async getMembers({ signal, force = false }: { signal?: AbortSignal; force?: boolean } = {}): Promise<{ members: TownMember[]; source: string }> {
    checkAborted(signal);
    if (!force && this._members && this.now() < this._membersExpiresAt) return { members: [...this._members.values()], source: 'public' };
    const epoch = this._epoch, revision = this._membersRevision;
    // Cache only the stable ID -> current display metadata mapping, never name -> identity.
    const value = await this._request('/api', { signal });
    if (epoch !== this._epoch || revision !== this._membersRevision) throw failure('SESSION_CHANGED', '成员目录已失效，请重新读取。');
    const members = membersDto(value);
    this._members = new Map(members.map(member => [member.id, member]));
    this._membersExpiresAt = this.now() + this.membersTtlMs;
    return { members, source: 'public' };
  }

  async listScrolls(value: unknown = {}, { signal }: { signal?: AbortSignal } = {}): Promise<TownScrollList> {
    const request = plainRequest<{ offset?: number; limit?: number; visibility?: string }>(value, ['offset', 'limit', 'visibility'], []);
    if ((request.offset !== undefined && (!sequence(request.offset) || request.offset > 4294967295)) || (request.limit !== undefined && (!sequence(request.limit) || request.limit < 1 || request.limit > 200)) || (request.visibility !== undefined && !['private', 'shared', 'public'].includes(request.visibility))) throw failure('INVALID_REQUEST', '卷轴列表分页参数无效。');
    const query = { offset: request.offset ?? 0, limit: request.limit ?? 50, ...(request.visibility === undefined ? {} : { visibility: request.visibility }) };
    const expected = this._context();
    return this._read('scroll', expected, async request2 => scrollListDto(await request2('/api/scrolls', { query }), query), { signal });
  }

  async getScroll(value: unknown, { signal }: { signal?: AbortSignal } = {}): Promise<{ scroll: TownScrollDetail }> {
    const request = plainRequest<{ id?: unknown; offset?: number; limit?: number }>(value, ['id', 'offset', 'limit'], ['id']);
    if (!scrollId(request.id) || (request.offset !== undefined && (!sequence(request.offset) || request.offset > 4294967295)) || (request.limit !== undefined && (!sequence(request.limit) || request.limit < 1 || request.limit > 10000))) throw failure('INVALID_REQUEST', '请选择有效的卷轴和正文页码。');
    const query = { offset: request.offset ?? 0, limit: request.limit ?? 10000 };
    const expected = this._context();
    return this._read('scroll', expected, async request2 => scrollDto(await request2(`/api/scrolls/${request.id}`, { query }), request.id as string, query), { signal });
  }

  async listBeings(value: unknown = {}, { signal }: { signal?: AbortSignal } = {}): Promise<{ beings: TownBeingEntry[]; source: string; detail: string }> {
    plainRequest(value, [], []);
    const epoch = this._epoch;
    const context = this.getContext() as Record<string, unknown>;
    const unchanged = () => {
      const current = this.getContext() as Record<string, unknown>;
      if (epoch !== this._epoch || ['connectionId', 'identityRevision', 'beingId', 'beingName'].some(key => current[key] !== context[key])) throw failure('SESSION_CHANGED', '连接身份已变化，请重新读取居民目录。');
    };
    checkAborted(signal);
    const detail = '人类伙伴信息暂未公开。';
    try {
      // The public homepage contains the complete community. Periodic directory
      // refreshes need neither a Being chat turn nor protected Town credentials.
      unchanged();
      const value2 = await this._request('/api', { signal }) as WireRecord;
      unchanged();
      checkAborted(signal);
      const beings = beingsDto({ beings: value2.community });
      this._set('beings', 'ready');
      return { beings, source: 'public', detail: `Town 公开居民目录。${detail}` };
    } catch (error) {
      unchanged();
      if (errorCode(error) !== 'ABORTED') this._set('beings', 'error', errorMessage(error));
      throw error;
    }
  }

  async getBonfireMessages(value: unknown = {}, { signal }: { signal?: AbortSignal } = {}): Promise<TownMessagePage> {
    const request = plainRequest<{ since?: number; limit?: number }>(value, ['since', 'limit'], []);
    if ((request.since !== undefined && !sequence(request.since)) || (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 200))) throw failure('INVALID_REQUEST', '篝火消息分页参数无效。');
    const expected = this._context();
    return this._read('bonfire', expected, async request2 => {
      const [response, members] = await Promise.all([
        request2('/api/bonfire/hear', { query: { limit: request.limit || 10, ...(request.since === undefined ? {} : { since: request.since }) } }),
        this.getMembers({ signal }).then(result => result.members).catch((error: unknown) => { if (errorCode(error) === 'ABORTED') throw error; return [] as TownMember[]; }),
      ]);
      this._context(expected);
      checkAborted(signal);
      return messagesDto(response, members);
    }, { signal });
  }

  async getDirectMessages(value: unknown = {}, { signal }: { signal?: AbortSignal } = {}): Promise<{ messages: TownDirectMessage[] }> {
    plainRequest(value, [], []);
    const expected = this._context();
    return this._read('inbox', expected, async request => directMessagesDto(await request('/api/messages')), { signal });
  }

  async getFiresides(value: unknown = {}, { signal }: { signal?: AbortSignal } = {}): Promise<{ owned: TownFiresideRoom[]; joined: TownFiresideRoom[] }> {
    plainRequest(value, [], []);
    const expected = this._context();
    return this._read('fireside', expected, async request => firesidesDto(await request('/api/fireside/list')), { signal });
  }

  async getFiresideMembers(value: unknown, { signal }: { signal?: AbortSignal } = {}): Promise<{ members: TownFiresideMember[] }> {
    const id = firesideId(value);
    const expected = this._context();
    return this._read('fireside', expected, async request => firesideMembersDto(await request('/api/fireside/members', { query: { fireside_id: id } })), { signal });
  }

  async getFiresideMessages(value: unknown, { signal }: { signal?: AbortSignal } = {}): Promise<TownMessagePage> {
    const request = plainRequest<{ firesideId?: unknown; since?: number; limit?: number }>(value, ['firesideId', 'since', 'limit'], ['firesideId']);
    const id = firesideId(request.firesideId);
    if ((request.since !== undefined && !sequence(request.since)) || (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 200))) throw failure('INVALID_REQUEST', '围炉消息分页参数无效。');
    const expected = this._context();
    return this._read('fireside', expected, async request2 => firesideMessagesDto(await request2('/api/fireside/hear', { query: { fireside_id: id, limit: request.limit || 10, ...(request.since === undefined ? {} : { since: request.since }) } }), expected), { signal });
  }

  async _beingRequest(route: string, { query, expected, signal }: { query?: Record<string, unknown>; expected: TownSessionPin; signal?: AbortSignal }): Promise<unknown> {
    this._context(expected);
    checkAborted(signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    this._requests.add(controller);
    try {
      const value = await this.readImpl!(route, { query, signal: controller.signal });
      this._context(expected);
      checkAborted(signal);
      return value;
    } catch (error) {
      this._context(expected);
      checkAborted(signal);
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      this._requests.delete(controller);
      controller.abort();
    }
  }

  async _read<T>(area: TownSessionArea, expected: TownSessionPin, callback: (request: RequestFn) => Promise<T>, { signal }: { signal?: AbortSignal } = {}): Promise<T> {
    try {
      const throughBeing = Boolean(this.readImpl && ['bonfire', 'fireside', 'scroll', 'beings', 'inbox'].includes(area));
      // The injected transport verifies the authenticated Town identity.
      // Production uses a separately paired client token.
      if (!throughBeing) await this._authorized(area, expected, { signal });
      checkAborted(signal);
      const request: RequestFn = (route, options = {}) => throughBeing
        ? this._beingRequest(route, { ...options, expected, signal })
        : this._request(route, { ...options, expected, signal }).then(async value => {
          if (Object.hasOwn(value as object, 'town_id') && !matchesTownIdentity(value, await this._townIdentity(expected, signal))) throw failure('IDENTITY_MISMATCH', 'Town 返回的身份与当前 Being 不一致。');
          return normalizeTownResponse(value, route, expected.loomBeingId);
        });
      const value = await callback(request);
      this._context(expected);
      checkAborted(signal);
      if (throughBeing) this._set(area, 'ready');
      return value;
    }
    catch (error) { this._context(expected); if (errorCode(error) !== 'ABORTED') this._set(area, errorCode(error) === 'AUTH_REQUIRED' ? 'auth_required' : 'error', errorMessage(error)); throw error; }
  }

  async _mutate<T>(area: string, expected: TownSessionPin, callback: () => Promise<T>): Promise<T> {
    if (this._mutations.has(area)) throw failure('BUSY', '当前操作正在提交，请等待结果。');
    const marker = `${this._epoch}:${area}`;
    this._mutations.add(area);
    try { await this._authorized(area, expected); return await callback(); }
    catch (error) { this._context(expected); this._set(area, errorCode(error) === 'AUTH_REQUIRED' ? 'auth_required' : 'error', errorMessage(error)); throw error; }
    finally { if (marker === `${this._epoch}:${area}`) this._mutations.delete(area); }
  }

  async sendBonfireMessage(value: unknown): Promise<unknown> {
    const request = plainRequest<{ content: string; mentions: string[]; connectionRevision: number; requestId?: unknown; replyTo?: unknown }>(value, ['content', 'mentions', 'connectionRevision', 'requestId', 'replyTo'], ['content', 'mentions', 'connectionRevision']);
    if (typeof request.content !== 'string' || !request.content.trim() || request.content.length > 4000 || /[\x00]/.test(request.content) || !Array.isArray(request.mentions) || request.mentions.length > 20 || request.mentions.some(id => typeof id !== 'string' || !ID.test(id)) || !sequence(request.connectionRevision)) throw failure('INVALID_REQUEST', '请输入 1–4000 字的篝火消息，并选择有效成员。');
    const expected = this._context(undefined, request.connectionRevision);
    if (this.writeImpl) {
      // Preserve the selected @mentions while routing writes through Being.
      const mentions = [...new Set(request.mentions)];
      // Exact Town IDs do not depend on a fresh display-name directory. Town's
      // receipt decides delivery, including IDs selected from warning candidates.
      const legacy = mentions.filter(id => !/^t_[A-Za-z0-9_-]+$/.test(id));
      const { members } = legacy.length ? await this.getMembers() : { members: [] as TownMember[] };
      this._context(expected);
      if (legacy.some(id => !members.some(member => member.id === id))) throw failure('INVALID_REQUEST', '所选 Being 已不在成员目录，请重新选择。');
      const missing = mentions.filter(id => !new RegExp(`(^|\\s)@${id}(?=$|[^A-Za-z0-9_-])`).test(request.content));
      const content = (missing.length ? missing.map(id => `@${id}`).join(' ') + '\n' : '') + request.content;
      const result = await this.writeImpl({ kind: 'bonfire', content, connectionRevision: request.connectionRevision, ...(request.requestId ? { requestId: request.requestId } : {}), ...(request.replyTo ? { replyTo: request.replyTo } : {}) });
      this._context(expected);
      return result;
    }
    return this._mutate('bonfire', expected, async (): Promise<TownSendResult> => {
      const mentions = [...new Set(request.mentions)];
      const legacy = mentions.filter(id => !/^t_[A-Za-z0-9_-]+$/.test(id));
      const { members } = legacy.length ? await this.getMembers() : { members: [] as TownMember[] };
      this._context(expected);
      if (legacy.some(id => !members.some(member => member.id === id))) throw failure('INVALID_REQUEST', '所选 Being 已不在成员目录，请重新选择。');
      const missing = mentions.filter(id => !new RegExp(`(^|\\s)@${id}(?=$|[^A-Za-z0-9_-])`).test(request.content));
      const message = (missing.map(id => `@${id}`).join(' ') + (missing.length ? '\n' : '') + request.content).trim();
      if (message.length > 4000) throw failure('INVALID_REQUEST', '加入 @成员后消息超过 4000 字，请缩短内容。');
      const response = await this._request('/api/bonfire/speak', { expected, body: { message }, mutation: true }) as WireRecord;
      if (response.ok !== true || !sequence(response.seq) || !matchesTownIdentity(response, await this._townIdentity(expected)) || !Array.isArray(response.mentions)) throw failure('RESULT_UNKNOWN', '篝火未返回完整发送确认，请刷新消息后核对；不要重复提交。');
      this._set('bonfire', 'ready');
      return { ok: true, id: String(response.seq), ...(Object.hasOwn(response, 'mention_warnings') ? { mention_warnings: response.mention_warnings } : {}), mentions: response.mentions.filter((name: unknown) => typeof name === 'string').slice(0, 20).map((name: string) => text(name, 100)) };
    });
  }

  async getChannelStatus({ signal }: { signal?: AbortSignal } = {}): Promise<{ channels: TownChannelStatus[] }> {
    const expected = this._context();
    return this._read('channel', expected, async () => {
      const value = await this._request('/api/channels/status', { expected, signal, query: { being_id: expected.loomBeingId } }) as WireRecord;
      if ((Object.hasOwn(value, 'town_id') || Object.hasOwn(value, 'being')) && !matchesTownIdentity(value, await this._townIdentity(expected, signal))) throw failure('IDENTITY_MISMATCH', '渠道状态返回了不同的 Town 身份。');
      const list = Array.isArray(value.channels) ? value.channels : record(value.channels) ? Object.entries(value.channels).map(([channel, entry]) => ({ ...(record(entry) ? entry : {}), channel })) : [value];
      return { channels: ['feishu', 'wechat'].map(channel => channelDto(list.find((item: unknown) => record(item) && item.channel === channel), channel)) };
    }, { signal });
  }

  async beginChannelConnection(value: unknown): Promise<TownChannelStatus & { ok: true }> {
    const request = plainRequest<{ channel: string; connectionRevision: number }>(value, ['channel', 'connectionRevision']);
    if (!['feishu', 'wechat'].includes(request.channel) || !sequence(request.connectionRevision)) throw failure('INVALID_REQUEST', '请选择飞书或微信渠道。');
    const expected = this._context(undefined, request.connectionRevision);
    return this._mutate('channel', expected, async () => {
      const response = await this._request('/api/channels/register', { expected, body: { channel: request.channel, being_id: expected.beingId }, mutation: true }) as WireRecord;
      const result = channelDto(response, request.channel);
      if (response.ok !== true && !['registered', 'pending', 'waiting', 'connected'].includes(result.status)) throw failure('RESULT_UNKNOWN', '渠道登记结果尚未确认，请先刷新状态。');
      if (result.qrCodeUrl && !result.qrCodeDataUrl) {
        result.qrCodeDataUrl = await this._qrImage(result.qrCodeUrl, expected);
        if (!result.qrCodeDataUrl) result.detail = '渠道已登记，扫码图像暂时无法读取，请刷新渠道状态。';
      }
      return { ok: true as const, ...result };
    });
  }

  async _qrImage(url: string, expected: TownSessionPin): Promise<string> {
    // Only URLs already validated by channelDto reach this reader. Remote SVG,
    // HTML, redirects, cookies and scripts never enter the privileged renderer.
    this._context(expected);
    const controller = new AbortController();
    this._requests.add(controller);
    try {
      const response = await this.fetchImpl(url, { method: 'GET', headers: { Accept: 'image/png,image/jpeg,image/webp' }, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal });
      this._context(expected);
      const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!response.ok || !['image/png', 'image/jpeg', 'image/webp'].includes(mime) || Number(response.headers.get('content-length')) > MAX_QR_BYTES) return '';
      const reader = response.body?.getReader();
      if (!reader) return '';
      const chunks: Buffer[] = [];
      let length = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > MAX_QR_BYTES) return '';
          chunks.push(Buffer.from(part.value));
        }
      } finally { try { await reader.cancel(); } catch { /* Cleanup does not change channel registration. */ } }
      this._context(expected);
      return imageData(Buffer.concat(chunks), mime);
    } catch { this._context(expected); return ''; }
    finally { controller.abort(); this._requests.delete(controller); }
  }

  async updateFeishuCredentials(value: unknown): Promise<{ ok: true; channel: string; status: string; detail: string }> {
    const request = plainRequest<{ appId: string; appSecret: string; connectionRevision: number }>(value, ['appId', 'appSecret', 'connectionRevision']);
    if (typeof request.appId !== 'string' || !/^cli_[A-Za-z0-9_-]{1,120}$/.test(request.appId) || typeof request.appSecret !== 'string' || request.appSecret.length < 1 || request.appSecret.length > 4096 || /[\x00-\x20\x7f]/.test(request.appSecret) || !sequence(request.connectionRevision)) throw failure('INVALID_REQUEST', '请输入有效的飞书 App ID 和 App Secret。');
    const expected = this._context(undefined, request.connectionRevision);
    return this._mutate('channel', expected, async () => {
      const response = await this._request('/api/channels/credentials', { expected, body: { channel: 'feishu', app_id: request.appId, app_secret: request.appSecret }, mutation: true }) as WireRecord;
      if (response.ok !== true) throw failure('RESULT_UNKNOWN', '飞书配置结果尚未确认，请先刷新渠道状态。');
      return { ok: true as const, channel: 'feishu', status: 'pending', detail: '凭据已提交，请在飞书完成机器人设置并刷新连接状态。' };
    });
  }
}
