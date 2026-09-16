// Wire shapes of the five Being message endpoints, ported from BeingDesktop
// 0.8.26 src/being-chat.cjs (509 lines) and src/being-recovery.cjs (461 lines);
// 2026-09-16. Every shape here is what a real Being was measured to send, not
// what its source suggests it might — see docs/desktop-message-layer.md (that
// file's §一 through §十 are cited by section number throughout this port).
//
// These declarations are deliberately standalone: the parallel port of the
// store owns the durable transcript shapes, and nothing here imports them, so
// the two stages cannot race. Where the same concept appears in both, this file
// is the one that describes the wire.

/** The user-facing failure codes. The message is Chinese because it is shown;
 * the code is what callers branch on. (src/being-chat.cjs lines 49-59.) */
export const MESSAGES = {
  NOT_CONNECTED: '请先连接 Being。',
  SESSION_CHANGED: 'Being 连接已变化，旧请求已取消。',
  INVALID_REQUEST: '请求参数无效。',
  INVALID_RESPONSE: 'Being 返回格式无效。',
  NETWORK_ERROR: '与 Being 的连接中断，请稍后重试。',
  SERVICE_ERROR: 'Being 服务暂时不可用。',
  AUTH_REQUIRED: 'Being 连接凭据无效，请重新连接。',
  ABORTED: '请求已取消。',
  RESULT_UNKNOWN: '发送结果未确认，请刷新后核对再决定是否重发。',
} as const;

export type ChatErrorCode = keyof typeof MESSAGES;

/** An Error carrying one of the codes above. `progress` rides along on a send
 * that broke after dispatch: it is how far the stream got, which is where
 * recovery resumes (src/being-chat.cjs line 411). */
export interface ChatError extends Error {
  code: ChatErrorCode;
  progress?: RouterState;
}

/** What `getContext()` hands the client: the current Being binding. `connection`
 * is the connection address, either bare or wrapped, and `revision` changes when
 * the user reconnects — a request whose context moved is abandoned rather than
 * mixed into the new timeline. */
export interface ChatContext {
  connected?: boolean;
  connection?: string | { url?: string } | null;
  revision?: number;
}

/** The connection resolved for one request, plus the epoch that `reset()` bumps.
 * Every response is checked against the context that started the request. */
export interface RequestContext {
  apiBase: string;
  token: string;
  revision: number;
  epoch: number;
}

/** Main-process supplied per-send execution context. `assertCurrent` throws if
 * the orchestration binding moved while the environment was being read, so a
 * stale scope can never reach Heart (src/orchestration-message.cjs
 * nativeMessageContext). */
export interface PreparedMessage {
  context?: string;
  assertCurrent?: () => void;
}

/** `scene_meta` is routing metadata, not content. `scene_label` is measured to
 * enter the Being's perception as `[场景] <label>`, so a conversation's title is
 * its doorplate and is resent with every message (docs §九). */
export type SceneMeta = Record<string, unknown>;

/** One image as a caller hands it over: base64 bytes and their media type. Extra
 * fields (a name, a thumbnail) are the transcript's business and never reach the
 * Being — the client copies only these two (docs §十). */
export interface ImageInput {
  media_type?: unknown;
  data?: unknown;
  [key: string]: unknown;
}

/** An image content block on the wire. The server accepts only `text`, `image`
 * and `image_url` blocks; an `audio` block is refused with 422 before anything is
 * recorded (measured 2026-09-11, docs §十). */
export interface ImageBlock {
  type: 'image';
  media_type: string;
  data: string;
}

export interface TextBlock {
  type: 'text';
  text: string;
}

export type ContentBlock = TextBlock | ImageBlock;

/** The POST /api/chat/stream body. Exactly one of `message` / `content` is
 * present: images replace the plain message with blocks, the first of which
 * carries the text (which is required — a block list of images alone lands no
 * user row and the Being answers the previous question instead). */
export interface SendBody {
  message?: string;
  content?: ContentBlock[];
  scene_id: string;
  scene_meta: SceneMeta;
  client_ref: string;
}

/** One row of GET /api/history. The full field set measured on a real Being is
 * `role, content, seq, at, from?, scene_id?` — there is no `session_id`, and
 * `scene_id` is the only routing key the server persists (docs §七). A row
 * without one predates scene support and belongs to no conversation. */
export interface HistoryRow {
  seq: number;
  role: 'user' | 'being';
  content: string;
  at: string;
  from?: string;
  scene_id?: string;
}

/** One page of the single global timeline, already sorted and filtered to what is
 * new. `ignoredAfter` marks a page that came back non-empty yet held nothing
 * newer than `after`: without it a caller cannot tell a server that ignored
 * `after` from "no new messages" and re-reads the same window forever (docs §八). */
export interface HistoryPage {
  rows: HistoryRow[];
  cursor: number;
  more: boolean;
  ignoredAfter: boolean;
}

/** A replay event as GET /api/stream/active returns it: `{event, seq, data}`,
 * wrapped one layer deeper than the SSE `event:`/`data:` framing, with `seq`
 * counting from 1 within the stream. Replay events carry `scene_id` too, so a
 * recovered buffer fans out exactly like a live stream (docs §五). */
export interface RawReplayEvent {
  event?: unknown;
  type?: unknown;
  seq?: unknown;
  data?: unknown;
}

/** A replay event after normalization. `type` falls back to `message`, matching
 * the SSE default for a frame with no `event:` line. */
