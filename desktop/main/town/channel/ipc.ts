// The Feishu/WeChat channel, the Town feature catalogue and the composer draft,
// as IPC; 2026-09-16 (integration unit I7).
//
// Ported channel for channel from BeingDesktop 0.8.26 src/main.cjs lines 1238
// (`getTownCatalog`), 1252-1255 (`openTownPage` and the three `prepare*`), 1262
// (`prepareTownPairing`) and 1329-1332 (the four channel methods). The names
// change from `being:<camelCase>` to `beings:<kebab-case>`; the semantics do not.
//
// Registration goes through the `handle` wrapper main.ts supplies, so every
// channel inherits the sender check and the quitting guard.
//
// ── WHAT IS ENVELOPED ─────────────────────────────────────────────────────────
// The four `beings:channel-*` channels answer a failure with
// `{__townError:true, code, message}` instead of throwing, because BeingDesktop
// lists all four in `townMethods` (src/main.cjs lines 125 and 130) and because
// the renderer has to tell `AUTH_REQUIRED` from every other read failure: the
// first means「Desktop 暂无权限直接读取渠道状态」and the second「暂时未能读取」, and
// neither may be reported as「未绑定」(docs/channel-sessions.md「已有绑定状态」).
// The remaining three are not enveloped and are not in that set either: they
// raise plain Errors whose whole content is one short Chinese sentence, which
// desktop/main/app/ipc.ts already carries across intact.
//
// ── WHAT IS SERIALIZED ────────────────────────────────────────────────────────
// `beings:town-draft` takes the mutation queue, because BeingDesktop marks
// `prepareTownFeature` / `prepareTownAssistance` / `prepareFiresideDraft`
// 「串行」(src/main.cjs line 136). DEVIATION, recorded: `prepareTownPairing` is
// NOT in that set there, and here it is — the four kinds are one channel now, and
// two drafts racing into one composer is the one thing the queue is for.
//
// The draft preparer itself must NOT take the queue: `beings:feature-task-discuss`
// already runs inside it (main/features/methods.ts, `serialized: true`) and calls
// the same preparer, so a second acquisition from inside would deadlock.
//
// ── WHAT IS ACCOUNTED FOR ─────────────────────────────────────────────────────
// `beings:channel-begin` and `beings:channel-check` are「功能任务」: BeingDesktop's
// `featureMethods` set holds `beginChannelConnection` and `checkChannelStatus`
// (src/main.cjs line 120). They go through `methods.run(...)` with those
// BeingDesktop method names — the ledger's `OPERATIONS` table is keyed by them,
// and a kebab channel name would silently record nothing
// (docs/migration/i4-orchestration-features.md).
import { assistanceDraft, featureDraft, firesideDraft, getTownCatalog, townPageUrl, FIRESIDE_EPOCH_CHANGED } from './town-catalog';
import { requireDraftContext } from './draft';
import { townErrorCode, townErrorEnvelope } from '../../../shared/town-desktop-errors';
import type { ChannelBeing } from './channel-being';
import type { DraftAck, NativeDraftContextReader, PrepareNativeDraft } from './draft';
import type { ChannelDraftRequest, ChannelTownCatalog, ChannelWorkerState } from '../../../shared/channel-types';

type RegisterHandler = (channel: string, callback: (...args: any[]) => unknown) => void;

/** The accounting wrapper from the orchestration subsystem
 * (main/features/methods.ts). Declared structurally: that subsystem is reached
 * through the registry and may legitimately be absent. */
export interface ChannelFeatureMethods {
  run<T>(args: unknown[], options: { operation: string; serialized?: boolean }, body: () => T | Promise<T>): Promise<T>;
}

export interface ChannelIpcOptions {
  handle: RegisterHandler;
  /** The application's mutation queue. */
  exclusive: <T>(operation: () => Promise<T>) => Promise<T>;
  channel: ChannelBeing;
  /** BeingDesktop's `runChannel` tail (src/main.cjs lines 429-435): after a
   * channel request, read back whatever the Being wrote outside the foreground
   * reader. Supplied by the subsystem, which owns the fence. */
  afterChannel: <T>(action: () => Promise<T>) => Promise<T>;
  /** Feature-task accounting, or null when orchestration is not installed — in
   * which case the two「功能任务」channels still work, unrecorded, exactly as they
   * do in BeingDesktop before a ledger is open. */
  methods: () => ChannelFeatureMethods | null;
  /** `prepareNativeDraft`. */
  draft: PrepareNativeDraft;
  /** The connection epoch every draft is fenced against. */
  draftContext: NativeDraftContextReader;
  /** The renderer answering a pushed draft. */
  settleDraft: (id: string, ack: DraftAck) => boolean;
  /** This client's own channel state: the epoch, the binding and the last
   * outcome. Not a service read — nothing leaves the process. */
  state: () => ChannelWorkerState;
  /** `browserLinks().open(...)` — the built-in tool browser, as BeingDesktop's
   * `openTownPage` uses it (src/main.cjs line 1252). Null when the tool bridge is
   * not installed. */
  openPage: (url: string) => boolean;
}

