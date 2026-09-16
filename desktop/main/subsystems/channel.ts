// The Feishu/WeChat channel, the Town feature catalogue and the native composer
// draft, as a subsystem; 2026-09-16 (integration unit I7).
//
// This is BeingDesktop 0.8.26's `boot()` lines 418-435 (the `ChannelBeing` and
// its `runChannel` tail), 1238/1252-1262 (the catalogue and the four `prepare*`)
// and 1329-1332 (the four channel handlers), re-expressed against the installer
// contract in ./types.ts.
//
// WHY THESE THREE THINGS ARE ONE SUBSYSTEM
//
// They are one lifecycle and one dependency set. The channel request, the
// catalogue's feature drafts and the fireside handoff all end in the same place —
// a prompt placed in the conversation the user is looking at — and all three are
// fenced against the same connection epoch, which is the only state this file
// keeps. BeingDesktop registers them from the same composition root for the same
// reason.
//
// THE FOUR PEERS, ALL LAZY (./types.ts's one rule)
//
//   chat          `sessions.ensureChannel(channel)`  — the stable per-channel scene
//   town          `session.getChannelStatus()`       — the read-only service snapshot
//   orchestration `methods` / `register` / `setDraftPreparer`
//   tools         `links.open(url)`                  — the tool browser
//
// Every one of them is reached through `ctx.registry` inside a closure. The tool
// bridge and orchestration are additionally allowed to be absent: without the
// bridge a public Town page says so instead of opening, and without the ledger a
// channel request still runs, merely unrecorded — which is BeingDesktop's own
// behaviour before a ledger is open.
//
// `setDraftPreparer` is the exception the contract names: it is an ASSIGNMENT
// onto a peer, not a read, so it happens in `linked()` — after every installer has
// run and before the client opens.
import { ChannelBeing } from '../town/channel/channel-being';
import { createDraftAcks, createNativeDraft, type NativeDraftContext } from '../town/channel/draft';
import { registerChannelIpc, type ChannelFeatureMethods } from '../town/channel/ipc';
import { parseConnection, type LoomConnection } from '../common/loom-connection';
import type { ChannelSession } from '../town/channel/types';
import type { ChannelWorkerState } from '../../shared/channel-types';
import type { FeatureTaskContext, PrepareFeatureTaskDraft } from '../features/types';
import type { DesktopSubsystem, SubsystemContext } from './types';

export interface ChannelSubsystem extends DesktopSubsystem {
  readonly key: 'channel';
  /** The Being-facing channel worker. Its `state()` is what the renderer paints
   * while a request is in flight. */
  readonly channel: ChannelBeing;
  /** `prepareNativeDraft`, exposed so the feature-task discussion and any later
   * unit reach the same composer through the same fence rather than inventing a
   * second path to it. */
  readonly prepareDraft: (prompt: string, getContext: () => NativeDraftContext) => Promise<{ prepared: true }>;
  /** The connection epoch a draft is fenced against. */
  draftContext(): NativeDraftContext;
  /** What the renderer paints: the epoch, the binding and the last outcome. */
  state(): ChannelWorkerState;
}

declare module './types' { interface SubsystemMap { 'channel': ChannelSubsystem } }

/** What this subsystem needs of the tool bridge and of orchestration, declared
 * structurally: both are other units' types and both may be absent. */
interface ToolsPeer { links?: { open(url: unknown): { opened: true; tabId: string | null } } | null }
interface OrchestrationPeer {
  methods?: ChannelFeatureMethods;
  register?(record: unknown): void;
  setDraftPreparer?(prepare: PrepareFeatureTaskDraft | null): void;
}
/** The chat layer's channel-session minting (P1's `ChatSessions`). */
interface ChatPeer { sessions?: { readonly open: boolean; ensureChannel(channel: string): ChannelSession; syncChannel(): Promise<unknown> } | null }

const notConnected = (message: string): Error => Object.assign(new Error(message), { code: 'NOT_CONNECTED' });

