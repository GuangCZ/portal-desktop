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
import { townErrorEnvelope } from '../../../shared/town-desktop-errors';
import type { ChannelBeing } from './channel-being';
import type { DraftAck, NativeDraftContextReader, PrepareNativeDraft } from './draft';
import type { ChannelDraftRequest, ChannelTownCatalog } from '../../../shared/channel-types';

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
  /** `browserLinks().open(...)` — the built-in tool browser, as BeingDesktop's
   * `openTownPage` uses it (src/main.cjs line 1252). Null when the tool bridge is
   * not installed. */
  openPage: (url: string) => boolean;
}

const MAX_ID = 64;
const MAX_DRAFT = 32_000;

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
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !['kind', 'id', 'draft', 'connectionRevision'].includes(key))) throw invalid('请选择有效的草稿类型。');
  const { kind, id, draft, connectionRevision } = value as unknown as ChannelDraftRequest;
  if (!['feature', 'assistance', 'fireside', 'pairing'].includes(kind as string)) throw invalid('请选择有效的草稿类型。');
  if (id !== undefined && (typeof id !== 'string' || !id || id.length > MAX_ID)) throw invalid('请选择有效的草稿类型。');
  if (draft !== undefined && (typeof draft !== 'string' || draft.length > MAX_DRAFT)) throw invalid('请填写有效的围炉协助草稿。');
  if (connectionRevision !== undefined && (!Number.isSafeInteger(connectionRevision) || connectionRevision < 0)) throw invalid('请填写有效的围炉协助草稿。');
  return { kind: kind as ChannelDraftRequest['kind'], ...(id === undefined ? {} : { id }), ...(draft === undefined ? {} : { draft }), ...(connectionRevision === undefined ? {} : { connectionRevision }) };
}

/** The fixed prompt BeingDesktop sends for a pairing code (src/main.cjs line
 * 1262), verbatim. It asks for the six digits and their lifetime and nothing
 * else: a Town client credential must never come back through a chat reply. */
export const PAIRING_DRAFT = '请为当前 Being 的 Being Desktop 生成一次性 Town 配对码：使用原生 http POST https://beings.town/api/client/pair。只返回六位配对码和有效期，不输出任何长期 token 或凭据。';

export function registerChannelIpc(options: ChannelIpcOptions): void {
  const { handle, exclusive, channel, afterChannel, methods, draft, draftContext, settleDraft, openPage } = options;

  /** A「功能任务」channel: recorded when a ledger is open, run either way. */
  const accounted = <T>(operation: string, args: unknown[], body: () => Promise<T>): Promise<T> => {
    const ledger = methods();
    return ledger ? ledger.run(args, { operation }, body) : body();
  };

  /** BeingDesktop's `handle` catch for a `townMethods` channel (src/main.cjs line
   * 741): resolve with the envelope rather than throw, so the code crosses. */
  const envelope = async <T>(body: () => Promise<T>): Promise<T | ReturnType<typeof townErrorEnvelope>> => {
    try { return await body(); }
    catch (error) { return townErrorEnvelope(error); }
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