const MAX_ID = 64;
const MAX_DRAFT = 32_000;

const KINDS = ['feature', 'assistance', 'fireside', 'pairing'] as const;
type DraftKind = (typeof KINDS)[number];

/** Which fields belong to which kind. BeingDesktop had four channels and each
 * checked its own argument where it lived; one channel with four kinds has to say
 * this out loud, or a field meant for another kind rides along unread.
 *
 * `fireside` is the strict one, as it is there: src/town.cjs line 158 requires
 * EXACTLY `draft` and `connectionRevision`, both data properties, and answers
 * anything else with「请填写有效的围炉协助草稿。」 — which tells the user to check
 * what they wrote. Accepting the request without an epoch and failing it later on
 * `context.generation !== undefined` would instead say「连接身份已变化…」and send
 * them to re-confirm an identity that never moved.
 *
 * `feature` and `assistance` deliberately do NOT require `id` here: without one,
 * ./town-catalog.ts answers with BeingDesktop's own sentence (「无效的 Town 功能。」
 * and「请选择有效的 Being 协助操作。」), which is more use than a generic refusal. */
const FIELDS: Record<DraftKind, readonly string[]> = {
  feature: ['id'], assistance: ['id'], fireside: ['draft', 'connectionRevision'], pairing: [],
};

/** BeingDesktop src/main.cjs line 740: the feature-task ledger's own limit has a
 * sentence that says what to do about it, and line 127 lists the code in
 * `townErrorCodes`, so both halves cross to the page. `TOWN_ERROR_CODES`
 * (desktop/shared/town-desktop-errors.ts, unit I1) does not carry the code, and
 * `townErrorEnvelope` would downgrade the pair to「Town 操作未完成，请稍后重试。」—
 * advice that cannot succeed, because only the user ending a tracked task frees a
 * slot. The envelope is therefore built here; the page's `unwrap`
 * (renderer/channel/models/channel.ts) takes `code` and `message` verbatim. */
const TASK_LIMIT = {
  code: 'TASK_LIMIT_REACHED',
  message: '功能任务记录已满，请到任务页结束不再跟踪的等待任务后重试。',
} as const;

type TaskLimitEnvelope = { __townError: true; code: typeof TASK_LIMIT.code; message: typeof TASK_LIMIT.message };

const invalid = (message: string): Error => Object.assign(new Error(message), { code: 'INVALID_REQUEST' });

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

/** BeingDesktop validates `{channel, connectionRevision}` inside `ChannelBeing`
 * itself, key by key and descriptor by descriptor (src/channel-being.cjs
 * `request`). It is deliberately NOT re-checked here: one place owns that limit,
 * and a second copy is one more thing to drift. */
type ChannelInput = unknown;

/** The four draft kinds, checked here because this envelope is this shell's own:
 * BeingDesktop had four separate channels, each validating its own argument
 * inside src/town.cjs. Those checks still run (the catalogue's `validateId`, the
 * assistance map, the fireside shape); what this adds is the outer key
 * whitelist, so an unknown field is refused rather than ignored. */
function draftRequest(value: unknown): ChannelDraftRequest {
  if (!plain(value)) throw invalid('请选择有效的草稿类型。');
  // Descriptors, not property reads: BeingDesktop checks the same way
  // (src/town.cjs `prepareTownAssistance`), and the reason is that a getter on
  // the request object would otherwise RUN — once here and again wherever the
  // value is read, returning something different each time. A symbol key is a key
  // too, and an unknown field is refused rather than dropped: it means the
  // renderer and this contract disagree.
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = ['kind', 'id', 'draft', 'connectionRevision'];
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !allowed.includes(key))) throw invalid('请选择有效的草稿类型。');
  if (allowed.some(key => Object.hasOwn(descriptors, key) && !Object.hasOwn(descriptors[key], 'value'))) throw invalid('请选择有效的草稿类型。');
  const kind = descriptors.kind?.value as unknown;
  const id = descriptors.id?.value as unknown;
  const draft = descriptors.draft?.value as unknown;
  const connectionRevision = descriptors.connectionRevision?.value as unknown;
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) throw invalid('请选择有效的草稿类型。');
  // The refusal is the kind's own, because the two sentences ask for different
  // things: one to pick a draft type again, one to check the fireside draft.
  const fields = FIELDS[kind as DraftKind];
  const wrongShape = kind === 'fireside' ? '请填写有效的围炉协助草稿。' : '请选择有效的草稿类型。';
  if (Object.keys(descriptors).some(key => key !== 'kind' && !fields.includes(key))) throw invalid(wrongShape);
  if (kind === 'fireside' && fields.some(key => !Object.hasOwn(descriptors, key))) throw invalid(wrongShape);
  if (id !== undefined && (typeof id !== 'string' || !id || id.length > MAX_ID)) throw invalid('请选择有效的草稿类型。');
  if (draft !== undefined && (typeof draft !== 'string' || draft.length > MAX_DRAFT)) throw invalid('请填写有效的围炉协助草稿。');
  if (connectionRevision !== undefined && (!Number.isSafeInteger(connectionRevision) || (connectionRevision as number) < 0)) throw invalid('请填写有效的围炉协助草稿。');
  return {
    kind: kind as ChannelDraftRequest['kind'],
    ...(id === undefined ? {} : { id: id as string }),
    ...(draft === undefined ? {} : { draft: draft as string }),
    ...(connectionRevision === undefined ? {} : { connectionRevision: connectionRevision as number }),
  };
}