export function installChannelSubsystem(ctx: SubsystemContext): ChannelSubsystem {
  const report = (scope: string, error: unknown) => { try { ctx.onError(scope, error); } catch { /* Reporting a failure must not raise one. */ } };

  // ── The connection epoch ────────────────────────────────────────────────────
  // `generation` changes when the bound identity does; `identityRevision` when
  // the Being's own profile changes under a stable connection. BeingDesktop
  // fences a channel request against both (src/channel-being.cjs `_context`) and
  // a draft against both plus the Loom view's own generation, which has no
  // analogue here (../town/channel/draft.ts).
  let address = '';
  // The parsed address, in BeingDesktop's own shape. `ChannelBeing` hands
  // `connection.url` to `BeingClient`, which re-parses it, and treats `token` and
  // `secret` as the two strings to redact out of anything the Being says back —
  // so this must be the full address, not the display half.
  let connection: LoomConnection | null = null;
  let beingName = '';
  let generation = 0;
  let identityRevision = 0;
  let connected = false;
  let exiting = false;

  const registry = ctx.registry as unknown as { get(key: string): unknown };
  const peer = <T>(key: string): T | null => {
    try { return (registry.get(key) as T | null) ?? null; }
    catch (error) { report(`channel-registry:${key}`, error); return null; }
  };
  const sessions = () => peer<ChatPeer>('chat')?.sessions ?? null;
  const orchestration = () => peer<OrchestrationPeer>('orchestration');
  const links = () => peer<ToolsPeer>('tools')?.links ?? null;

  const draftContext = (): NativeDraftContext => ({
    connection,
    generation,
    revision: identityRevision,
    configured: Boolean(address),
    status: connected ? 'connected' : 'disconnected',
    exiting,
  });

  /** The snapshot the renderer reads on mount and receives on every change. The
   * epoch is this subsystem's own — see `ChannelWorkerState`. */
  const state = (): ChannelWorkerState => ({ ...channel.state(), connectionRevision: generation, connected: connected && !exiting });
  const publish = () => { try { ctx.push('beings:channel-state', state()); } catch (error) { report('channel-publish', error); } };

  const acks = createDraftAcks();
  const prepareDraft = createNativeDraft({ push: ctx.push, waitAck: (id, ms) => acks.wait(id, ms) });

  const channel = new ChannelBeing({
    // The read-only service snapshot. Town's own session owns the request, its
    // identity check and its DTO; this subsystem only says which one to use.
    readStatus: options => {
      const town = peer<{ session?: { getChannelStatus(options: { signal?: AbortSignal }): Promise<unknown> } }>('town');
      if (!town?.session) throw Object.assign(new Error('暂时无法读取渠道状态。'), { code: 'SERVICE_ERROR' });
      return town.session.getChannelStatus(options);
    },
    // BeingDesktop src/main.cjs line 420: a channel scene is minted from the
    // conversation layer, so it is the same stable id the conversation list shows
    // and the same one that survives a restart (docs/channel-sessions.md).
    getSession: name => {
      const chat = sessions();
      if (!chat?.open) throw notConnected('请等待 Being 会话加载完成。');
      return chat.ensureChannel(name);
    },
    getContext: () => ({
      connection,
      configured: Boolean(address),
      connected,
      exiting,
      connectionId: generation,
      identityRevision,
      beingName,
    }),
    // BeingDesktop wraps every Being-facing fetch this way (src/main.cjs line
    // 425): no cookies and no referrer leave this client.
    fetchImpl: (url, init) => ctx.electron.net.fetch(url as string, { ...init, credentials: 'omit', referrerPolicy: 'no-referrer' }),
    onChange: () => publish(),
    // `registerFeatureRequest`: the Being's own outgoing request joins the ledger
    // of whichever task started it. The record carries the prompt, never a
    // credential — `ChannelBeing` builds it from its own fixed template.
    onRequest: record => { try { orchestration()?.register?.(record); } catch (error) { report('channel-request-record', error); } },
  });

  // BeingDesktop's `runChannel` (src/main.cjs lines 429-435), verbatim in
  // structure: after a channel request, read back whatever the Being wrote
  // outside the foreground reader — but only if the same conversation layer is
  // still bound to the same identity. A sync fired across a Being switch would
  // pull the previous profile's history into the current one.
  const afterChannel = async <T>(action: () => Promise<T>): Promise<T> => {
    const owner = sessions(), revision = generation;
    try { return await action(); }
    finally {
      if (owner?.open && owner === sessions() && revision === generation) void owner.syncChannel().catch(() => { /* A background read never changes the request's result. */ });
    }
  };

  registerChannelIpc({
    handle: ctx.handle,
    exclusive: ctx.exclusive,
    channel,
    afterChannel,
    methods: () => orchestration()?.methods ?? null,
    draft: prepareDraft,
    draftContext,
    settleDraft: (id, ack) => acks.settle(id, ack),
    state,
    openPage: url => {
      const browser = links();
      if (!browser) return false;
      browser.open(url);
      return true;
    },
  });

  return {
    key: 'channel',
    channel,
    prepareDraft,
    draftContext,
    state,
    linked() {
      // The one thing a lazy getter cannot express (./types.ts): orchestration's
      // `beings:feature-task-discuss` needs THIS unit's preparer, and I4 left the
      // setter for it rather than guessing at a composer that did not exist yet.
      // The wrapper runs I4's own fence first — `current()` throws when the ledger
      // or the connection moved — and then supplies the fuller context this
      // preparer checks (status and the identity revision, which
      // `FeatureTaskContext` does not carry).
      const preparer: PrepareFeatureTaskDraft = (prompt, current) => prepareDraft(prompt, () => {
        current();
        return draftContext();
      });
      try { orchestration()?.setDraftPreparer?.(preparer); }
      catch (error) { report('channel-draft-preparer', error); }
    },
    connectionVerified(verified) {
      if (exiting) return;
      const next = ctx.store.connectionAddress || verified?.link || '';
      if (!next) {
        // Verified with nothing bound. `connectionCleared` is the obvious place
        // for this, but main.ts has never called it (docs/migration/i0-seams.md):
        // THIS is the path a disconnect actually takes, so it has to end the
        // channel rather than leave the page reporting a binding that is gone.
        address = ''; connection = null; beingName = ''; connected = false;
        generation++; identityRevision++;
        channel.reset();
        acks.reset();
        publish();
        return;
      }
      // A different Being is a new epoch: a channel request in flight is abandoned
      // and the per-channel scenes are re-minted under the new identity.
      if (next !== address) {
        address = next;
        try { connection = parseConnection(next); }
        catch (error) { report('channel-connection', error); connection = null; }
        generation++;
        channel.reset();
      }
      beingName = verified?.being || connection?.beingName || beingName;
      connected = true;
      publish();
    },
    async connectionCleared() {
      address = ''; connection = null; beingName = ''; connected = false;
      generation++; identityRevision++;
      channel.reset();
      acks.reset();
      publish();
    },
    async quitting() {
      exiting = true;
      channel.reset();
      acks.reset();
    },
  };
}

/** Exported for the subsystem's own tests: the context shape the ledger hands to
 * the draft preparer, so a test can build one without a whole orchestration. */
export type ChannelDraftFeatureContext = FeatureTaskContext;
