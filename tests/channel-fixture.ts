// The Channel subsystem, installed the way main.ts installs it; 2026-09-16
// (integration unit I7).
//
// It installs the REAL `installSubsystems` with exactly the installers a case
// needs — the conversation core (for `ensureChannel`) and this unit — rather than
// the whole `INSTALLERS` list, so a failure here names this unit and not whoever
// else happens to be registered (subsystems/types.ts, and the rule in the task:
// 「注册表测试只装本单元需要的子系统」). The trusted-sender `handle` wrapper is the
// real one too, so the origin check and the quitting guard are exercised rather
// than described.
//
// The Town session and the tool bridge are NOT installed. Both are reached
// through the registry and both are legitimately absent — a fixture may add a
// stand-in for either with `extra`, which is how the read-only status path and
// the public-page path are driven.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTrustedHandle } from '../desktop/main/app/ipc';
import { installSubsystems } from '../desktop/main/extensions';
import { installChatSubsystem } from '../desktop/main/subsystems/chat';
import { installChannelSubsystem } from '../desktop/main/subsystems/channel';
import { isTownErrorEnvelope, townErrorFromEnvelope } from '../desktop/shared/town-desktop-errors';
import { publicErrorMessage } from '../desktop/shared/errors';
import type { SubsystemContext, SubsystemInstaller } from '../desktop/main/subsystems/types';
import type { Connection } from '../desktop/main/chat/connection';

export const DESKTOP_ID = '11111111-1111-4111-8111-111111111111';
export const SHELL = 'beings://desktop/index.html';
export const TOKEN = 'c'.repeat(64);
export const ADDRESS = `https://echo.beings.town/cz_being/?token=${TOKEN}`;
export const CONNECTION: Connection = {
  endpoint: 'https://echo.beings.town/cz_being', being: 'cz_being', token: TOKEN, relaySecret: TOKEN, link: ADDRESS,
};

/** The channels this unit registers, in registration order. */
export const CHANNEL_CHANNELS = [
  'beings:channel-status', 'beings:channel-begin', 'beings:channel-check',
  'beings:channel-inspect', 'beings:channel-feishu',
  'beings:town-catalog', 'beings:town-page', 'beings:town-draft',
  'beings:composer-draft-ack',
];
/** The four that answer a failure with an envelope rather than a throw. */
export const ENVELOPED = new Set(['beings:channel-begin', 'beings:channel-check', 'beings:channel-inspect', 'beings:channel-feishu']);

export const settle = async () => { for (let i = 0; i < 25; i++) await new Promise(resolve => setImmediate(resolve)); };

export const json = (value: unknown, status = 200) =>
  new Response(value === null ? null : JSON.stringify(value), { status, headers: value === null ? {} : { 'Content-Type': 'application/json' } });
export const sse = (frames: string) => new Response(frames, { headers: { 'Content-Type': 'text/event-stream' } });
export const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

type Responder = (url: URL, options: RequestInit) => Response | Promise<Response>;

export interface ChannelFixtureOptions {
  /** Extra installers, for the peers a case needs (a Town stand-in, a bridge). */
  extra?: SubsystemInstaller[];
  /** Skip the conversation core: the channel then has no session to mint. */
  withChat?: boolean;
  /** A previous fixture's data directory, to exercise a restart. */
  directory?: string;
}

