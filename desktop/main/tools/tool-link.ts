// Ported line by line from BeingDesktop 0.8.26 src/desktop-tool-link.cjs on 2026-09-16.
// Desktop acts as the MCP *server* on a reverse WebSocket to the Portal relay:
// handshake {being_id, loom_token, portal_name} → {ok:true, relay_keepalive:'text-v1'}
// → JSON-RPC initialize → tools/list → tools/call.
// See docs/architecture.md §5.4「桌面工具桥（直接模式）」and docs/interfaces.md §6
// 「/_relay 反向 MCP 协议」. Heartbeat is 15s, liveness deadline 90s, and only the
// orchestrator mode reconnects (2/4/8… capped at 60s).
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import os from 'node:os';
import { parseConnection } from './security';
import type { InvokeTool, ToolContent, ToolResult } from './types';

export const MAX_MESSAGE_BYTES = 131072;
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_PENDING = 4;
export const MAX_REQUESTS = 16384;
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 15000;
const HEARTBEAT_DEADLINE_MS = 90000;

/** The WebSocket surface this link uses; `ws` and the test double both satisfy it. */
export interface ToolSocket {
  readyState: number;
  bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  on?(event: string, listener: (...args: any[]) => void): void;
  ping?(data?: unknown, callback?: (error?: Error | null) => void): void;
}
export type ToolSocketFactory = new (url: string) => ToolSocket;
export type TimerId = any;
export interface Timers {
  setTimeout(callback: () => void, ms: number): TimerId;
  clearTimeout(id: TimerId): void;
  setInterval(callback: () => void, ms: number): TimerId;
  clearInterval(id: TimerId): void;
}

export type LinkStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export interface LastCall { name: string; status: 'pending' | 'completed' | 'failed' | 'cancelled'; at: number }
export interface ToolLinkSnapshot {
  status: LinkStatus;
  error: string;
  lastCall: LastCall | null;
  calls: number;
  reconnect?: { attempt: number; delayMs: number };
  pending: { id: string; name: string; startedAt: number }[];
}
export interface ToolLinkCapabilities { status: LinkStatus; place: string; hostname: string; platform: string; tools: string[] }
export interface ToolLinkOptions {
  onChange?: (snapshot: ToolLinkSnapshot) => void;
  invokeTool: InvokeTool;
  portalName?: string;
  toolAllowed?: (name: string) => boolean;
  WebSocketImpl?: ToolSocketFactory;
  clock?: () => number;
  timers?: Timers;
  shouldReconnect?: () => boolean;
}

// `ws` ships no TypeScript declarations, and the relay only needs the narrow
// surface above. Resolve it lazily so an injected transport never loads it.
//
// PACKAGING CONTRACT (measured 2026-09-16, not inferred): `ws` must be a runtime
// dependency of the packaged app. It currently sits in devDependencies, which
// @electron/packager prunes out of the asar, so this require would fail with
// MODULE_NOT_FOUND in a release build; BeingDesktop 0.8.26 keeps "ws" in
// dependencies. Integration must move it there — bundling `ws` into the main
// chunk instead does NOT work: Vite replaces ws's unresolvable optional peer
// deps with empty stubs (__viteOptionalPeerDep_bufferutil_ws), so ws's own
// try/catch never fires and the first outbound frame throws
// "TypeError: bufferUtil.mask is not a function". See docs/migration/u4-tools.md
// 「未完成 / 存疑」.
const nodeRequire = createRequire(import.meta.url);
const defaultWebSocket = (): ToolSocketFactory => nodeRequire('ws').WebSocket as ToolSocketFactory;

const targetReceipt = (place: string): ToolContent => ({type:'text',text:JSON.stringify({execution_target:{place,hostname:os.hostname(),platform:process.platform}})});
const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

