// The desktop tool bridge, as a subsystem; 2026-09-16.
//
// This is the assembly point integration plan §3.2 describes, read line by line
// against BeingDesktop 0.8.26 `src/main.cjs` boot(): the `new DesktopTools({...})`
// at line 1696, the `orchestration.presentation = new WorkerPresentation({...})`
// at 1706, and `browserLinks()` at 599. Everything those lines reach through
// boot()'s single closure scope — the window, the connection, the workspace, the
// orchestration instance, the terminal — arrives here through `SubsystemContext`
// or through a lazy registry lookup, because this shell has no such scope.
//
// The three cross-subsystem references are each lazy for a different reason:
//
//  · ORCHESTRATION is read through a façade, not a getter. `DesktopTools` closes
//    over the `orchestration` CONSTRUCTOR ARGUMENT in `shouldReconnect` and
//    `toolAllowed`, not over `this.orchestration`, so assigning the field later
//    would fix `request()`/`invoke()` and silently leave the link's own two
//    predicates looking at whatever was passed at construction time. A façade
//    whose members forward on every read is the only shape that works for all
//    four. 0.8.26 passes a live object there, so this matches it.
//  · The TERMINAL is a plain `() => …` getter. `DesktopToolLink.toolAllowed`
//    already refuses `desktop_terminal_*` unless `getTerminal()` answers with
//    something and the platform is win32 or darwin, so an absent terminal
//    subsystem simply keeps those six tools out of `tools/list`.
//  · The PRESENTATION is an assignment onto orchestration, which no getter can
//    express, so it happens in `linked()` — the hook the seam stage added for
//    exactly this (docs/migration/i0-seams.md「修法（finding 2）」).
import { createBrowserLinks, type BrowserLinks } from '../tools/browser-links';
import { DesktopBrowser, normalizeBrowserUrl } from '../tools/browser/browser';
import { DesktopTools } from '../tools/desktop-tools';
import type { DesktopToolsSnapshot } from '../tools/desktop-tools';
import { registerToolsIpc, toolsPush } from '../tools/ipc';
import { portalRequestAdapter, type NativeRequestFactory, type PortalRequestAdapter } from '../tools/network';
import type {
  BrowserHostWindow, BrowserSessionFactory, BrowserViewConstructor,
} from '../tools/browser/host';
import type { DesktopTerminalLike, OrchestrationLike, ToolResult } from '../tools/types';
import { WorkerPresentation } from '../tools/worker-presentation';
import { parseConnection } from '../common/loom-connection';
import { desktopPortalName } from '../app/identity';
import type { DesktopSubsystem, SubsystemContext } from './types';

export interface ToolsSubsystem extends DesktopSubsystem {
  /** The bridge itself. Orchestration reads `link.capabilities()` off it for the
   * policy's enforcement check, and the conversation layer for the request
   * context frame's runtime half. */
  readonly tools: DesktopTools | null;
  /** External links and denied native popups, as tabs of the tool browser. The
   * shell's own `will-navigate` handling belongs to `ClientBrowser`; this is the
   * Being-facing half, used by Town page links and worker result links. */
  readonly links: BrowserLinks | null;
  /** `net.request` wrapped as a Node-shaped request with observable redirects,
   * for the Portal installer. Built here because this subsystem is where the
   * electron façade's `net.request` is unwrapped. */
  readonly portalRequest: PortalRequestAdapter | null;
}

declare module './types' { interface SubsystemMap { 'tools': ToolsSubsystem } }

/** The orchestration subsystem as THIS one needs it, declared structurally.
 *
 * I4 owns the real `OrchestrationSubsystem` type and it does not exist in this
 * worktree, so the registry lookup goes through one documented cast. Two members
 * are deliberately loose:
 *
 *  · `presentation` is typed as the tool side's own `WorkerPresentation`, not as
 *    orchestration's `WorkerPresenter`. The two do not line up today — measured
 *    with tsc on 2026-09-16, four mismatches, all of them about `null` vs
 *    `undefined` and about `WorkerPresentationValue` lacking `openedAt`; see
 *    docs/migration/i2-tools.md「类型对齐实测」. Runtime is unaffected:
 *    orchestration reads it as `this.presentation?.describe(x) || x`, where null
 *    and undefined take the same branch. Widening `WorkerPresenter` is the real
 *    fix and belongs to whoever merges I4.
 *  · `workers` is only inspected for the presence of a presentation, which is
 *    what 0.8.26's onChange does before asking orchestration to notify.
 */
interface OrchestrationPeer {
  readonly orchestration: {
    mode: { enabled: boolean };
    configuring?: boolean;
    tool(name: string, args: Record<string, unknown>, context: { signal?: AbortSignal }): Promise<ToolResult>;
    presentation?: WorkerPresentation;
    workers?: readonly { presentation?: unknown }[];
    notify?(): void;
  };
  readonly policy?: { syncBridge(): unknown };
}