export interface ReplayEvent {
  type: string;
  seq: number;
  data: unknown;
}

/** What the probe concluded about the breath the server is running.
 *
 * - `gone`        204, no body: there is no active stream, so its content is on disk.
 * - `superseded`  another stream_id: another client started a new breath.
 * - `finished`    `finished: true`: the breath ended; the buffer holds its tail.
 * - `progressing` the server's seq is past ours: there is something to read.
 * - `stalled`     the server has not moved either: wait, and ask again later.
 */
export type ProbeVerdict = 'gone' | 'superseded' | 'finished' | 'progressing' | 'stalled';

/** GET /api/stream/active, folded into one verdict plus the buffer it returned.
 *
 * `scene` is the conversation being spoken to right now — the newest event wins,
 * because a continuation meta can hand the stream to another one. `speaking` is
 * false after a `message_stop`, because the next event may belong to another
 * scene and the buffer cannot prove who speaks next (docs §四). An autonomous
 * breath (origin beating / callback / leftover rather than human) has a stream_id
 * but no events at all, so it can only be waited out and then reconciled from
 * history (loom.html:4011). */
export interface ProbeResult {
  verdict: ProbeVerdict;
  events: ReplayEvent[];
  streamId: string;
  nextSeq: number;
  serverSeq: number;
  scene: string;
  scenes: string[];
  origin: string;
  autonomous: boolean;
  speaking: boolean;
  trigger: string;
}

/** Why a stop was or was not performed.
 *
 * | verdict | meaning |
 * |---|---|
 * | `matched`     | the running breath is provably this conversation's; it was stopped |
 * | `forced`      | the user answered the question a refusal raised, and it was stopped |
 * | `other-scene` | it belongs to another conversation; `scene` names it, ask the user |
 * | `unknown`     | no scene in the buffer, or a bubble just closed: ownership cannot be proven |
 * | `autonomous`  | the Being is thinking for itself; no conversation owns the breath |
 * | `idle`        | nothing is running (the button should not have been lit) |
 */
export type StopReason = 'matched' | 'forced' | 'other-scene' | 'unknown' | 'autonomous' | 'idle';

export interface StopResult {
  stopped: boolean;
  reason: StopReason;
  scene: string;
}

export interface StatusResult {
  beingName: string;
}

/** How far one router has folded a stream in. `trailing` is the asking
 * conversation's half-built reply: the text a cutover carries across so the
 * replayed remainder joins it without one character repeated or missing. */
export interface RouterState {
  streamId: string;
  confirmed: boolean;
  replies: number;
  liveSeq: number;
  foreign: number;
  trailing: string;
}

/** Connection-level progress, reported before routing so a watchdog sees foreign
 * events too — otherwise its idea of the stream's seq falls behind the server's
 * and every probe looks like progress (src/being-chat.cjs line 456). */
export interface RouterProgress {
  type: string;
  liveSeq: number;
  streamId: string;
}

/** The per-event routing for one stream. A router outlives a connection on
 * purpose: when a live reader dies and the replay poller takes over from its last
 * seq, the same router carries the half-built reply text across (Loom's
 * cutoverToReplay, loom.html:2615). */
export interface ChatRouter {
  handle(type: string, data: unknown): void;
  state(): RouterState;
  /** The conversations this writer left mid-bubble. Clearing the buffers makes a
   * second settle a no-op, which is what keeps one `settled` per bubble. */
  settle(): string[];
  expect(ref: unknown): void;
  readonly sessionId: string;
}

export interface SplicedEvent { sessionId: string; type: 'spliced'; scene: string }
export interface MetaEvent { sessionId: string; type: 'meta'; streamId: string; scene: string; confirmed: boolean }
export interface ErrorEvent { sessionId: string; type: 'error'; message: string }
export interface ThinkEvent { sessionId: string; type: 'think'; text: string }
export interface DeltaEvent { sessionId: string; type: 'delta'; text: string }
export interface ReplyEvent { sessionId: string; type: 'reply'; text: string }
export interface SettledEvent { sessionId: string; type: 'settled' }
/** Everything else the wire carries — `usage`, `tool_use`, `tool_result`,
 * `thinking` — passed through with its data untouched. `usage` is measured once
 * per breath and is forwarded unused for now (docs §十). */
export interface PassthroughEvent { sessionId: string; type: string; data: unknown }

export type ChatEvent =
  | SplicedEvent
  | MetaEvent
  | ErrorEvent
  | ThinkEvent
  | DeltaEvent
  | ReplyEvent
  | SettledEvent
  | PassthroughEvent;

/** One send's outcome. `streamed: false` with `spliced: true` is the 202 case:
 * the message is delivered and its reply will surface on whichever connection is
 * already open, or through catch-up — never here (docs §一). */
export interface SendResult {
  ok: true;
  streamed: boolean;
  spliced: boolean;
  streamId: string;
  clientRef: string;
  confirmed: boolean;
  replies: number;
  liveSeq: number;
  foreign: number;
  trailing: string;
}

/** `Omit` collapses a union to the keys every member shares, which would reduce a
 * ChatEvent to `{type}` alone. Distributing it keeps each member's own fields, so
 * an emitter can be handed one event body without its session id. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** One event as the router emits it, before the target conversation is attached. */
export type ChatEventBody = DistributiveOmit<ChatEvent, 'sessionId'>;
