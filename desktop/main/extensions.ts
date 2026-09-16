// The Being Desktop subsystems the portal-desktop shell has no equivalent of, and
// the one place main.ts hooks them; 2026-09-16.
//
// It exists so `main.ts` grows one line rather than fifty per subsystem.
// Everything a subsystem needs arrives as one context, and everything it needs to
// be told about goes back as three lifecycle notifications — mirroring the three
// points BeingDesktop itself acts on (see subsystems/chat.ts) — plus `linked()`,
// which this file fires itself once every installer has run.
//
// Nothing here imports electron: the window, the electron façade, the fetcher and
// the queue are all passed in, which is what lets the whole hook be exercised from
// a test without a running application.
//
// ── THE APPEND-ONLY LIST ──────────────────────────────────────────────────────
// `INSTALLERS` below is one of the six shared lines the integration units share.
// Landing a subsystem is exactly two appended lines — one `import`, one array
// entry with a trailing comma — and nothing else in this file. Order carries no
// meaning: cross-subsystem references are lazy by contract (subsystems/types.ts),
// so whichever installs first still resolves the other. Do not reorder, do not
// group, do not edit another unit's line.
import type { SecretStorage } from './app/settings';
import type { Connection } from './chat/connection';
import type { ChatSessions } from './chat/sessions';
import type { Settings } from '../shared/types';
import type {
  DesktopSubsystem, ElectronBindings, ExtensionWindow, SubsystemContext,
  SubsystemInstaller, SubsystemMap, SubsystemRegistry, SubsystemSettings,
} from './subsystems/types';
import { installChatSubsystem } from './subsystems/chat';
import { installTownSubsystem } from './subsystems/town';

const INSTALLERS: SubsystemInstaller[] = [
  installChatSubsystem,
  installTownSubsystem,
];
// ──────────────────────────────────────────────────────────────────────────────

export type { ExtensionWindow };

/** The part of `SettingsStore` a subsystem reads. The last three are optional so a
 * focused test can hand over the two fields the conversation layer needs without
 * building a whole profile; production always passes the real store. */
export interface ExtensionSettings {
  connection: Connection | null;
  connectionAddress: string;
  settings?: Settings;
  extras?: Readonly<Record<string, unknown>>;
  saveExtra?(patch: Record<string, unknown>): Promise<void>;
}

export interface DesktopExtensionsContext {
  /** main.ts's trusted-sender IPC wrapper: registration goes through it so every
   * channel added here inherits the same origin check and quitting guard. */
  handle: (channel: string, callback: (...args: any[]) => unknown) => void;
  /** The application's mutation queue. Handlers that change saved state use it;
   * `connectionVerified` deliberately does not. */
  exclusive: <T>(operation: () => Promise<T>) => Promise<T>;
  window: () => ExtensionWindow | null;
  store: ExtensionSettings;
  secretStorage: SecretStorage;
  userData: string;
  desktopId: string;
  clientVersion?: string;
  fetchImpl?: typeof fetch;
  /** The electron façade. Optional so a test may omit what it does not exercise;
   * the members it leaves out refuse rather than pretend to work. */
  electron?: Partial<ElectronBindings>;
  /** main.ts's error log. Failures here are reported, never thrown: a broken
   * subsystem must not stop the client opening. */
  onError?: (scope: string, error: unknown) => void;
}

export interface DesktopExtensions {
  /** The Being at `store.connectionAddress` answered `/api/status`. Every
   * subsystem is told, in installation order, and a failure in one is reported
   * rather than allowed to abort the rest. Returns immediately. */
  connectionVerified(connection: Connection | null): void;
  /** No Being is configured any more. */
  connectionCleared(): Promise<void>;
  /** Reverse installation order, so a subsystem is torn down before whatever it
   * was built on top of. One failure does not stop the others. */
  quitting(): Promise<void>;
  /** The live conversation layer, or null when it could not be built. */
  readonly chat: ChatSessions | null;
  /** Settles when the work started by the last `connectionVerified` has finished
   * in every subsystem. Only tests need it. */
  readonly ready: Promise<unknown>;
}

const NOT_AVAILABLE = '此功能在当前运行环境不可用。';

export function installDesktopExtensions(ctx: DesktopExtensionsContext): DesktopExtensions {
  return installSubsystems(ctx, INSTALLERS);
}

/** The registry machinery, with the installer list as a parameter.
 *
 * Production has exactly one caller — the line above, passing `INSTALLERS`. It is
 * a parameter so tests/subsystem-registry.test.ts can install fakes and assert the
 * three properties five parallel worktrees depend on (order independence, install
 * isolation, reverse shutdown) against the code that actually runs, rather than
 * against a re-creation of it. `INSTALLERS` itself stays module-private so no unit
 * is tempted to mutate the list at runtime instead of appending a line to it. */
