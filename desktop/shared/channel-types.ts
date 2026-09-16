// The Feishu/WeChat channel, the Town feature catalogue and the composer-draft
// entry, as the renderer sees them; 2026-09-16 (integration unit I7).
//
// Names carry the `Channel` prefix because `desktop/shared/desktop-types.ts`
// aggregates every one of these files with `export *`, where a collision is
// silently dropped rather than reported (docs/migration/i0-seams.md §C).
//
// The main-process shapes these mirror live in desktop/main/town/channel/types.ts
// (`ChannelOutcome`) and ./town-catalog.ts (`TownFeature`). They are declared
// again here rather than imported because `desktop/shared/` may not reach into
// `desktop/main/` — tests/architecture.test.ts enforces it, and the reason is
// that a renderer type must describe what actually crosses IPC, which is a
// structured clone of those objects and nothing more.

/** One channel's state as the Being reported it. BeingDesktop's `ChannelOutcome`
 * (src/channel-being.cjs), minus `qrCodeUrl`: the main process fetches the image
 * behind that address itself and hands over the bytes, so the renderer never
 * loads a remote image (src/channel-being.cjs `_qrImage`). */
export interface ChannelOutcomeState {
  channel: string;
  /** One of `connected | disconnected | pending | registered | disabled |
   * waiting | expired | error | unknown | unsupported`, as the Being answered.
   * Left as a string: an unknown value must render as「待确认」rather than throw. */
  status: string;
  detail: string;
  /** A `data:image/(png|jpeg|webp);base64,…` the main process validated. */
  qrCodeDataUrl?: string;
}

/** `checkChannelStatus`'s answer: the channel asked about, plus the one-element
 * list BeingDesktop wraps it in (src/channel-being.cjs `getChannelStatus`). */
export interface ChannelCheckResult extends ChannelOutcomeState {
  channels: ChannelOutcomeState[];
}

/** One row of the read-only service snapshot (`TownSession.getChannelStatus`).
 * Both channels are always present, `unknown` when the service said nothing. */
export interface ChannelServiceStatus {
  channel: string;
  status: string;
  detail: string;
  appId?: string;
  qrCodeDataUrl?: string;
  qrCodeUrl?: string;
}

export interface ChannelServiceSnapshot { channels: ChannelServiceStatus[] }

/** `{channel, connectionRevision}` — the only shape the main process accepts, and
 * it is checked there key by key (src/channel-being.cjs `request`). */
export interface ChannelRequestInput {
  channel: string;
  connectionRevision: number;
}

/** One entry of the Town feature catalogue (BeingDesktop src/town.cjs). */
export interface ChannelTownFeature {
  id: string;
  name: string;
  label: string;
  description: string;
  group: string;
  mode: 'app' | 'web' | 'being';
  url?: string;
}

export interface ChannelTownCatalog {
  features: ChannelTownFeature[];
  sourceUrl: string;
  checkedAt: string;
}

/** The four draft kinds behind one channel (integration plan §3.7).
 *
 *  · `feature`   — `prepareTownFeature(id)`: one of the six fixed feature drafts.
 *  · `assistance`— `prepareTownAssistance({operation})`: one of the six fixed
 *                  Being-assistance drafts.
 *  · `fireside`  — `prepareFiresideDraft({draft, connectionRevision})`: the user's
 *                  own fireside message, wrapped in a confirm-before-sending
 *                  preamble and fenced against the connection epoch.
 *  · `pairing`   — `prepareTownPairing()`: the fixed pairing-code request. */
export type ChannelDraftKind = 'feature' | 'assistance' | 'fireside' | 'pairing';

export interface ChannelDraftRequest {
  kind: ChannelDraftKind;
  /** `feature`: the feature id. `assistance`: the operation name. */
  id?: string;
  /** `fireside` only: the message the user typed. */
  draft?: string;
  /** `fireside` only: the epoch the draft was written under. */
  connectionRevision?: number;
}

/** A draft the main process is asking the conversation to hold. */
export interface ChannelDraftPush {
  id: string;
  text: string;
  /** Wall-clock deadline. A push that arrives after it is ignored: the main
   * process has already given up, and placing it now would replace a draft the
   * user has since started. */
  expiresAt: number;
}