export async function channelFixture({ extra = [], withChat = true, directory }: ChannelFixtureOptions = {}) {
  const own = directory ?? await mkdtemp(path.join(os.tmpdir(), 'channel-ipc-test-'));
  const routes = new Map<string, Responder[]>(), defaults = new Map<string, Responder>();
  const calls: { path: string; body: any; options: RequestInit }[] = [];
  const on = (route: string, responder: Responder) => {
    if (!routes.has(route)) routes.set(route, []);
    routes.get(route)!.push(responder);
  };
  const always = (route: string, responder: Responder) => defaults.set(route, responder);
  const fetchImpl = (async (url: string, options: RequestInit = {}) => {
    // Strip whichever Being's path prefix the address carries, so one route table
    // serves both identities a Being-switch case binds.
    const parsed = new URL(url), route = parsed.pathname.replace(/^\/[a-zA-Z0-9_-]+(?=\/api\/)/, '');
    calls.push({ path: route, body: options.body ? JSON.parse(String(options.body)) : undefined, options });
    const responder = routes.get(route)?.shift() || defaults.get(route);
    if (!responder) throw new Error(`no route: ${route}`);
    return responder(parsed, options);
  }) as unknown as typeof fetch;
  always('/api/history', () => json({ messages: [] }));
  always('/api/stream/active', () => json(null, 204));

  const handlers = new Map<string, (event: any, ...args: any[]) => Promise<unknown>>();
  const pushes: { channel: string; payload: any }[] = [];
  const errors: { scope: string; error: unknown }[] = [];
  let destroyed = false, quitting = false;
  const mainFrame = { url: SHELL };
  const webContents = {
    mainFrame, isDestroyed: () => destroyed,
    send: (channel: string, payload: unknown) => { pushes.push({ channel, payload }); },
  };
  const window = { isDestroyed: () => destroyed, webContents };
  const store = { connection: null as Connection | null, connectionAddress: '' };
  const secretStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  };
  const queue: Promise<unknown> = Promise.resolve();
  let tail = queue;
  const handle = createTrustedHandle({
    register: (channel, listener) => { handlers.set(channel, listener); },
    window: () => window, shellURL: () => SHELL,
    quitting: () => quitting, recoveryBlocked: () => false,
    report: (_channel, error) => publicErrorMessage(error),
  });
  const installers = [...(withChat ? [installChatSubsystem] : []), ...extra, installChannelSubsystem];
  const extensions = installSubsystems({
    handle,
    // The real mutation queue's shape: one operation at a time, in order.
    exclusive: <T,>(operation: () => Promise<T>): Promise<T> => {
      const next = tail.then(operation, operation);
      tail = next.then(() => undefined, () => undefined);
      return next;
    },
    window: () => window, store, secretStorage, userData: own,
    desktopId: DESKTOP_ID, clientVersion: '0.9.0', fetchImpl,
    onError: (scope, error) => { errors.push({ scope, error }); },
    electron: {
      net: { fetch: fetchImpl, request: null, isOnline: () => true },
      shell: { openPath: async () => '', openExternal: async () => { /* not this unit's path */ } },
      safeStorage: secretStorage,
    },
  }, installers);

  const connect = async (connection: Connection = CONNECTION, value = ADDRESS) => {
    store.connection = connection;
    store.connectionAddress = value;
    extensions.connectionVerified(connection);
    await extensions.ready;
    await settle();
  };
  const invoke = (channel: string, ...args: unknown[]) =>
    handlers.get(channel)!({ sender: webContents, senderFrame: mainFrame }, ...args);
  /** The renderer's view: preload/channels/channel.ts turns the envelope back
   * into an Error carrying `code`. */
  const call = async (channel: string, ...args: unknown[]) => {
    const result = await invoke(channel, ...args);
    if (ENVELOPED.has(channel) && isTownErrorEnvelope(result)) throw townErrorFromEnvelope(result);
    return result as any;
  };
  const codeOf = async (channel: string, ...args: unknown[]) => {
    try { await call(channel, ...args); return ''; }
    catch (error) { return String((error as { code?: unknown }).code ?? ''); }
  };
  /** The epoch the renderer has to carry on every channel request. It is read,
   * never assumed: `ChannelBeing` compares it against the identity it holds, and
   * the renderer's only source for it is `beings:channel-status`. */
  const revision = async (): Promise<number> => (await call('beings:channel-status')).connectionRevision;
  /** `{channel, connectionRevision}` with the live epoch — what the page sends. */
  const request = async (name: string) => ({ channel: name, connectionRevision: await revision() });
  const untrusted = (channel: string, ...args: unknown[]) =>
    handlers.get(channel)!({ sender: webContents, senderFrame: { url: 'https://evil.example/' } }, ...args);

  return {
    extensions, handlers, pushes, errors, calls, on, always, connect, call, invoke, codeOf, untrusted,
    revision, request,
    store, directory: own,
    chat: () => (extensions as unknown as { chat: { ensureChannel(name: string): { sessionId: string; sceneId: string } } | null }).chat,
    drafts: () => pushes.filter(entry => entry.channel === 'beings:composer-draft'),
    quit: () => { quitting = true; },
    destroy: () => { destroyed = true; },
    cleanup: async () => {
      await extensions.quitting();
      // The conversation cache can still be finishing a write when `quitting`
      // resolves; let it land, and retry the removal rather than racing it.
      await settle();
      if (!directory) await rm(own, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    },
  };
}

export type ChannelFixture = Awaited<ReturnType<typeof channelFixture>>;

/** A minimal stand-in for another unit's subsystem, installed through the real
 * registry so the lazy lookups this unit performs are the ones under test. */
export function stubSubsystem(key: string, value: Record<string, unknown>): SubsystemInstaller {
  return (_ctx: SubsystemContext) => ({ key: key as never, ...value }) as never;
}