interface Rule {
  type?: string | string[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  enum?: unknown[];
  description?: string;
}
interface InputSchema { type: 'object'; properties: Record<string, Rule>; required: string[]; additionalProperties: false }
export interface ToolDefinition { name: string; description: string; inputSchema: InputSchema }

const string = (maxLength: number, minLength = 1): Rule => ({type:'string',minLength,maxLength});
const tabId = string(128);
const terminalScope: Record<string, Rule> = {sessionId:{type:'string',pattern:UUID},sessionToken:{type:'string',pattern:UUID}};
const terminalId: Rule = {type:'string',pattern:UUID};
const requestId: Rule = {type:'string',pattern:UUID};
const revision: Rule = {type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER};
const tool = (name: string, description: string, properties: Record<string, Rule>, required: string[] = []): ToolDefinition => ({name,description,inputSchema:{type:'object',properties:{...properties,place:string(128),target_portal:string(128)},required:[...required,'place','target_portal'],additionalProperties:false}});
const definitions: ToolDefinition[] = [
  tool('desktop_browser_tabs','List tabs in Being Desktop. Requires local approval.',{}),
  tool('desktop_browser_open','Open an HTTP(S) page in Being Desktop. Omit tabId for a new tab. Requires local approval.',{url:string(8192),tabId},['url']),
  tool('desktop_browser_read','Read visible page text and element selectors. Use the returned revision for subsequent actions. Requires local approval.',{tabId,expectedRevision:revision},['tabId']),
  tool('desktop_browser_click','Click one visible element in the previously read page revision. Requires local approval.',{tabId,selector:string(512),expectedRevision:revision},['tabId','selector','expectedRevision']),
  tool('desktop_browser_fill','Fill one visible input without submitting. Password and file fields are unavailable. Requires local approval.',{tabId,selector:string(512),text:string(8000,0),expectedRevision:revision},['tabId','selector','text','expectedRevision']),
  tool('desktop_browser_screenshot','Capture the browser viewport at the previously read page revision. Requires local approval.',{tabId,expectedRevision:revision},['tabId','expectedRevision']),
  tool('desktop_console_run','Run a command in the selected local workspace. Returns a jobId. Requires local approval.',{command:string(16000),cwd:string(4096)},['command']),
  tool('desktop_console_status','Read command status and output. Supply jobId to select one job. Requires local approval.',{jobId:{type:'string',pattern:UUID}}),
  tool('desktop_console_stop','Stop one command job owned by Being Desktop. Requires local approval.',{jobId:{type:'string',pattern:UUID}},['jobId']),
  tool('desktop_terminal_create','Create and SHOW a persistent interactive terminal (PowerShell/ConPTY on Windows, zsh/PTY on macOS) shared with the user. Use the current message session binding. Runs within the user-authorized task without a separate local approval. Reuse requestId on retries. Survives reply completion and chat switches.',{...terminalScope,requestId,cwd:string(4096)},['sessionId','sessionToken','requestId']),
  tool('desktop_terminal_write','Write to this conversation\'s interactive terminal. Include \\r to press Enter or \\u0003 for Ctrl+C. Use only for the user-authorized task; never type account credentials or make user-only authorization decisions. Reuse requestId on retries to avoid executing twice.',{...terminalScope,terminalId,requestId,data:string(16000)},['sessionId','sessionToken','terminalId','requestId','data']),
  tool('desktop_terminal_read','Read incremental output from this conversation\'s terminal. Pass afterSequence from the previous sequence; continue while hasMore. A running shell or no new output does not prove a command completed or is waiting for input. No separate local approval.',{...terminalScope,terminalId,afterSequence:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER}},['sessionId','sessionToken','terminalId']),
  tool('desktop_terminal_list','List only interactive terminals owned by this conversation. No separate local approval.',terminalScope,['sessionId','sessionToken']),
  tool('desktop_terminal_show','Show and select this conversation\'s shared terminal so the user can take over required account steps. Does not stop its process. No separate local approval.',{...terminalScope,terminalId},['sessionId','sessionToken','terminalId']),
  tool('desktop_terminal_close','Explicitly close this conversation\'s terminal and its processes. Only close when requested or when your task-owned terminal is no longer needed; never close merely because a reply ends. Reuse requestId on retries.',{...terminalScope,terminalId,requestId},['sessionId','sessionToken','terminalId','requestId']),
];
const workerScope: Record<string, Rule> = {sessionId:{type:'string',pattern:UUID},sessionToken:{type:'string',pattern:UUID}};
const nullable = (rule: Rule): Rule => ({...rule,type:['string','null'],...(rule.enum?{enum:[...rule.enum,null]}:{})});
definitions.push(
  tool('desktop_worker_start','Delegate a bounded task to an external agent in the selected workspace. Include context, scope and acceptance criteria in prompt. Returns immediately; completion is sent through Heart callback. Evaluate using status and record the conclusion with desktop_worker_status action=review. Reuse requestId on retries. For follow-up verification/repair, set parentWorkerId and reuse the parent review.followUpRequestId.',{...workerScope,requestId:{type:'string',pattern:UUID},parentWorkerId:{type:'string',pattern:UUID},agentId:string(32),title:string(160),prompt:string(24000)},['sessionId','sessionToken','requestId','title','prompt']),
  tool('desktop_worker_list','List only the workers belonging to this conversation.',workerScope,['sessionId','sessionToken']),
  tool('desktop_worker_status','Read, evaluate or present a completed Desktop worker result; this tool cannot execute commands. For requested webpage delivery, action=present requires sessionId, sessionToken, workerId and exactly one of artifactPath (HTML entry relative to the worker workspace; Desktop hosts static files) or url (an existing HTTP/S service). All unused fields are null. Desktop prepares a result card in the ORIGINAL CONVERSATION, with an Open preview button for its OWN embedded browser. Keep final delivery in that conversation; never send the user to Worker details or ask them to enter a file path. Do not ask a CLI to find iab or its own browser. Then action=read exposes presentation.state; loaded confirms loading only, not interaction tests. Set fields unused by the selected action to null; never invent placeholder UUIDs or outcomes. Default action=read requires sessionId, sessionToken, workerId. For Heart completion events with source=being-desktop-worker and result.protocol=being-desktop-worker-result/1, use action=receive with callbackId=result.callback_id and the declared Portal target; all other fields are null. The trusted bridge validates its saved owner/task and returns the CURRENT original-conversation scope. No historical token is needed for receive. Then read the authoritative result. action=review requires sessionId, sessionToken, workerId, outcome, summary and concrete evidence; callbackId is null. The desktop delivers that conclusion to the original conversation; do not repeat it in a separate reply. alreadyReviewed means no repeated report or dispatch. Missing evidence uses needs_verification; delegate verification to CLI with parentWorkerId and review.followUpRequestId.',{sessionId:nullable(workerScope.sessionId),sessionToken:nullable(workerScope.sessionToken),workerId:nullable({type:'string',pattern:UUID}),action:{type:'string',enum:['read','receive','review','present']},callbackId:nullable({type:'string',pattern:UUID}),outcome:nullable({type:'string',enum:['passed','failed','needs_verification']}),summary:nullable(string(8000)),evidence:nullable(string(8000)),url:nullable(string(8192)),artifactPath:nullable(string(4096))}),
  tool('desktop_worker_wait','Wait up to 30 seconds for this worker to finish, then return its status and recent events. Repeat while running; evaluate results before reporting completion.',{...workerScope,workerId:{type:'string',pattern:UUID}},['sessionId','sessionToken','workerId']),
  tool('desktop_worker_cancel','Stop an external worker owned by this conversation.',{...workerScope,workerId:{type:'string',pattern:UUID}},['sessionId','sessionToken','workerId']),
);

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value: unknown, allowed: string[]): value is Record<string, unknown> { return record(value) && Object.keys(value).every(key => allowed.includes(key)); }
function empty(value: unknown): boolean { return record(value) && Object.keys(value).length === 0; }
function validId(value: unknown): value is string | number { return Number.isSafeInteger(value) && (value as number) >= 0 || typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(value); }
function boundedText(value: unknown, minimum: number, maximum: number): value is string { return typeof value === 'string' && value.length >= minimum && value.length <= maximum && !value.includes('\0'); }
function normalizeWorkerArguments(name: unknown, args: unknown): unknown {
  if(!record(args))return args;
  const clean: Record<string, unknown>={...args};
  // Some model adapters fill optional properties with empty strings or null.
  // Only discard empty fields that have no meaning for the selected operation.
  let optional: string[]=[];
  if(name==='desktop_worker_start')optional=['parentWorkerId','agentId'];
  if(name==='desktop_worker_status') {
    if(clean.action===''||clean.action===null)delete clean.action;
    const action=clean.action||'read';
    optional=action==='receive'?['sessionId','sessionToken','workerId','outcome','summary','evidence','url','artifactPath']:
      action==='review'?['callbackId','url','artifactPath']:action==='present'?['callbackId','outcome','summary','evidence','url','artifactPath']:['callbackId','outcome','summary','evidence','url','artifactPath'];
  }
  for(const key of optional)if(clean[key]===''||clean[key]===null)delete clean[key];
  return clean;
}
export function validArguments(name: unknown, args: unknown): boolean {
  const normalized=normalizeWorkerArguments(name,args);
  const schema = definitions.find(item => item.name === name)?.inputSchema;
  // Hearth consumes the routing selector before forwarding MCP arguments.
  if (!schema || !keys(normalized,Object.keys(schema.properties)) || schema.required.some(key => key !== 'place' && !Object.hasOwn(normalized,key))) return false;
  const fields: Record<string, unknown> = normalized;
  for (const [key,value] of Object.entries(fields)) {
    const rule = schema.properties[key];
    const types=Array.isArray(rule.type)?rule.type:[rule.type];
    if(value===null&&types.includes('null'))continue;
    if(rule.enum&&!rule.enum.includes(value))return false;
    if (types.includes('string') && (!boundedText(value,rule.minLength ?? 0,rule.maxLength ?? 128) || rule.pattern && !new RegExp(rule.pattern).test(value))) return false;
    if (rule.type === 'integer' && (!Number.isSafeInteger(value) || (value as number) < (rule.minimum as number))) return false;
  }
  if(name==='desktop_worker_status') {
    const action=fields.action||'read';
    const required=action==='receive'?['callbackId']:action==='review'?['sessionId','sessionToken','workerId','outcome','summary','evidence']:['sessionId','sessionToken','workerId'];
    if(required.some(key=>!Object.hasOwn(fields,key)||fields[key]===null))return false;
    const allowed=[...required,'action','place','target_portal',...(action==='present'?['url','artifactPath']:[])];
    if(Object.keys(fields).some(key=>!allowed.includes(key)))return false;
    if(action==='present'&&Boolean(fields.url)===Boolean(fields.artifactPath))return false;
  }
  if (name === 'desktop_browser_open') {
    try {
      const url = new URL(fields.url as string);
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password || /[\x00-\x20\x7f]/.test(fields.url as string)) return false;
    } catch { return false; }
  }
  return true;
}

