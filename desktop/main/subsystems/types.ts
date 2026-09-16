// The contract every Being Desktop subsystem is installed through; 2026-09-16.
//
// A subsystem is one bounded capability the portal-desktop shell has no
// equivalent of — the native conversation core, Town's direct reads, the tool
// bridge, the terminal, orchestration, the shell-state ledger. Each owns one file
// under this directory, exporting one `install<Key>Subsystem(ctx)` function, and
// `extensions.ts` holds the single list of them. That list, and the `SubsystemMap`
// augmentations below, are the only places two integration units touch the same
// line, and both are append-only.
//
// THE ONE RULE, and the reason this file exists rather than a constructor graph:
//
//   An installer's synchronous body may build only its own instance. A reference
//   to another subsystem must be stored as a LAZY getter —
//   `() => ctx.registry.require('tools').link.capabilities()` — never dereferenced
//   while installing. The real dependencies form a cycle (chat needs
//   orchestration's worker results, orchestration needs the tool bridge's
//   capabilities, the tool bridge needs chat's sessions), so any construction-time
//   `registry.get(...)` returns `undefined` for whichever half installs first.
//   Obey the rule and the order of `INSTALLERS` carries no meaning at all, which
//   is what makes merging five branches into it a three-line conflict.
//
// A subsystem file's header is always this shape:
//
//   import type { DesktopSubsystem, SubsystemContext } from './types';
//   export interface ToolsSubsystem extends DesktopSubsystem { /* what it exposes */ }
//   declare module './types' { interface SubsystemMap { 'tools': ToolsSubsystem } }
//   export function installToolsSubsystem(ctx: SubsystemContext): ToolsSubsystem { … }
import type { SecretStorage } from '../app/settings';
import type { Connection } from '../chat/connection';
import type { Settings } from '../../shared/types';

/** Structural, so a `BrowserWindow` satisfies it and a test's stub does too. */
export interface ExtensionWindow {
  isDestroyed(): boolean;
  webContents: { isDestroyed(): boolean; send(channel: string, payload: unknown): void };
}

/** The electron touchpoints a subsystem may need, as a narrow façade. This is the
 * only thing `main.ts` gains when a later unit lands: the shell stays the one
 * place that imports electron, and a subsystem test stays a plain object.
 *
 * `WebContentsView`, `session` and `net.request` are `unknown` on purpose. Typing
 * them would force every test that builds a context to produce a real electron
 * class; the two subsystems that need them (the tool browser, the Portal window
 * takeover) cast once at the use site and say so in a comment there. */
export interface ElectronBindings {
  /** electron.WebContentsView — the tool browser's tab host. */
  WebContentsView: unknown;
  /** electron.session — partitioned sessions keyed by `sessionPartition`. */
  session: unknown;
  net: { fetch: typeof fetch; request: unknown; isOnline(): boolean };
  /** Electron 44 clipboard: promise-based in both processes (measured against
   * node_modules/electron/electron.d.ts, not inferred from the docs). */
  clipboard: { readText(): Promise<string>; writeText(text: string): Promise<void> };
  /** `openPath` answers with electron's own convention: the empty string on
   * success, a message describing the failure otherwise. */
  shell: { openPath(target: string): Promise<string>; openExternal(target: string): Promise<void> };
  powerMonitor?: { on(event: 'suspend' | 'resume', callback: () => void): void };
  safeStorage: SecretStorage;
}

/** What a subsystem may read and write of the saved profile.
 *
 * DEVIATION from the integration plan §2.1, which had one `settings: Settings &
 * Record<string, unknown>`: `SettingsStore.settings` is the typed half only, and
 * the keys this client does not own (`sidebar`, `orchestration`, `typography`,
 * `chatBackground` …) live in a separate record it merges through untouched. They
 * are two different things and one intersection type would have hidden that, so
 * they are two members. `extras` is the raw disk record; `saveExtra` merges a
 * patch into it and rewrites settings.json, preserving every other key. */
export interface SubsystemSettings {
  readonly connection: Connection | null;
  /** The address exactly as saved, including the `api=` and `relay_secret=`
   * parameters `Connection` does not model — both feed the cache identity, so the
   * parsed connection alone is not enough. */
  readonly connectionAddress: string;
  readonly settings: Settings;
  readonly extras: Readonly<Record<string, unknown>>;
  saveExtra(patch: Record<string, unknown>): Promise<void>;
}

export interface SubsystemContext {
  /** main.ts's trusted-sender IPC wrapper: registration goes through it so every
   * channel a subsystem adds inherits the same origin check and quitting guard. */
  handle: (channel: string, callback: (...args: any[]) => unknown) => void;
  /** The application's mutation queue. Handlers that change saved state use it;
   * `connectionVerified` deliberately must not — see below. */
  exclusive: <T>(operation: () => Promise<T>) => Promise<T>;
  window: () => ExtensionWindow | null;
  store: SubsystemSettings;
  electron: ElectronBindings;
  userData: string;
  desktopId: string;
  clientVersion: string;
  /** electron's `net.fetch`, bound. Same object as `electron.net.fetch`; kept as
   * its own member because most subsystems want nothing else from electron. */
  fetchImpl: typeof fetch;
  /** Failures are reported, never thrown: one broken subsystem must not stop the
   * client opening. */
  onError: (scope: string, error: unknown) => void;
  /** The only way to reach another subsystem. Call it lazily — see the rule at
   * the top of this file. */
  registry: SubsystemRegistry;
  /** Push state to the renderer. The window guard (destroyed window, destroyed
   * webContents) is applied here, so a subsystem may call it at any time. Channel
   * names belong to each subsystem's own `preload/channels/<key>.ts`. */
  push: (channel: string, payload: unknown) => void;
}

export interface DesktopSubsystem {
  readonly key: keyof SubsystemMap;
  /** The Being at `store.connectionAddress` answered `/api/status`. Called from
   * inside main.ts's `verifyConnection`, which itself runs inside `exclusive`, so
   * this must neither await the queue (that would deadlock on the operation
   * calling it) nor hold up startup while a first read completes. BeingDesktop's
   * `startNativeChat` is fire-and-forget for the same reason (src/main.cjs line
   * 550). */
  connectionVerified?(connection: Connection | null): void;
  /** No Being is configured any more. Ends what is open and flushes what is still
   * being written, so the next binding starts from a complete file. */
  connectionCleared?(): Promise<void>;
  quitting?(): Promise<void>;
  /** Settles when the work started by the last `connectionVerified` has finished.
   * Only tests need it; the application is driven by the pushes. */
  readonly ready?: Promise<unknown>;
}

export type SubsystemInstaller = (ctx: SubsystemContext) => DesktopSubsystem;

/** Each subsystem adds its own key with a `declare module './types'` block in its
 * own file, so landing a subsystem never edits this one. */
export interface SubsystemMap {}

export interface SubsystemRegistry {
  /** The instance, or null when that subsystem is not installed or failed to
   * install. Optional-chain the result: a unit that can work without a peer
   * should keep working when the peer is absent. */
  get<K extends keyof SubsystemMap>(key: K): SubsystemMap[K] | null;
  /** The instance, or a throw naming the missing subsystem. For a peer the caller
   * genuinely cannot work without. */
  require<K extends keyof SubsystemMap>(key: K): SubsystemMap[K];
}