/** The fixed prompt BeingDesktop sends for a pairing code (src/main.cjs line
 * 1262), verbatim. It asks for the six digits and their lifetime and nothing
 * else: a Town client credential must never come back through a chat reply. */
export const PAIRING_DRAFT = '请为当前 Being 的 Being Desktop 生成一次性 Town 配对码：使用原生 http POST https://beings.town/api/client/pair。只返回六位配对码和有效期，不输出任何长期 token 或凭据。';

export function registerChannelIpc(options: ChannelIpcOptions): void {
  const { handle, exclusive, channel, afterChannel, methods, draft, draftContext, settleDraft, openPage, state } = options;

  // Local only: the renderer needs the epoch before it may send its first
  // request, and a push alone would leave a freshly mounted page without one.
  handle('beings:channel-status', (): ChannelWorkerState => state());

  /** A「功能任务」channel: recorded when a ledger is open, run either way. */
  const accounted = <T>(operation: string, args: unknown[], body: () => Promise<T>): Promise<T> => {
    const ledger = methods();
    return ledger ? ledger.run(args, { operation }, body) : body();
  };

  /** BeingDesktop's `handle` catch for a `townMethods` channel (src/main.cjs line
   * 741): resolve with the envelope rather than throw, so the code crosses. */
  const envelope = async <T>(body: () => Promise<T>): Promise<T | ReturnType<typeof townErrorEnvelope> | TaskLimitEnvelope> => {
    try { return await body(); }
    catch (error) {
      if (townErrorCode(error) === TASK_LIMIT.code) return { __townError: true, ...TASK_LIMIT };
      return townErrorEnvelope(error);
    }
  };

  handle('beings:channel-begin', (value: ChannelInput) =>
    envelope(() => accounted('beginChannelConnection', [value], () => afterChannel(() => channel.beginChannelConnection(value)))));

  // BeingDesktop's IPC name is `checkChannelStatus`; the method is
  // `ChannelBeing.getChannelStatus`. The ledger is keyed by the IPC name.
  handle('beings:channel-check', (value: ChannelInput) =>
    envelope(() => accounted('checkChannelStatus', [value], () => afterChannel(() => channel.getChannelStatus(value)))));

  // Read-only: opening the page, switching channel or refreshing must not enqueue
  // a Being message or re-register a channel merely because this client cannot
  // read its status (docs/channel-sessions.md「已有绑定状态」). Not a feature task,
  // and no `afterChannel` tail: nothing was sent, so there is nothing to sync.
  handle('beings:channel-inspect', (value: ChannelInput) =>
    envelope(() => Promise.resolve(channel.inspectChannelStatus(value))));

  // Always refuses, in the main process, before anything is read: an application
  // secret typed into this client would be one more place it exists. The sentence
  // says where it does belong.
  handle('beings:channel-feishu', (value: unknown) =>
    envelope(async () => channel.updateFeishuCredentials(value)));

  handle('beings:town-catalog', (): ChannelTownCatalog => getTownCatalog());

  // `townPageUrl` refuses any id without a confirmed public page — three of the
  // nine features have one. The tool browser, not the system browser: this is the
  // Being-facing surface (integration decision §5.6).
  handle('beings:town-page', (id: unknown) => {
    const url = townPageUrl(id);
    if (!openPage(url)) throw new Error('内置浏览器尚未就绪，请稍后重试。');
    return { opened: true as const };
  });

  handle('beings:town-draft', (value: unknown) => {
    const request = draftRequest(value);
    return exclusive(() => prepareDraft(request));
  });

  handle('beings:composer-draft-ack', (id: unknown, ack: unknown) => {
    if (typeof id !== 'string' || !id || id.length > 200) return { settled: false };
    if (ack !== 'placed' && ack !== 'occupied' && ack !== 'unavailable') return { settled: false };
    return { settled: settleDraft(id, ack) };
  });

  /** BeingDesktop's four handlers, as one. The argument validation each of them
   * did survives in ./town-catalog.ts; what is here is the epoch check the
   * fireside handoff alone performs, in the source's place — before the draft is
   * pushed, so a stale draft is refused rather than placed and then withdrawn. */
  function prepareDraft(request: ChannelDraftRequest): Promise<{ prepared: true }> {
    if (request.kind === 'feature') return draft(featureDraft(request.id), draftContext);
    if (request.kind === 'assistance') return draft(assistanceDraft(request.id), draftContext);
    if (request.kind === 'pairing') return draft(PAIRING_DRAFT, draftContext);
    const prompt = firesideDraft(request.draft);
    const context = requireDraftContext(draftContext);
    if (context.generation !== request.connectionRevision) throw new Error(FIRESIDE_EPOCH_CHANGED);
    return draft(prompt, draftContext);
  }
}