function result(value: unknown): { content: ToolContent[]; isError: boolean } {
  if (!keys(value,['content','isError']) || !Array.isArray(value.content) || (value.content as unknown[]).length > 16 || Object.hasOwn(value,'isError') && typeof value.isError !== 'boolean') throw new Error('Invalid tool result');
  const content: ToolContent[] = (value.content as unknown[]).map((block: unknown) => {
    if (keys(block,['type','text']) && block.type === 'text' && typeof block.text === 'string' && Buffer.byteLength(block.text,'utf8') <= 1024 * 1024) return {type:'text',text:block.text} as ToolContent;
    if (keys(block,['type','mimeType','data']) && block.type === 'image' && ['image/png','image/jpeg','image/webp'].includes(block.mimeType as string) && typeof block.data === 'string' && block.data.length > 0 && block.data.length <= MAX_RESPONSE_BYTES && block.data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(block.data) && Buffer.from(block.data,'base64').toString('base64') === block.data) return {type:'image',mimeType:block.mimeType as string,data:block.data} as ToolContent;
    throw new Error('Invalid tool content');
  });
  return {content,isError:value.isError === true};
}

interface PendingCall { key: string; name: string; startedAt: number; controller: AbortController }
interface LinkState { status: LinkStatus; error: string; lastCall: LastCall | null; calls: number; reconnect?: { attempt: number; delayMs: number } }

