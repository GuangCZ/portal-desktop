// Ported from BeingDesktop src/town-pairing.cjs on 2026-09-16.
// portal-desktop already owns desktop/main/town/pairing.ts (requestTownPairCode); this file is the
// BeingDesktop readiness probe and pairing state machine, kept intact and side by side with it.
//
// The pairing conversation has its own scene. Neither another scene's reply nor
// partial text, reasoning, tool output or replay history can authorize this client.
import { codedError, type CodedError } from './errors';
import { parseConnection, sessionPartition, type LoomConnection } from './loom-connection';
import { consumeEvents, type SseData } from './sse';
import type { PairingClient, PairingConnectionContext, TownPairingState } from './types';

export const PAIR_PROMPT = '请帮我完成当前 Being 的 Being Desktop Town 配对：请使用你自己的原生 http 工具执行 POST https://beings.town/api/client/pair，从 Heart 环境发起，无需额外鉴权 header。只回复本次返回 JSON 的 code 字段：六位大写字母和数字，不要解释，不要输出长期 token 或其他凭据。';

export const PAIRING_ERRORS: Record<string, string> = {
  BUSY: 'Being 或 Town 正在处理请求，请完成后再连接 Town。',
  NOT_CONNECTED: '请先连接 Being。',
  SESSION_CHANGED: 'Being 连接已变化，旧配对请求已取消。',
  READINESS_UNKNOWN: '未能确认 Being 是否空闲，本次配对请求未发送。请稍后重试。',
  PAIRING_INCOMPLETE: '未取得可确认的配对码。请查看 Being 的回复，使用六位码手动配对；本次请求不会自动重发。',
};

const fail = (code: string): CodedError => codedError(code, PAIRING_ERRORS[code]);

const PAIR_CODE = /^[A-Z0-9]{6}$/;

/** A reply authorizes pairing only when it is exactly one unambiguous six-character code. */
export const pairCodeFrom = (text: string): string => PAIR_CODE.test(text.trim()) ? text.trim() : '';

/**
 * Readiness probe verdict. 204 means idle. Anything that is not a readable JSON
 * verdict leaves readiness unknown, and an unfinished stream means the Being is busy:
 * neither may send the pairing message.
 *
 * `data` is dereferenced without a guard, as town-pairing.cjs does: a JSON `null` body throws a
 * TypeError that the caller's catch turns into READINESS_UNKNOWN, not BUSY.
 */
export const readinessVerdict = (status: number, ok: boolean, contentType: string | null, data: unknown): '' | 'BUSY' | 'READINESS_UNKNOWN' => {
  if (status === 204) return '';
  if (!ok || !contentType?.includes('application/json')) return 'READINESS_UNKNOWN';
  return (data as { finished?: unknown }).finished === true ? '' : 'BUSY';
};

/** Events carry their own scene; the last `meta` scene applies to events that omit it. */
export const eventScene = (data: SseData, current: string): string =>
  typeof data.scene_id === 'string' ? data.scene_id : current;

/** Only assistant text counts. Reasoning and tool results are not pairing codes. */
export const deltaText = (type: string, data: SseData): unknown =>
  type === 'content_block_delta' ? data.delta?.text : ['text', 'text_delta'].includes(type) ? data.text ?? data.delta : '';

/**
 * A failure before the chat request was dispatched leaves readiness, not pairing, unknown.
 * Any truthy `code` wins, as `error.code || ...` did in town-pairing.cjs: an aborted or timed-out
 * fetch rejects with a DOMException whose legacy `code` is numeric (AbortError 20,
 * TimeoutError 23), and that value reaches the renderer unchanged.
 */
export const pairingFailureCode = (error: unknown, dispatched: boolean): string | number =>
  (error as { code?: string | number }).code || (dispatched ? 'PAIRING_INCOMPLETE' : 'READINESS_UNKNOWN');

export interface TownPairingOptions {
  getContext: () => PairingConnectionContext | null | undefined;
  client: PairingClient;
  fetchImpl?: typeof fetch;
  onChange?: () => void;
  timeoutMs?: number;
  createScene?: () => string;
}

interface PairingSnapshot { connection: LoomConnection; key: string; revision: unknown; epoch: number }

export class TownPairing {
  private getContext: () => PairingConnectionContext | null | undefined;
  private client: PairingClient;
  private fetchImpl: typeof fetch;
  private onChange: () => void;
  private timeoutMs: number;
  private createScene: () => string;
  private _epoch = 0;
  private _controller: AbortController | null = null;
  private _state: TownPairingState = { status: 'idle', busy: false, errorCode: '' };

  constructor({ getContext, client, fetchImpl = globalThis.fetch, onChange = () => {}, timeoutMs = 90000, createScene = () => `desktop-${crypto.randomUUID()}-${crypto.randomUUID()}` }: TownPairingOptions) {
    this.getContext = getContext;
    this.client = client;
    this.fetchImpl = fetchImpl;
    this.onChange = onChange;
    this.timeoutMs = timeoutMs;
    this.createScene = createScene;
  }

