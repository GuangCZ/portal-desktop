// The renderer-facing contract of the native chat layer. Shapes are taken from
// BeingDesktop 0.8.26 docs/interfaces.md §1.2「对话（原生模式）」and §1.3「主进程 →
// 渲染层推送」; ported 2026-09-16.
//
// `shared` is pure by rule, so nothing here imports the main-process modules that
// produce these objects. The chat IPC layer asserts its own return types against
// these declarations instead, which is what keeps the two in step.

/** One image kept with a durable row. The bytes are gone the moment they reach the
 * Being — history never returns images (measured 2026-09-11,
 * docs/desktop-message-layer.md §十) — so this is a local annotation: a media type,
 * the file's name, and a small data-URL thumbnail the renderer made. */
export interface ChatRowImage { media_type: string; name?: string; thumb?: string }

/** One durable transcript row, carrying the server's own `seq`. `from` marks a
 * separator the Being wrote about itself (e.g. `[breath yielded to human]`). */
export interface ChatRow {
  seq: number;
  role: 'user' | 'being';
  content: string;
  at: string;
  from?: string;
  images?: ChatRowImage[];
}

/** A message sent but not yet confirmed by a history row. `after` is the newest
 * row that existed when it was made, so the renderer can place it after what it
 * followed rather than below whatever landed later. */
export interface ChatSentItem { text: string; at: string; after: number; images?: ChatRowImage[] }

/** A finished reply awaiting the same confirmation. `final` is the text after the
 * last tool call — all the Being keeps of a reply that used tools — and `partial`
 * marks a bubble whose writer died before closing it. */
export interface ChatRepliedItem { text: string; final: string; think: string; at: string; after: number; partial?: boolean }

/** The reply currently streaming. `think` is the reasoning stream, shown live and
 * deliberately never folded into the body text (docs/desktop-message-layer.md §五). */
export interface ChatLiveReply { text: string; think: string; at: string }

export interface ChatView {
  sessionId: string;
  version: number;
  rows: ChatRow[];
  workerResults: unknown[];
  sent: ChatSentItem[];
  replied: ChatRepliedItem[];
  live: ChatLiveReply | null;
}

/** One conversation in the list. `updatedAt` is the newest row's server timestamp,
 * falling back to the numeric `createdAt` for a conversation never spoken in;
 * `busy` means something of ours is in flight for it, `inFlight` that a request is
 * actually open, and `truncated` that old rows were dropped to fit the cache. */
export interface ChatSessionSummary {
  id: string;
  title: string;
  titleSource?: 'auto' | 'manual' | 'system';
  createdAt: number;
  updatedAt: string | number;
  truncated: boolean;
  count: number;
  lastSeq: number;
  busy: boolean;
  inFlight: boolean;
}

/** What the recovery machine is doing, surfaced so the renderer can say why a
 * reply is late rather than showing a stuck cursor. */
export interface ChatRecoveryState {
  phase: 'idle' | 'streaming' | 'replaying' | 'reconnecting' | 'catching-up' | 'watching';
  sessionId?: string;
  streamId?: string;
  origin?: string;
  hint?: string;
  gaveUp?: boolean;
  pending?: boolean;
  live?: boolean;
  replaying?: boolean;
  catchingUp?: boolean;
  watching?: boolean;
}

export interface ChatState {
  open: boolean;
  version: number;
  /** `'bound'` or `''`. Never the identity key itself: that is a connection address. */
  identityKey: string;
  active: string;
  cursor: number;
  seeded: boolean;
  /** The encrypted cache could not be written; conversations still work in memory. */
  degraded: boolean;
  sessions: ChatSessionSummary[];
  recovery: ChatRecoveryState;
}

/** One image on its way out: base64 bytes plus the preview to keep. At most 8 per
 * message, 10MB in total, and text must accompany them — a message of images alone
 * lands no row and the Being answers the previous question (docs §十). */
export interface ChatImageUpload { media_type: string; data: string; name?: string; thumb?: string }

/** A quoted selection travelling with the message. At most 12, 60000 characters in
 * total (docs/interfaces.md §1.2). */
export interface ChatReferenceInput { text: string; source?: 'you' | 'Being' }