export class DesktopToolLink {
  #socket: ToolSocket | null = null;
  #generation = 0;
  #initialized = false;
  #disposed = false;
  #pending = new Map<string, PendingCall>();
  #seen = new Set<string>();
  #onChange: (snapshot: ToolLinkSnapshot) => void;
  #invokeTool: InvokeTool;
  #WebSocket: ToolSocketFactory;
  #clock: () => number;
  #timers: Timers;
  #handshakeTimer: TimerId = null;
  #heartbeatTimer: TimerId = null;
  #connecting: { resolve: (value: ToolLinkSnapshot) => void; reject: (error: Error) => void } | null = null;
  #reconnectTimer: TimerId = null;
  #reconnectAttempt = 0;
  #reconnectConnection: { url: string; token: string } | null = null;
  #shouldReconnect: () => boolean;
  #portalName = `being-desktop-tools-${randomUUID().replaceAll('-','').slice(0,12)}`;
  #state: LinkState = {status:'disconnected',error:'',lastCall:null,calls:0};
  #toolAllowed: (name: string) => boolean;

  constructor({onChange = () => {}, invokeTool, portalName, toolAllowed = name=>!name.startsWith('desktop_worker_'), WebSocketImpl, clock = () => performance.now(), timers = globalThis as unknown as Timers, shouldReconnect = () => false}: ToolLinkOptions) {
    if (typeof invokeTool !== 'function' || typeof onChange !== 'function') throw new Error('工具调用处理器无效。');
    this.#onChange = onChange;
    this.#invokeTool = invokeTool;
    this.#toolAllowed = toolAllowed;
    this.#WebSocket = WebSocketImpl ?? defaultWebSocket();
    this.#clock = clock;
    this.#timers = timers;
    this.#shouldReconnect = shouldReconnect;
    if (portalName !== undefined) {
      if (!/^[a-zA-Z0-9._-]{1,128}$/.test(portalName)) throw new Error('Invalid desktop Portal name');
      this.#portalName = portalName;
    }
  }