/** What the conversation did with it. `placed` and `occupied` are the two the
 * renderer can distinguish; the main process supplies `timeout` itself when no
 * answer arrives (desktop/main/town/channel/draft.ts). */
export type ChannelDraftAck = 'placed' | 'occupied' | 'unavailable';

/** What the channel worker is doing right now. `status` is `'working'` while a
 * request is in flight, and otherwise the last outcome's status. BeingDesktop
 * carries this inside its global `being:state` broadcast; this shell has no such
 * broadcast, so the channel pushes its own — the same choice, for the same
 * reason, that I1 made for `beings:town-state`. */
export interface ChannelWorkerState {
  channel: string;
  status: string;
  detail: string;
  qrCodeDataUrl?: string;
  /** The epoch a channel request must carry. It is THIS subsystem's own counter,
   * not Town's `identity.connectionRevision`: `ChannelBeing` compares the request
   * against the identity it holds, and two counters that merely tend to agree
   * would reject every request the moment they stopped. */
  connectionRevision: number;
  /** A Being is bound and has answered. BeingDesktop's
   * `state.connection.status === 'connected'`, which is what gates every control
   * on the page (renderer/town-app.js line 948). */
  connected: boolean;
}

/** A failure from one of the four「Town 包络」channels, AS THE RENDERER RECEIVES
 * IT — as data, not as a rejection.
 *
 * MEASURED on the packaged client, 2026-09-16 (docs/migration/i7-channel-drafts.md
 * 「冒烟结果」): `contextBridge` copies an Error across the isolated-world boundary
 * by message and stack ALONE. `Object.getOwnPropertyNames(error)` in the renderer
 * is exactly `['stack', 'message']` — the `code` that
 * `desktop/shared/town-desktop-errors.ts` puts on it is dropped on the way out of
 * the preload, and so is the chat catalogue's. That is the whole reason the
 * envelope exists, so a preload that rethrows it has undone its own work.
 *
 * Hence: this unit's four enveloped channels RESOLVE with the envelope, and the
 * renderer turns it into an Error in its own context, where the property
 * survives because it never crosses anything. The shape is the same
 * `{__townError, code, message}` the main process already produces; only the side
 * that reconstitutes it moved. */
export interface ChannelErrorResult {
  __townError: true;
  code: string;
  message: string;
}

/** What an enveloped channel answers with: the value, or the failure as data. */
export type ChannelAnswer<T> = T | ChannelErrorResult;

export interface ChannelAPI {
  /** This client's own channel state: the epoch, whether a Being is bound, and
   * the last outcome. Read once on mount; `onState` carries every change after
   * that. It asks the service nothing. */
  state(): Promise<ChannelWorkerState>;
  /** 功能任务. Asks the Being to actually connect the channel. */
  begin(request: ChannelRequestInput): Promise<ChannelAnswer<ChannelOutcomeState>>;
  /** 功能任务. Asks the Being to read back the channel's real state. */
  check(request: ChannelRequestInput): Promise<ChannelAnswer<ChannelCheckResult>>;
  /** Read-only. Queries the Town service directly; sends the Being nothing. */
  inspect(request: ChannelRequestInput): Promise<ChannelAnswer<ChannelServiceSnapshot>>;
  /** Always answers with a failure: application secrets are submitted through the
   * channel service's own configuration entry, never through this client. */
  feishu(value: unknown): Promise<ChannelErrorResult>;
  catalog(): Promise<ChannelTownCatalog>;
  /** Opens one of the three public Town pages in the tool browser. */
  openPage(id: string): Promise<{ opened: true }>;
  /** Puts one of the four prepared prompts into the current conversation. */
  draft(request: ChannelDraftRequest): Promise<{ prepared: true }>;
  onState(callback: (value: ChannelWorkerState) => void): () => void;
  onDraft(callback: (value: ChannelDraftPush) => void): () => void;
  draftResult(id: string, ack: ChannelDraftAck): Promise<void>;
}
