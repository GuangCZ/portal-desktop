// Ported from BeingDesktop extensions/being-anywhere/being-client.mjs on 2026-09-16.
// Scope: exactly what src/channel-being.cjs dynamically imports — the connection parser,
// the SSE consumer, and BeingClient.request/send. readHistory, status, readActiveStream,
// normalizeSelection and composeMessage belong to the chat migration unit and are not here.
//
// MESSAGES.auth is load-bearing: ChannelBeing recognizes an expired credential by that exact
// string, so neither the wording nor the code may drift.

const MAX_EVENT_CHARS = 256 * 1024;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const EVENTS = new Set(['meta', 'content_block_delta', 'thinking', 'reasoning', 'tool_use', 'tool_result', 'message_stop', 'error']);

export const MESSAGES: Record<string, string> = {
  connection: '请输入有效的 Loom 连接地址。',
  origin: 'Loom 和 API 必须使用同一来源；远程连接须使用 HTTPS。',
  response: 'Being 返回了无法识别的数据，请检查 Loom 连接地址。',
  network: '无法连接 Being，请检查网络与 Loom 地址后重试。',
  auth: '连接凭据无效或已过期，请更新 Loom 连接地址。',
  unavailable: 'Being 暂时无法处理请求，请稍后重试。',
  limit: 'Being 返回的内容过长，已停止接收。',
  stream: 'Being 的回复中断，请查看已有内容后再决定是否重试。',
};

export class ClientError extends Error {}
const fail = (kind: string) => Object.assign(new ClientError(MESSAGES[kind]), { code: kind });
const isRecord = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasControl = (value: string) => /[\u0000-\u001f\u007f]/u.test(value);

function clip(value: string, limit: number) {
  const result = value.slice(0, limit);
  return /[\uD800-\uDBFF]$/u.test(result) ? result.slice(0, -1) : result;
}

function safeError(error: any, kind = 'network') {
  if (error?.name === 'AbortError') return new DOMException('请求已取消。', 'AbortError');
  return error instanceof ClientError ? error : fail(kind);
}

export interface ClientConnection { url: string; apiBase: string; token: string; displayUrl: string; beingName: string; origin: string }

export function parseConnection(input: unknown): ClientConnection {
  if (typeof input !== 'string' || input.length > 8192 || !input.trim() || hasControl(input.trim())) throw fail('connection');
  try {
    const text = input.trim();
    if (!/^https?:\/\//iu.test(text) || text.includes('\\') || hasControl(decodeURIComponent(text))) throw fail('connection');
    const url = new URL(text);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local)) || url.username || url.password) throw fail('origin');
    for (const key of ['api', 'token', 'secret', 'relay_secret']) {
      if (url.searchParams.getAll(key).length > 1) throw fail('connection');
    }
    const token = url.searchParams.get('token') || '';
    if (token.length > 4096 || hasControl(token)) throw fail('connection');
    const apiValue = url.searchParams.get('api');
    if (apiValue !== null && (!/^https?:\/\//iu.test(apiValue) || apiValue.includes('\\') || apiValue !== apiValue.trim())) throw fail('connection');
    const api = new URL(apiValue === null ? `${url.origin}${url.pathname.replace(/\/+$/, '')}` : apiValue);
    if (api.origin !== url.origin || api.href.includes('?') || api.href.includes('#') || api.username || api.password || hasControl(decodeURIComponent(api.href))) throw fail('origin');
    url.hash = '';
    return {
      url: url.href,
      apiBase: api.href.replace(/\/+$/, ''),
      token,
      displayUrl: `${url.origin}${url.pathname}`,
      beingName: clip(decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || 'Being'), 100),
      origin: url.origin,
    };
  } catch (error) {
    throw safeError(error, 'connection');
  }
}

function discardBody(body: ReadableStream<Uint8Array> | null | undefined) {
  try { void body?.cancel().catch(() => {}); } catch { /* A locked body is closed by its reader. */ }
}

function checkResponse(response: Response) {
  if (!response || typeof response.status !== 'number' || response.redirected) {
    discardBody(response?.body);
    throw fail('response');
  }
  if (response.status >= 200 && response.status < 300) return;
  discardBody(response.body);
  if ([401, 403].includes(response.status)) throw fail('auth');
  if (response.status === 429 || response.status >= 500) throw fail('unavailable');
  throw fail('response');
}

export interface ClientEvent { type: string; data: Record<string, any> }
export interface ConsumeOptions { onFrame?: (frame: { type: string }) => void; signal?: AbortSignal }