export function installSubsystems(ctx: DesktopExtensionsContext, installers: readonly SubsystemInstaller[]): DesktopExtensions {
  const report = (scope: string, error: unknown) => { try { ctx.onError?.(scope, error); } catch { /* Reporting a failure must not raise one. */ } };
  const fetchImpl = ctx.fetchImpl ?? ctx.electron?.net?.fetch ?? fetch;
  const store: SubsystemSettings = {
    get connection() { return ctx.store.connection; },
    get connectionAddress() { return ctx.store.connectionAddress; },
    get settings() { return ctx.store.settings ?? ({} as Settings); },
    get extras() { return ctx.store.extras ?? {}; },
    saveExtra: patch => ctx.store.saveExtra
      ? ctx.store.saveExtra(patch)
      : Promise.reject(new Error('设置暂时无法写入，请重启客户端后重试。')),
  };
  const electron: ElectronBindings = {
    WebContentsView: ctx.electron?.WebContentsView ?? null,
    session: ctx.electron?.session ?? null,
    net: ctx.electron?.net ?? { fetch: fetchImpl, request: null, isOnline: () => true },
    clipboard: ctx.electron?.clipboard ?? { readText: async () => '', writeText: async () => { throw new Error(NOT_AVAILABLE); } },
    // electron's own convention: `openPath` answers with a message on failure.
    shell: ctx.electron?.shell ?? { openPath: async () => NOT_AVAILABLE, openExternal: async () => { throw new Error(NOT_AVAILABLE); } },
    ...(ctx.electron?.powerMonitor ? { powerMonitor: ctx.electron.powerMonitor } : {}),
    safeStorage: ctx.electron?.safeStorage ?? ctx.secretStorage,
  };

  const built = new Map<string, DesktopSubsystem>();
  const registry: SubsystemRegistry = {
    get: <K extends keyof SubsystemMap>(key: K) => (built.get(key as string) as SubsystemMap[K] | undefined) ?? null,
    require: <K extends keyof SubsystemMap>(key: K) => {
      const value = built.get(key as string);
      if (!value) throw new Error(`子系统 ${String(key)} 未安装。`);
      return value as SubsystemMap[K];
    },
  };
  const subsystemContext: SubsystemContext = {
    handle: ctx.handle,
    exclusive: ctx.exclusive,
    window: ctx.window,
    store,
    electron,
    userData: ctx.userData,
    desktopId: ctx.desktopId,
    clientVersion: ctx.clientVersion ?? '',
    fetchImpl,
    onError: report,
    registry,
    push: (channel, payload) => {
      const target = ctx.window();
      if (target && !target.isDestroyed() && !target.webContents.isDestroyed()) target.webContents.send(channel, payload);
    },
  };

  for (const install of installers) {
    // One subsystem failing to install must not take the others — or the client
    // window — with it. The scope names the installer so the log says which.
    try { const subsystem = install(subsystemContext); built.set(subsystem.key as string, subsystem); }
    catch (error) { report(`subsystem-install:${install.name}`, error); }
  }
  const order = [...built.values()];
  // The fourth fan-out, and the only one main.ts does not drive: every installer
  // has run, so a subsystem may now reach a peer that did not exist while its own
  // body ran. It is what lets the tool bridge assign orchestration its
  // `presentation` (integration plan §3.4) — an assignment, which no lazy getter
  // can express. Same rule as the other three: report, never throw.
  for (const subsystem of order) {
    try { subsystem.linked?.(); }
    catch (error) { report(`${String(subsystem.key)}-linked`, error); }
  }

  return {
    get chat() { return registry.get('chat')?.sessions ?? null; },
    get ready() { return Promise.all(order.map(subsystem => subsystem.ready ?? Promise.resolve())); },
    connectionVerified(connection) {
      for (const subsystem of order) {
        try { subsystem.connectionVerified?.(connection); }
        catch (error) { report(`${String(subsystem.key)}-verified`, error); }
      }
    },
    async connectionCleared() {
      for (const subsystem of order) {
        try { await subsystem.connectionCleared?.(); }
        catch (error) { report(`${String(subsystem.key)}-cleared`, error); }
      }
    },
    async quitting() {
      for (const subsystem of [...order].reverse()) {
        try { await subsystem.quitting?.(); }
        catch (error) { report(`${String(subsystem.key)}-quitting`, error); }
      }
    },
  };
}