  snapshot(): ToolLinkSnapshot {
    return {...this.#state,lastCall:this.#state.lastCall && {...this.#state.lastCall},pending:[...this.#pending.values()].map(item => ({id:item.key,name:item.name,startedAt:item.startedAt}))};
  }

  capabilities(): ToolLinkCapabilities {
    return {status:this.#state.status,place:this.#portalName,hostname:os.hostname(),platform:process.platform,
      tools:this.#state.status==='connected' && this.#initialized?definitions.filter(item=>this.#toolAllowed(item.name)).map(item=>item.name):[]};
  }

  #changed() { try { this.#onChange(this.snapshot()); } catch { /* Observers cannot affect tool dispatch. */ } }

  #end(status: LinkStatus = 'disconnected', error = '', retryable = false) {
    const socket = this.#socket;
    this.#socket = null;
    this.#generation++;
    this.#initialized = false;
    this.#timers.clearTimeout(this.#handshakeTimer);
    this.#timers.clearInterval(this.#heartbeatTimer);
    this.#handshakeTimer = null;
    this.#heartbeatTimer = null;
    const connecting = this.#connecting;
    this.#connecting = null;
    connecting?.reject(new Error(error || '工具连接已断开。'));
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    this.#seen.clear();
    this.#state.status = status;
    this.#state.error = error;
    if (pending.length) this.#state.lastCall = {name:pending.at(-1)!.name,status:'cancelled',at:Date.now()};
    for (const item of pending) item.controller.abort();
    try { socket?.close(status === 'error' ? 1008 : 1000,'Desktop tools disconnected'); } catch { /* The local session is already revoked. */ }
    this.#changed();
    if (retryable) this.#scheduleReconnect();
  }

  #scheduleReconnect() {
    if (this.#disposed || this.#reconnectTimer || !this.#reconnectConnection || !this.#shouldReconnect()) return;
    const generation = this.#generation, connection = this.#reconnectConnection;
    const delayMs = Math.min(60000, 2000 * 2 ** Math.min(this.#reconnectAttempt++, 5));
    this.#state.reconnect = {attempt: this.#reconnectAttempt, delayMs};
    this.#reconnectTimer = this.#timers.setTimeout(() => {
      this.#reconnectTimer = null;
      delete this.#state.reconnect;
      if (this.#disposed || generation !== this.#generation || connection !== this.#reconnectConnection || !this.#shouldReconnect()) return;
      void this.connect(connection).catch(() => {});
    }, delayMs);
    this.#reconnectTimer?.unref?.();
    this.#changed();
  }

  #send(value: unknown): boolean {
    if (!this.#socket || this.#socket.readyState !== 1) return false;
    let text: string;
    try { text = JSON.stringify(value); } catch { return false; }
    if (Buffer.byteLength(text,'utf8') > MAX_RESPONSE_BYTES) return false;
    if (this.#socket.bufferedAmount > MAX_BUFFERED_BYTES) { this.#end('error','工具连接发送拥塞，请重新连接。',true); return false; }
    try { this.#socket.send(text); return true; }
    catch { this.#end('error','工具连接发送失败，请重新连接。',true); return false; }
  }

  #error(id: string | number | null, code: number, message: string) { this.#send({jsonrpc:'2.0',id,error:{code,message}}); }

  connect(connection: unknown): Promise<ToolLinkSnapshot> {
    if (this.#disposed) return Promise.reject(new Error('工具连接已关闭。'));
    if (this.#socket) return Promise.reject(new Error('工具连接已在使用，请先断开。'));
    let parsed!: ReturnType<typeof parseConnection>, loom!: URL, beingId: string | undefined;
    try {
      if (!record(connection)) throw new Error('connection');
      parsed = parseConnection(connection.url);
      loom = new URL(parsed.url);
      beingId = loom.pathname.split('/').filter(Boolean)[0];
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(beingId || '') || !boundedText(parsed.token,1,4096) || /[\r\n]/.test(parsed.token) || connection.token !== parsed.token) throw new Error('identity');
    } catch { return Promise.reject(new Error('Loom 连接缺少有效的 Being 身份或令牌。')); }
    this.#timers.clearTimeout(this.#reconnectTimer);this.#reconnectTimer = null;delete this.#state.reconnect;
    this.#reconnectConnection = {url:parsed.url,token:parsed.token};
    const relay = new URL('/_relay',loom.origin);
    relay.protocol = loom.protocol === 'http:' ? 'ws:' : 'wss:';
    let socket: ToolSocket;
    try { socket = new this.#WebSocket(relay.href); }
    catch { this.#state.status = 'error';this.#state.error = '工具连接无法建立。';this.#changed();this.#scheduleReconnect();return Promise.reject(new Error(this.#state.error)); }
    this.#socket = socket;
    const generation = ++this.#generation;
    const current = () => this.#socket === socket && generation === this.#generation;
    this.#state.status = 'connecting';
    this.#state.error = '';
    this.#initialized = false;
    this.#seen.clear();
    let handshake: Record<string, unknown> | null = {being_id:beingId,loom_token:parsed.token,portal_name:this.#portalName};
    let lastSeen = this.#clock();
    let textKeepalive = false;
    // Older relays acknowledge authentication without advertising text keepalive.
    socket.on?.('pong',() => { if (current() && !textKeepalive && this.#state.status === 'connected') lastSeen = this.#clock(); });
    const connected = new Promise<ToolLinkSnapshot>((resolve,reject) => { this.#connecting = {resolve,reject}; });
    this.#handshakeTimer = this.#timers.setTimeout(() => { if (current()) this.#end('error','工具连接握手未完成，请重新连接。',true); },10000);
    this.#handshakeTimer?.unref?.();
    socket.addEventListener('open',() => {
      if (!current()) { handshake = null; return; }
      this.#send(handshake);
      handshake = null;
    });
    socket.addEventListener('message',({data}: { data: unknown }) => {
      if (!current()) return;
      if (typeof data !== 'string' || Buffer.byteLength(data,'utf8') > MAX_MESSAGE_BYTES) { this.#end('error','工具连接收到不支持的数据。'); return; }
      let message: unknown;
      try { message = JSON.parse(data); } catch {
        if (this.#state.status === 'connecting') this.#end('error','工具连接握手被拒绝。');
        else this.#error(null,-32700,'Invalid JSON.');
        return;
      }
      if (this.#state.status === 'connecting') {
        if (!keys(message,['ok','being_id','relay_keepalive']) || message.ok !== true || Object.hasOwn(message,'being_id') && message.being_id !== beingId || Object.hasOwn(message,'relay_keepalive') && message.relay_keepalive !== 'text-v1') { this.#end('error','工具连接握手被拒绝。');return; }
        textKeepalive = message.relay_keepalive === 'text-v1';
        if (!textKeepalive && (typeof socket.ping !== 'function' || typeof socket.on !== 'function')) { this.#end('error','工具连接不支持服务器的心跳协议。');return; }
        this.#timers.clearTimeout(this.#handshakeTimer);
        this.#handshakeTimer = null;
        this.#state.status = 'connected';
        lastSeen = this.#clock();
        const waiting = this.#connecting;
        this.#connecting = null;
        this.#heartbeatTimer = this.#timers.setInterval(() => {
          if (!current()) return;
          if (this.#clock() - lastSeen > HEARTBEAT_DEADLINE_MS) { this.#end('error','工具连接已失去响应，请重新连接。',true);return; }
          if (textKeepalive) this.#send({type:'keepalive'});
          else {
            if (socket.bufferedAmount > MAX_BUFFERED_BYTES) { this.#end('error','工具连接发送拥塞，请重新连接。',true);return; }
            try { socket.ping!('bd',error => { if (error && current()) this.#end('error','工具连接发送失败，请重新连接。',true); }); }
            catch { this.#end('error','工具连接发送失败，请重新连接。',true); }
          }
        },HEARTBEAT_INTERVAL_MS);
        this.#heartbeatTimer?.unref?.();
        this.#changed();
        if (current()) waiting?.resolve(this.snapshot());
        else waiting?.reject(new Error('工具连接已断开。'));
        return;
      }
      if (textKeepalive && keys(message,['type']) && message.type === 'keepalive_ack') { lastSeen = this.#clock();return; }
      if (this.#message(message,generation)) lastSeen = this.#clock();
    });
    socket.addEventListener('error',() => { handshake = null;if (current()) this.#end('error','工具连接发生网络错误，请重新连接。',true); });
    socket.addEventListener('close',() => { handshake = null;if (current()) this.#end('error','工具连接已断开，请重新连接。',true); });
    this.#changed();
    return connected;
  }

  #message(message: unknown, generation: number): boolean {
    if (!record(message)) { this.#error(null,-32600,'Single request object required.');return false; }
    const hasId = Object.hasOwn(message,'id');
    const id = hasId && validId(message.id) ? message.id : null;
    if (!keys(message,['jsonrpc','id','method','params']) || message.jsonrpc !== '2.0' || !boundedText(message.method,1,128) || hasId && id === null) {
      if (hasId) this.#error(id,-32600,'Invalid request.');
      return false;
    }
    const params: unknown = Object.hasOwn(message,'params') ? message.params : {};
    if (!hasId) {
      if (message.method === 'notifications/initialized' && this.#initialized && empty(params)) return true;
      if (message.method === 'notifications/cancelled' && this.#initialized && keys(params,['requestId','reason']) && validId(params.requestId) && (!Object.hasOwn(params,'reason') || boundedText(params.reason,0,1024))) {
        const item = this.#pending.get(JSON.stringify(params.requestId));
        if (item) {
          this.#pending.delete(JSON.stringify(params.requestId));
          item.controller.abort();
          this.#state.lastCall = {name:item.name,status:'cancelled',at:Date.now()};
          this.#changed();
        }
        return true;
      }
      return false;
    }
    const key = JSON.stringify(id);
    if (this.#seen.has(key)) { this.#error(id,-32600,'Request identifier already used.');return false; }
    if (this.#seen.size >= MAX_REQUESTS) { this.#end('error','本次工具连接已达到请求上限，请重新连接。');return false; }
    this.#seen.add(key);
    if (message.method === 'initialize') {
      const initializeParams = params as Record<string, any>;
      if (this.#initialized || !keys(params,['protocolVersion','capabilities','clientInfo']) || !boundedText(initializeParams.protocolVersion,1,128) || !record(initializeParams.capabilities) || !keys(initializeParams.clientInfo,['name','version','title']) || !boundedText(initializeParams.clientInfo.name,1,128) || !boundedText(initializeParams.clientInfo.version,1,128) || Object.hasOwn(initializeParams.clientInfo,'title') && !boundedText(initializeParams.clientInfo.title,1,128)) { this.#error(id,-32602,'Invalid initialization parameters.');return false; }
      this.#initialized = this.#send({jsonrpc:'2.0',id,result:{protocolVersion:'2024-11-05',capabilities:{tools:{listChanged:false}},serverInfo:{name:'being-desktop-tools',version:'1.0.0'}}});
      if (this.#initialized) this.#reconnectAttempt = 0;
      this.#changed();
      return this.#initialized;
    }
    if (message.method === 'ping') {
      if (!empty(params)) { this.#error(id,-32602,'Parameters not permitted.');return false; }
      return this.#send({jsonrpc:'2.0',id,result:{}});
    }
    if (!this.#initialized) { this.#error(id,-32002,'Initialize the tool session first.');return false; }
    if (message.method === 'tools/list') {
      if (!empty(params)) { this.#error(id,-32602,'Parameters not permitted.');return false; }
      const tools = structuredClone(definitions.filter(tool=>this.#toolAllowed(tool.name)));
      for (const tool of tools) {
        tool.inputSchema.properties.place = {type:'string',enum:[this.#portalName],description:'Routing selector for Hearth. Also set target_portal to the same value for endpoint verification.'};
        tool.inputSchema.properties.target_portal = {type:'string',enum:[this.#portalName],description:'Required end-to-end execution target. Retained after routing; a missing or mismatched value is rejected before execution.'};
        tool.description += ` Execution host: ${JSON.stringify(os.hostname())}, OS: ${process.platform}; Portal: ${this.#portalName}.`;
      }
      return this.#send({jsonrpc:'2.0',id,result:{tools}});
    }
    if (message.method !== 'tools/call') { this.#error(id,-32601,'Method not permitted.');return false; }
    const callParams = params as Record<string, any>;
    if (!keys(params,['name','arguments']) || !validArguments(callParams.name,callParams.arguments) || !this.#toolAllowed(callParams.name)) { this.#error(id,-32602,'Tool arguments not permitted.');return false; }
    if (callParams.arguments.target_portal !== this.#portalName || Object.hasOwn(callParams.arguments,'place') && callParams.arguments.place !== this.#portalName) { this.#error(id,-32602,'Portal target mismatch; tool was not executed. Set target_portal to the advertised endpoint and place to the same routing selector.');return false; }
    if (this.#pending.size >= MAX_PENDING) { this.#error(id,-32000,'Too many pending desktop tool requests.');return false; }
    const item: PendingCall = {key:randomUUID(),name:callParams.name,startedAt:Date.now(),controller:new AbortController()};
    this.#pending.set(key,item);
    this.#state.calls++;
    this.#state.lastCall = {name:item.name,status:'pending',at:item.startedAt};
    this.#changed();
    void this.#invoke(id,key,item,normalizeWorkerArguments(callParams.name,structuredClone(callParams.arguments)) as Record<string, unknown>,generation);
    return true;
  }

  async #invoke(id: string | number | null, key: string, item: PendingCall, args: Record<string, unknown>, generation: number) {
    delete args.place;
    delete args.target_portal;
    const active = () => generation === this.#generation && this.#pending.get(key) === item && !item.controller.signal.aborted;
    let removeAbort = () => {};
    try {
      if (!active()) return;
      const cancelled = new Promise<never>((_,reject) => {
        const abort = () => reject(new Error('Cancelled'));
        item.controller.signal.addEventListener('abort',abort,{once:true});
        removeAbort = () => item.controller.signal.removeEventListener('abort',abort);
      });
      const operation = Promise.resolve().then((): ToolResult | Promise<ToolResult> => {
        if (!active()) throw new Error('Cancelled');
        return this.#invokeTool(item.name,args,{signal:item.controller.signal,requestKey:item.key});
      });
      const value = result(await Promise.race([operation,cancelled]));
      value.content.unshift(targetReceipt(this.#portalName));
      if (!active()) return;
      if (!this.#send({jsonrpc:'2.0',id,result:value})) throw new Error('Result unavailable');
      this.#state.lastCall = {name:item.name,status:value.isError ? 'failed' : 'completed',at:Date.now()};
    } catch {
      if (!active()) return;
      this.#send({jsonrpc:'2.0',id,result:{content:[targetReceipt(this.#portalName),{type:'text',text:'Desktop tool was not completed. Check the local approval or tool status.'}],isError:true}});
      this.#state.lastCall = {name:item.name,status:'failed',at:Date.now()};
    } finally {
      removeAbort();
      if (generation === this.#generation && this.#pending.get(key) === item) { this.#pending.delete(key);this.#changed(); }
    }
  }

  disconnect(): ToolLinkSnapshot {
    this.#timers.clearTimeout(this.#reconnectTimer);this.#reconnectTimer = null;
    this.#reconnectConnection = null;this.#reconnectAttempt = 0;delete this.#state.reconnect;
    this.#end();return this.snapshot();
  }
  dispose(): ToolLinkSnapshot { this.#disposed = true;return this.disconnect(); }
}

export const toolDefinitions = (workerMode = false): ToolDefinition[] => structuredClone(definitions.filter(tool=>tool.name.startsWith('desktop_worker_')===workerMode));