export async function consumeSSE(body: ReadableStream<Uint8Array> | null | undefined, onEvent: (event: ClientEvent) => void = () => {}, { onFrame = () => {}, signal }: ConsumeOptions = {}): Promise<void> {
  if (!body?.getReader || typeof onEvent !== 'function') throw fail('response');
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let eventType = '';
  let dataLines: string[] = [];
  let eventSize = 0;
  let wireSize = 0;
  let eventCount = 0;
  let complete = false;
  const abortReader = () => { try { void reader.cancel().catch(() => {}); } catch { /* Preserve cancellation. */ } };
  signal?.addEventListener('abort', abortReader, { once: true });

  const dispatch = () => {
    // Loom assigns replay sequence numbers to every non-meta frame, including
    // future event types that this client intentionally does not render.
    if (dataLines.length && EVENTS.has(eventType)) {
      let data: unknown;
      try { data = JSON.parse(dataLines.join('\n')); } catch { throw fail('response'); }
      if (!isRecord(data)) throw fail('response');
      eventCount += 1;
      if (eventCount > 50000) throw fail('limit');
      onFrame({ type: eventType });
      if (eventType === 'error') {
        onEvent({ type: 'error', data: { message: MESSAGES.stream } });
        throw fail('stream');
      }
      onEvent({ type: eventType, data });
    } else if (dataLines.length && eventType) onFrame({ type: eventType });
    eventType = '';
    dataLines = [];
    eventSize = 0;
  };

  const line = (value: string) => {
    if (!value) { dispatch(); return; }
    if (value.startsWith(':')) return;
    eventSize += value.length;
    if (eventSize > MAX_EVENT_CHARS) throw fail('limit');
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let data = colon < 0 ? '' : value.slice(colon + 1);
    if (data.startsWith(' ')) data = data.slice(1);
    if (field === 'event') eventType = data;
    if (field === 'data') dataLines.push(data);
  };

  const CR = '\r', LF = '\n';
  const drain = (atEOF = false) => {
    let start = 0;
    for (let index = 0; index < pending.length; index += 1) {
      if (pending[index] !== CR && pending[index] !== LF) continue;
      if (pending[index] === CR && index === pending.length - 1 && !atEOF) break;
      line(pending.slice(start, index));
      if (pending[index] === CR && pending[index + 1] === LF) index += 1;
      start = index + 1;
    }
    pending = pending.slice(start);
    if (pending.length + eventSize > MAX_EVENT_CHARS) throw fail('limit');
    if (atEOF) {
      if (pending) line(pending);
      pending = '';
      // Loom can close directly after its final data line.
      dispatch();
    }
  };

  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('请求已取消。', 'AbortError');
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new DOMException('请求已取消。', 'AbortError');
      if (done) break;
      wireSize += value.byteLength;
      if (wireSize > MAX_STREAM_BYTES) throw fail('limit');
      pending += decoder.decode(value, { stream: true });
      drain();
    }
    pending += decoder.decode();
    drain(true);
    complete = true;
  } catch (error) {
    throw safeError(error, 'stream');
  } finally {
    signal?.removeEventListener('abort', abortReader);
    if (!complete) { try { void reader.cancel().catch(() => {}); } catch { /* Preserve the original error. */ } }
    reader.releaseLock();
  }
}

export interface SendRequest {
  message: string;
  sessionId?: string | null;
  signal?: AbortSignal;
  onEvent?: (event: ClientEvent) => void;
  onFrame?: (frame: { type: string }) => void;
}

export class BeingClient {
  connection: ClientConnection;
  private fetch: typeof fetch;

  constructor(connection: string | { url?: string } | null | undefined, fetchImpl: typeof fetch = globalThis.fetch) {
    this.connection = Object.freeze(parseConnection(typeof connection === 'string' ? connection : connection?.url));
    if (typeof fetchImpl !== 'function') throw fail('connection');
    // Native browser fetch requires its Window or Worker global as receiver.
    this.fetch = fetchImpl.bind(globalThis);
  }

  async request(route: string, { signal, ...options }: RequestInit = {}): Promise<Response> {
    const url = new URL(this.connection.apiBase + route);
    if (this.connection.token) url.searchParams.set('token', this.connection.token);
    try {
      const response = await this.fetch(url.href, {
        ...options,
        signal,
        redirect: 'error',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      });
      checkResponse(response);
      return response;
    } catch (error) {
      throw safeError(error);
    }
  }

  async send({ message, sessionId, signal, onEvent = () => {}, onFrame = () => {} }: SendRequest): Promise<{ accepted: boolean }> {
    if (typeof message !== 'string' || !message.trim() || message.length > 160000) throw new ClientError('发送内容为空或过长，请缩短后重试。');
    if (sessionId !== undefined && sessionId !== null && (typeof sessionId !== 'string' || sessionId.length > 512 || hasControl(sessionId))) throw new ClientError('会话标识无效，请重新开始对话。');
    const requestBody: Record<string, unknown> = { message };
    if (sessionId) requestBody.session_id = sessionId;
    const response = await this.request('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(requestBody),
      signal,
    });
    if (response.status === 202) {
      discardBody(response.body);
      return { accepted: true };
    }
    if (response.headers?.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'text/event-stream') {
      discardBody(response.body);
      throw fail('response');
    }
    let sawMessageStop = false;
    let replyPending = false;
    await consumeSSE(response.body, (event) => {
      if (event.type === 'message_stop') {
        sawMessageStop = true;
        replyPending = false;
      } else if (['content_block_delta', 'thinking', 'reasoning', 'tool_use'].includes(event.type)) {
        replyPending = true;
      }
      onEvent(event);
    }, { onFrame, signal });
    // EOF closes the turn, but every started reply must have a completion marker.
    if (!sawMessageStop || replyPending) throw fail('stream');
    return { accepted: false };
  }
}