export interface ChatSendRequest {
  sessionId: string;
  /** Required, at most 200000 code points. */
  text: string;
  images?: ChatImageUpload[];
  references?: ChatReferenceInput[];
}

/** `spliced: true` is the measured 202: the message was delivered and joined the
 * breath already running, so its reply arrives on whichever connection is open, or
 * through catch-up — never on this request (docs §一). */
export interface ChatSendResult { ok: true; streamed: boolean; spliced: boolean; recovering: string }

/** A stop that names what it refused. `other-scene` carries the owning
 * conversation's `scene` and `ownerTitle` so the user can be asked (docs §四). */
export interface ChatStopResult { stopped: boolean; reason: string; scene: string; ownerTitle: string }

export interface ChatReloadResult { ok: boolean; added: number; error: string }

/** What the composer offers for `@`-mentions. Kits and Town members arrive in a
 * later stage; the shape is fixed now so the renderer contract does not move. */
export interface ChatComposerEntry {
  id: string;
  name: string;
  handle: string;
  description: string;
  kind: 'kit' | 'member';
  installed: boolean;
  icon: string;
  builtin: boolean;
}

export interface ChatComposerData {
  kits: ChatComposerEntry[];
  members: ChatComposerEntry[];
  kitsError: string;
  membersError: string;
  connectionRevision: number;
}

/** One event of the native conversation stream (docs/interfaces.md §1.3
 * `being:chat-event`). `sent` is this client's own echo; `meta` reports the stream
 * and whether the server confirmed our `client_ref`; `think` is reasoning, `delta`
 * body text, `reply` one closed `message_stop`, `settled` a bubble the writer left
 * open, `error` a failure to show. Anything else the wire carries — `usage`,
 * `tool_use`, `tool_result` — passes through as `{type, data}`. */
export type ChatEventPayload =
  | { sessionId: string; type: 'sent'; text: string; images: number }
  | { sessionId: string; type: 'meta'; streamId: string; scene: string; confirmed: boolean }
  | { sessionId: string; type: 'think'; text: string }
  | { sessionId: string; type: 'delta'; text: string }
  | { sessionId: string; type: 'reply'; text: string }
  | { sessionId: string; type: 'settled' }
  | { sessionId: string; type: 'error'; message: string }
  | { sessionId: string; type: string; data?: unknown; [key: string]: unknown };

/** The chat half of `window.beings`. One object rather than a dozen top-level
 * methods, so the surface the renderer sees matches the subsystem behind it.
 *
 * `view`, `send`, `stop`, `reload` and `forgetSession` reject with an Error
 * carrying `code` (a `ChatChannelErrorCode` — desktop/shared/chat-errors.ts);
 * those are BeingDesktop's「Town 包络」rows in docs/interfaces.md §1.2. The rest
 * reject with a message only, as they do there: nothing branches on their
 * failure. */
export interface ChatAPI {
  /** The conversation list and which one is active. */
  sessions(): Promise<ChatState>;
  view(sessionId: string): Promise<ChatView>;
  send(request: ChatSendRequest): Promise<ChatSendResult>;
  stop(input: { sessionId: string; force?: boolean }): Promise<ChatStopResult>;
  /** Re-read the newest window as a fresh baseline. */
  reload(): Promise<ChatReloadResult>;
  /** Select a conversation, or create one when given `null`. Returns its id.
   * DEVIATION from BeingDesktop: `changeChatSession` answers `{ok:true}` there
   * (docs/interfaces.md line 88, src/main.cjs line 1177) and the caller reads the
   * new id back out of `publicState()`. Its `project` parameter is not here
   * either — that belongs to the sidebar, which is not ported yet. See
   * docs/migration/p1-sessions-fix.md「偏差清单」. */
  changeSession(sessionId: string | null): Promise<string>;
  renameSession(sessionId: string, title: string): Promise<boolean>;
  forgetSession(sessionId: string): Promise<boolean>;
  composerData(): Promise<ChatComposerData>;
  onEvent(callback: (event: ChatEventPayload) => void): () => void;
  onState(callback: (state: ChatState) => void): () => void;
}