  state(): TownPairingState { return { ...this._state }; }

  private _set(value: Partial<TownPairingState>) {
    Object.assign(this._state, value);
    try { this.onChange(); } catch { /* a listener must never break pairing */ }
  }

  reset() {
    this._epoch++;
    this._controller?.abort();
    this._controller = null;
    this._set({ status: 'idle', busy: false, errorCode: '' });
  }

  private _context(expected?: PairingSnapshot): PairingSnapshot {
    const value = this.getContext();
    if (!value?.connected || !value.connection) throw fail('NOT_CONNECTED');
    const raw = value.connection;
    const connection = parseConnection((typeof raw === 'object' && raw ? raw.url : undefined) || raw);
    const context: PairingSnapshot = { connection, key: sessionPartition(connection), revision: value.revision, epoch: this._epoch };
    if (expected && (context.key !== expected.key || context.revision !== expected.revision || context.epoch !== expected.epoch)) throw fail('SESSION_CHANGED');
    return context;
  }

  async connect(): Promise<unknown> {
    if (this._state.busy || this.client.pairing) throw fail('BUSY');
    const ctx = this._context();
    this.client.store.assertAvailable?.();
    if (this.client.state().pairingPending) return this.client.retryPairStorage?.();
    if (!ctx.connection.token) throw fail('NOT_CONNECTED');
    const controller = new AbortController();
    this._controller = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.timeoutMs)]);
    const url = (route: string) => { const u = new URL(ctx.connection.apiBase + route); u.searchParams.set('token', ctx.connection.token); return u.href; };
    const options: RequestInit = { signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store' };
    this._set({ status: 'requesting', busy: true, errorCode: '' });
    let response: Response | undefined, dispatched = false;
    try {
      const active = await this.fetchImpl(url('/api/stream/active'), options);
      try {
        this._context(ctx);
        if (active.status !== 204) {
          if (!active.ok || !active.headers.get('content-type')?.includes('application/json')) throw fail('READINESS_UNKNOWN');
          const data = await active.json();
          const verdict = readinessVerdict(active.status, active.ok, active.headers.get('content-type'), data);
          if (verdict) throw fail(verdict);
        }
      } finally { void active.body?.cancel().catch(() => {}); }
      this._context(ctx);
      if (signal.aborted) throw fail('READINESS_UNKNOWN');
      const scene = this.createScene();
      this._context(ctx);
      dispatched = true;
      response = await this.fetchImpl(url('/api/chat/stream'), { ...options, method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ message: PAIR_PROMPT, scene_id: scene, session_id: scene, client_ref: crypto.randomUUID(), scene_meta: { client: 'being-desktop', scene_label: 'Town 配对' } }) });
      this._context(ctx);
      if (!response.ok || response.status === 202 || !response.headers.get('content-type')?.includes('text/event-stream')) throw fail('PAIRING_INCOMPLETE');
      let current = '', text = '', complete = false, failed = false;
      const replyComplete = {};
      try {
        await consumeEvents(response.body, (type, data) => {
          this._context(ctx);
          if (signal.aborted) throw fail('PAIRING_INCOMPLETE');
          if (type === 'meta') { current = typeof data.scene_id === 'string' ? data.scene_id : ''; return; }
          if (eventScene(data, current) !== scene) return;
          if (type === 'error') { failed = true; return; }
          const delta = deltaText(type, data);
          if (typeof delta === 'string' && delta) { text += delta; complete = false; }
          if (text.length > 2000) throw fail('PAIRING_INCOMPLETE');
          if (['message_stop', 'done'].includes(type)) {
            complete = true;
            // A later continuation can keep this HTTP stream open for another scene.
            // Once our complete, unambiguous reply arrives, stop listening locally.
            if (!failed && pairCodeFrom(text)) throw replyComplete;
          }
        });
      } catch (error) { if (error !== replyComplete) throw error; }
      this._context(ctx);
      if (signal.aborted || failed || !complete || !pairCodeFrom(text)) throw fail('PAIRING_INCOMPLETE');
      const result = await this.client.pair({ code: text.trim() });
      this._context(ctx);
      this._set({ status: 'complete', errorCode: '' });
      return result;
    } catch (error) {
      this._context(ctx);
      const code = pairingFailureCode(error, dispatched);
      this._set({ status: 'manual_required', errorCode: code });
      // A numeric DOMException code is never a PAIRING_ERRORS key, so the original error is rethrown.
      throw PAIRING_ERRORS[code] ? fail(String(code)) : error;
    } finally {
      void response?.body?.cancel().catch(() => {});
      controller.abort();
      if (this._controller === controller) { this._controller = null; this._set({ busy: false }); }
    }
  }
}
