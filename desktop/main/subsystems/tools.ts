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
import type { OrchestrationLike } from '../tools/types';
import { WorkerPresentation } from '../tools/worker-presentation';
import { parseConnection, sessionPartition } from '../common/loom-connection';
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

export function installToolsSubsystem(ctx: SubsystemContext): ToolsSubsystem {
  const report = (scope: string, error: unknown) => { try { ctx.onError(scope, error); } catch { /* Reporting a failure must not raise one. */ } };
  const push = toolsPush(() => ({ send: ctx.push }));

  // I2 reached both of these through `ctx.registry as unknown as { get(key: string) }`
  // and a structural restatement of each peer's shape, because I3 and I4 landed in
  // parallel branches and their `SubsystemMap` keys were not visible here. Both are
  // merged now, so the lookups are the typed ones and the restatements are gone
  // (IM, 2026-09-16). Every use stays optional-chained: an absent peer is normal.
  const orchestrationPeer = () => {
    try { return ctx.registry.get('orchestration'); }
    catch { return null; }
  };
  const terminalPeer = () => {
    try { return ctx.registry.get('terminal'); }
    catch { return null; }
  };
  /** The tool browser's single instance, or null while it is not installed.
   *
   * Resolved on every access and NEVER during install: `INSTALLERS` order is
   * meaningless, so reading it here would answer null and make `DesktopTools`
   * build the second instance (docs/migration/i3-terminal-browser.md D1). */
  const toolBrowser = () => {
    try { return ctx.registry.get('tool-browser')?.browser ?? null; }
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

  /** 0.8.26 reads `state.workspace.path`, which is the Desktop project workspace
   * when one is chosen and the Portal's otherwise. `Settings` carries both halves
   * (desktop/shared/types.ts). */
  const currentWorkspace = () => ctx.store.settings.projectWorkspace || ctx.store.settings.workspace || '';

  let tools: DesktopTools | null = null;
  let links: BrowserLinks | null = null;
  let portalRequest: PortalRequestAdapter | null = null;
  let blocked = '';
  let closed = false;
  /** The identity the link and the terminal scopes currently belong to, as
   * `sessionPartition` names it. Empty until a Being has been verified. */
  let identity = '';
  /** The workspace the panel was last told about. `snapshot().workspace` is read
   * at snapshot time, so a workspace that changes without anything else changing
   * leaves the console pane's「在 X 运行」on the previous directory until some
   * unrelated event pushes. 0.8.26 has an explicit push for it
   * (src/main.cjs line 579: `state.workspace = {…}; desktopTools?.changed();`). */
  let workspace = '';

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

  // 0.8.26 built the browser inside `new DesktopTools(...)`, so a refused Electron
  // façade was a construction failure and the bridge simply did not exist. The
  // browser is now injected and therefore built lazily, so that check has to live
  // here to keep the same surface — otherwise the refusal would surface as a throw
  // out of the first `snapshot()`, which runs inside `changed()`'s `setImmediate`.
  const View = ctx.electron.WebContentsView as BrowserViewConstructor | null;
  const viewSession = ctx.electron.session as BrowserSessionFactory | null;
  if (typeof View !== 'function' || typeof viewSession?.fromPartition !== 'function') {
    blocked = '桌面工具暂时不可用，请检查客户端配置目录后重启。';
    // FILED, NOT ONLY SHOWN. Before the check moved up here this failure was a
    //「浏览器依赖无效。」out of `new Browser`, caught below and written to
    // client-errors.log as `tools-install`; a panel message the user may never
    // open is not a diagnosis. The same line is in `subsystems/tool-browser.ts`,
    // so one broken façade leaves one entry per subsystem that noticed it.
    report('tools-install', new Error('Electron 浏览器门面不可用，桌面工具桥未启动。'));
  } else try {
    tools = new DesktopTools({
      desktopId: ctx.desktopId,
      // `ElectronBindings` types these three as `unknown` on purpose, so that a
      // test building a context does not have to produce real Electron classes
      // (desktop/main/subsystems/types.ts). This is the one use site, and the
      // cast is what that decision costs. `DesktopBrowser` validates all three at
      // construction and refuses with「浏览器依赖无效。」if they are not what it
      // expects, so a wrong façade fails loudly rather than half-working.
      WebContentsView: View,
      session: viewSession,
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
      getWorkspace: currentWorkspace,
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
      // The tool-browser subsystem owns the instance; `Browser` is only the
      // fallback for a build where that subsystem is absent or could not start.
      getBrowser: toolBrowser,
      Browser: DesktopBrowser,
      // The bridge builds its own browser lazily when the tool-browser subsystem
      // has none, and that build can still fail inside `DesktopBrowser`'s
      // constructor. It happens under `changed()`'s `setImmediate`, so the bridge
      // has nowhere to raise it — this is where it lands instead.
      onError: report,
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
    // What is left that can throw is a Desktop identity that is not a UUID (the
    // Electron façade is checked above). It means there is no tool bridge at all;
    // say which thing is broken rather than 请先连接 Being.
    blocked = '桌面工具暂时不可用，请检查客户端配置目录后重启。';
    report('tools-install', error);
  }

  if (tools) {
    // Whatever is saved right now is what the first snapshot will carry, so the
    // first `connectionVerified` must not read as a change.
    try { workspace = currentWorkspace(); }
    catch (error) { report('tools-workspace', error); }
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
      // A direct assignment, with no cast: IM widened `WorkerPresenter` to what
      // `WorkerPresentation` actually is (docs/migration/im-integration.md §2.6).
      peer.orchestration.presentation = new WorkerPresentation({
        browser: tools.browser,
        showBrowser,
        normalizeUrl: normalizeBrowserUrl,
      });
    },
    connectionVerified() {
      // 0.8.26 does not open the relay when a Being is verified: the link is
      // connected by `connectOrchestration()` when orchestration mode is on, and
      // by the panel's「连接 Being 工具」button otherwise.
      //
      // What it DOES do, and only when the identity actually changed, is drop
      // everything the previous Being owned — `src/main.cjs` line 710 guards this
      // with `sessionPartition(connection) !== sessionPartition(parsed)`. The
      // guard is the whole behaviour, not an optimisation: this shell re-verifies
      // on `beings:portal-start`, on `beings:save` and on a takeover preflight, so
      // an unguarded disconnect would cut a live tool bridge every time someone
      // started their Portal. `disconnectLink` bumps the generation, which cancels
      // every queued call with「工具连接已断开。」, and `terminalTools.reset()`
      // forgets the session scopes the previous Being's calls were bound to.
      if (closed || !tools) return;
      // THE WORKSPACE, WHICH IS NOT ABOUT THE IDENTITY AND SO GOES FIRST.
      // 0.8.26 pushes a tool state the moment a project directory is chosen; this
      // shell has no separate event for it — `beings:save` re-verifies the
      // connection — so the check rides along here, ahead of the identity guard's
      // early return. Without it the console pane keeps showing the previous
      // directory until an unrelated browser, console or link change pushes.
      try {
        const nextWorkspace = currentWorkspace();
        if (nextWorkspace !== workspace) { workspace = nextWorkspace; tools.changed(); }
      } catch (error) { report('tools-workspace', error); }
      let next = '';
      try { if (ctx.store.connectionAddress) next = sessionPartition(parseConnection(ctx.store.connectionAddress)); }
      catch (error) { report('tools-connection', error); }
      if (next && next === identity) return;
      identity = next;
      try { tools.disconnectLink(); tools.terminalTools.reset(); }
      catch (error) { report('tools-disconnect', error); }
    },
    async connectionCleared() {
      if (closed || !tools) return;
      identity = '';
      try { tools.disconnectLink(); tools.terminalTools.reset(); }
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