/** The terminal subsystem as this one needs it. I3 owns the real type; the same
 * cast applies, and every use is optional-chained because the terminal is a
 * platform-conditional capability, not a dependency. */
interface TerminalPeer {
  readonly terminal: DesktopTerminalLike | null;
  /** Bring the panel forward and select one session. Rejects when the window is
   * gone, which is what `DesktopTerminalTools` turns into a tool error. */
  reveal(terminalId: string): unknown;
}

export function installToolsSubsystem(ctx: SubsystemContext): ToolsSubsystem {
  const report = (scope: string, error: unknown) => { try { ctx.onError(scope, error); } catch { /* Reporting a failure must not raise one. */ } };
  const push = toolsPush(() => ({ send: ctx.push }));

  // `SubsystemRegistry.get` is keyed on `SubsystemMap`, which only names the
  // subsystems this worktree can see. I4's and I3's keys land in parallel
  // branches, so reaching them goes through one cast to a string-keyed lookup
  // rather than a `declare module` block this unit would be inventing on their
  // behalf — two such blocks for one key is a merge conflict, and a wrong guess
  // at their shape is a compile error in whichever branch lands second.
  const peers = ctx.registry as unknown as { get(key: string): unknown };
  const orchestrationPeer = (): OrchestrationPeer | null => {
    try { return (peers.get('orchestration') as OrchestrationPeer | null) ?? null; }
    catch { return null; }
  };
  const terminalPeer = (): TerminalPeer | null => {
    try { return (peers.get('terminal') as TerminalPeer | null) ?? null; }
    catch { return null; }
  };

  /** Orchestration as `DesktopTools` reads it, resolved on every access.
   *
   * `mode.enabled` false and `configuring` false is exactly the state 0.8.26 is
   * in before orchestration is switched on, so an absent subsystem leaves the
   * bridge in direct mode rather than in a fourth, undefined one. */
  const orchestration: OrchestrationLike = {
    get mode() { return orchestrationPeer()?.orchestration.mode ?? { enabled: false }; },
    get configuring() { return orchestrationPeer()?.orchestration.configuring === true; },
    tool: (name, args, context) => {
      const peer = orchestrationPeer();
      if (!peer) return Promise.reject(new Error('编排模式未开启。'));
      return peer.orchestration.tool(name, args, context);
    },
  };

  let tools: DesktopTools | null = null;
  let links: BrowserLinks | null = null;
  let portalRequest: PortalRequestAdapter | null = null;
  let blocked = '';
  let closed = false;

  /** Whether the client is still in a state where showing something is sensible.
   * 0.8.26 checks `!exitStarted && win && !win.isDestroyed() && desktopTools`. */
  const live = () => !closed && Boolean(ctx.window()) && Boolean(tools);

  /** 0.8.26 pushes the tool state first, then asks the renderer to open the
   * panel, so the panel has something to draw the moment it appears (src/main.cjs
   * lines 601-604 for the browser, 1701-1703 for the terminal). The shell has no
   * `executeJavaScript` back channel; the panel opens itself when it sees a
   * reason to — a tab it did not have, or a request waiting. */
  const showBrowser = () => {
    if (!live()) throw new Error('桌面窗口已关闭。');
    push.state(tools!.snapshot());
    push.reveal('browser');
  };

  try {
    tools = new DesktopTools({
      desktopId: ctx.desktopId,
      // `ElectronBindings` types these three as `unknown` on purpose, so that a
      // test building a context does not have to produce real Electron classes
      // (desktop/main/subsystems/types.ts). This is the one use site, and the
      // cast is what that decision costs. `DesktopBrowser` validates all three at
      // construction and refuses with「浏览器依赖无效。」if they are not what it
      // expects, so a wrong façade fails loudly rather than half-working.
      WebContentsView: ctx.electron.WebContentsView as BrowserViewConstructor,
      session: ctx.electron.session as BrowserSessionFactory,
      getWindow: () => ctx.window() as unknown as BrowserHostWindow | null,
      // THE ONE CONVERSION THAT ONLY A REAL RELAY EXPOSES.
      // `DesktopToolLink.connect` wants BeingDesktop's `LoomConnection` — it
      // reads `connection.url` to find the relay origin and the Being id, and
      // `connection.token` for the handshake's `loom_token`. `ctx.store
      // .connection` is portal-desktop's own `Connection` (`{endpoint, being,
      // token, relaySecret, link}`), which has neither field under those names:
      // passing it straight through yields a handshake against a wrong origin, or
      // an empty token, and NOTHING in typecheck or vitest sees it because the
      // option is declared `() => unknown`. Parse the saved address instead — it
      // is the same string 0.8.26 parsed — and let a malformed one answer null so
      // `perform('link.connect')` refuses with「请先连接 Being。」.
      // Pinned by tests/tools-integration-connection.test.ts.
      getConnection: () => {
        const address = ctx.store.connectionAddress;
        if (!address) return null;
        try { return parseConnection(address); }
        catch (error) { report('tools-connection', error); return null; }
      },
      // 0.8.26 reads `state.workspace.path`, which is the Desktop project
      // workspace when one is chosen and the Portal's otherwise. `Settings`
      // carries both halves (desktop/shared/types.ts).
      getWorkspace: () => ctx.store.settings.projectWorkspace || ctx.store.settings.workspace || '',
      orchestration,
      getTerminal: () => terminalPeer()?.terminal ?? null,
      showTerminal: async (terminalId: string) => {
        const peer = terminalPeer();
        if (!peer) throw new Error('本版本的交互终端尚未就绪。');
        if (!live()) throw new Error('桌面窗口已关闭。');
        // 0.8.26 opens the console pane first, then asks the terminal panel to
        // select the session (src/main.cjs line 1701).
        push.reveal('console');
        await peer.reveal(terminalId);
      },
      desktopPortalName,
      Browser: DesktopBrowser,
      onChange: (snapshot: DesktopToolsSnapshot) => {
        const peer = orchestrationPeer();
        // The bridge's capabilities feed the orchestration policy's enforcement
        // check, so a change here has to reach it before the renderer draws the
        // new state (src/main.cjs line 1705). Failures are reported: a policy
        // that cannot sync must not stop the panel updating.
        if (peer?.policy) { try { void Promise.resolve(peer.policy.syncBridge()).catch(error => report('tools-sync-bridge', error)); } catch (error) { report('tools-sync-bridge', error); } }
        push.state(snapshot);
        // A worker whose result is on screen describes itself from the browser's
        // snapshot, so its own view changed too.
        if (peer?.orchestration.workers?.some(worker => worker.presentation)) {
          try { peer.orchestration.notify?.(); } catch (error) { report('tools-orchestration-notify', error); }
        }
      },
    });
  } catch (error) {
    // The two ways this throws are a Desktop identity that is not a UUID and an
    // Electron façade the browser refuses. Both mean there is no tool bridge at
    // all; say which thing is broken rather than 请先连接 Being.
    blocked = '桌面工具暂时不可用，请检查客户端配置目录后重启。';
    report('tools-install', error);
  }

  if (tools) {
    links = createBrowserLinks({
      getBrowser: () => tools!.browser,
      showBrowser,
      isCurrent: live,
      // 0.8.26 files this in the activity log rather than raising it: a link that
      // will not open is not a reason to fail whatever asked for it.
      onError: error => report('tools-browser-link', error),
      normalizeUrl: normalizeBrowserUrl,
    });
  }
  try {
    const request = ctx.electron.net.request as NativeRequestFactory | null;
    // Same `unknown` façade member as the browser's two, and the same one cast.
    if (typeof request === 'function') portalRequest = portalRequestAdapter(request);
  } catch (error) { report('tools-portal-request', error); }

  registerToolsIpc({
    handle: ctx.handle,
    tools: () => tools,
    clipboard: ctx.electron.clipboard,
    blocked: () => blocked,
  });

  return {
    key: 'tools',
    get tools() { return tools; },
    get links() { return links; },
    get portalRequest() { return portalRequest; },
    linked() {
      // Orchestration owns the worker records; this subsystem owns the browser a
      // result is shown in. The reference has to be ASSIGNED, which is why it is
      // here and not behind a getter (subsystems/types.ts). An absent
      // orchestration subsystem is normal, not an error.
      const peer = orchestrationPeer();
      if (!peer || !tools) return;
      peer.orchestration.presentation = new WorkerPresentation({
        browser: tools.browser,
        showBrowser,
        normalizeUrl: normalizeBrowserUrl,
      });
    },
    connectionVerified() {
      // 0.8.26 does not open the relay when a Being is verified: the link is
      // connected by `connectOrchestration()` when orchestration mode is on, and
      // by the panel's「连接 Being 工具」button otherwise. What a new binding does
      // need is for the previous one's link, approval queue and remote job list
      // to be gone — `disconnectLink` bumps the generation, which cancels every
      // pending call with「工具连接已断开。」.
      if (closed || !tools) return;
      try { tools.disconnectLink(); }
      catch (error) { report('tools-disconnect', error); }
    },
    async connectionCleared() {
      if (closed || !tools) return;
      try { tools.disconnectLink(); }
      catch (error) { report('tools-disconnect', error); }
    },
    async quitting() {
      if (closed) return;
      closed = true;
      // Ends the relay, refuses everything still queued, stops the console's
      // children and destroys the browser's views.
      try { await tools?.dispose(); }
      catch (error) { report('tools-dispose', error); }
    },
  };
}
