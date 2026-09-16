// The Town subsystem, installed the way main.ts installs it; 2026-09-16.
//
// A helper, not a test file (vitest collects `tests/**/*.test.ts` only). It is
// shared by tests/town-integration-ipc.test.ts and
// tests/town-integration-lifecycle.test.ts because both need the same thing: the
// real `installDesktopExtensions` hook, the real trusted-sender `handle` wrapper,
// a real temporary `userData`, and a routed fetch standing in for Town.
//
// Modelled on tests/chat-ipc.test.ts's fixture deliberately — a second shape for
// the same job would make the two units' tests disagree about what "installed"
// means.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTrustedHandle } from '../desktop/main/app/ipc';
import { installDesktopExtensions } from '../desktop/main/extensions';
import { publicErrorMessage } from '../desktop/shared/errors';
import { isTownErrorEnvelope, townErrorFromEnvelope } from '../desktop/shared/town-desktop-errors';
import type { Connection } from '../desktop/main/chat/connection';

export const CLIENT_TOKEN = 'a'.repeat(64);
const relay = 'c'.repeat(64);
export const SHELL = 'beings://desktop/';
export const ADDRESS = `https://echo.beings.town/cz_being/?token=${relay}`;
export const OTHER_ADDRESS = `https://echo.beings.town/river_being/?token=${relay}`;
export const CONNECTION: Connection = {
  endpoint: 'https://echo.beings.town/cz_being', being: 'cz_being',
  token: relay, relaySecret: relay, link: ADDRESS,
};
export const OTHER_CONNECTION: Connection = {
  endpoint: 'https://echo.beings.town/river_being', being: 'river_being',
  token: relay, relaySecret: relay, link: OTHER_ADDRESS,
};

export const json = (value: unknown, status = 200) =>
  new Response(value === null ? null : JSON.stringify(value), {
    status, headers: value === null ? {} : { 'Content-Type': 'application/json' },
  });

/** Every channel `registerTownDesktopIpc` adds, in registration order. The two at
 * the end are the anonymous public catalogue — a different surface, and the only
 * two that are not enveloped. */
export const TOWN_CHANNELS = [
  'beings:town-app', 'beings:town-app-refresh',
  'beings:town-timeline', 'beings:town-timeline-refresh', 'beings:town-timeline-older',
  'beings:town-read',
  'beings:town-bonfire', 'beings:town-fireside-messages', 'beings:town-firesides',
  'beings:town-fireside-members', 'beings:town-inbox', 'beings:town-beings',
  'beings:town-scrolls', 'beings:town-scroll', 'beings:town-cached', 'beings:town-members',
  'beings:town-profile-changed', 'beings:town-speak',
  'beings:town-client-pair', 'beings:town-client-auto-pair',
  'beings:town-client-retry-storage', 'beings:town-client-forget',
  'beings:town', 'beings:town-open',
];

export const PLAIN_CHANNELS = new Set(['beings:town', 'beings:town-open']);

export const settle = async () => { for (let i = 0; i < 25; i++) await new Promise(resolve => setImmediate(resolve)); };

type Responder = (url: URL, options: RequestInit) => Response | Promise<Response>;

export async function townFixture({ address = ADDRESS, online = false }: { address?: string; online?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'town-ipc-test-'));
  const routes = new Map<string, Responder[]>(), defaults = new Map<string, Responder>();
  const calls: { path: string; search: string; body: any; headers: Record<string, string> }[] = [];
  const on = (route: string, responder: Responder) => {
    if (!routes.has(route)) routes.set(route, []);
    routes.get(route)!.push(responder);
  };
  const always = (route: string, responder: Responder) => defaults.set(route, responder);
  const fetchImpl = (async (url: string, options: RequestInit = {}) => {
    const parsed = new URL(url), route = parsed.pathname.replace(/^\/(?:cz|river)_being/, '');
    calls.push({
      path: route, search: parsed.search,
      body: options.body ? JSON.parse(options.body as string) : null,
      headers: (options.headers || {}) as Record<string, string>,
    });
    const responder = routes.get(route)?.shift() || defaults.get(route);
    if (!responder) throw new Error(`no route: ${route}`);
    return responder(parsed, options);
  }) as unknown as typeof fetch;
  // The conversation layer's own startup reads. They belong to another unit's
  // tests; answered here only so this fixture's `calls` stays Town's.
  always('/api/history', () => json({ messages: [] }));
  always('/api/stream/active', () => json(null, 204));
  // Town's identity probe, which every authenticated read verifies against.
  always('/api/bonfire/mentions', () => json({ being: 'cz_being', town_id: 't_Willow', display_name: '柳树', mentions: [] }));
  // Town's public homepage: the community directory, which needs no credential.
  always('/api', () => json({ community: [{ town_id: 't_River', display_name: '河流', description: '' }] }));
  // Quiet defaults for the two feeds the background reader polls, so a test that
  // is not about them does not have to route them.
  always('/api/bonfire/hear', () => json({ ok: true, messages: [], global_latest_seq: 0 }));
  always('/api/fireside/list', () => json({ ok: true, owned: [], joined: [] }));
  always('/api/client/stream', () => new Response(new ReadableStream<Uint8Array>({ start() { /* held open */ } }), { headers: { 'Content-Type': 'text/event-stream' } }));

  const handlers = new Map<string, (event: any, ...args: any[]) => Promise<unknown>>();
  const pushes: { channel: string; payload: any }[] = [];
  const errors: { scope: string; error: unknown }[] = [];
  const opened: string[] = [];
  let destroyed = false, quitting = false;
  const mainFrame = { url: SHELL };
  const webContents = {
    mainFrame, isDestroyed: () => destroyed,
    send: (channel: string, payload: unknown) => { if (channel.startsWith('beings:town')) pushes.push({ channel, payload }); },
  };
  const window = { isDestroyed: () => destroyed, webContents };
  const store = { connection: null as Connection | null, connectionAddress: '' };
  // A working encrypted store: the pairing paths branch on availability, and a
  // fixture that could not encrypt would exercise the failure path by accident.
  const secretStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  };
  const power = new Map<string, () => void>();
  const handle = createTrustedHandle({
    register: (channel, listener) => { handlers.set(channel, listener); },
    window: () => window, shellURL: () => SHELL,
    quitting: () => quitting, recoveryBlocked: () => false,
    report: (_channel, error) => publicErrorMessage(error),
  });
  const extensions = installDesktopExtensions({
    handle, exclusive: operation => operation(),
    window: () => window, store, secretStorage, userData: directory,
    desktopId: '11111111-1111-4111-8111-111111111111', clientVersion: '0.9.0', fetchImpl,
    onError: (scope, error) => { errors.push({ scope, error }); },
    electron: {
      net: { fetch: fetchImpl, request: null, isOnline: () => online },
      shell: { openPath: async () => '', openExternal: async (target: string) => { opened.push(target); } },
      powerMonitor: { on: (event: 'suspend' | 'resume', callback: () => void) => { power.set(event, callback); } },
      safeStorage: secretStorage,
    },
  });

  const connect = async (connection: Connection = CONNECTION, value = address) => {
    store.connection = connection;
    store.connectionAddress = value;
    extensions.connectionVerified(connection);
    await extensions.ready;
    await settle();
  };
  const invoke = (channel: string, ...args: unknown[]) =>
    handlers.get(channel)!({ sender: webContents, senderFrame: mainFrame }, ...args);
  /** The renderer's view of the same call: desktop/preload/channels/town.ts turns
   * the envelope back into an Error carrying `code`. */
  const call = async (channel: string, ...args: unknown[]) => {
    const result = await invoke(channel, ...args);
    if (!PLAIN_CHANNELS.has(channel) && isTownErrorEnvelope(result)) throw townErrorFromEnvelope(result);
    return result as any;
  };
  /** The `code` a channel answered with, or `''` when it succeeded. */
  const codeOf = async (channel: string, ...args: unknown[]) => {
    try { await call(channel, ...args); return ''; }
    catch (error) { return String((error as { code?: unknown }).code ?? ''); }
  };
  /** Pair the client the way the renderer does, with Town confirming the code. */
  const pair = async (code = 'K7M2N4') => {
    // `display`, not `display_name`: the confirm response's own field name
    // (desktop/main/town/session/client.ts `pair`).
    on('/api/client/pair/confirm', () => json({ ok: true, token: CLIENT_TOKEN, town_id: 't_Willow', display: '柳树' }));
    const state = await call('beings:town-client-pair', { code });
    await settle();
    return state;
  };

  return {
    extensions, handlers, pushes, errors, calls, opened, on, always, connect, call, invoke,
    codeOf, pair, directory, store, power,
    destroy: () => { destroyed = true; },
    quit: () => { quitting = true; },
    untrusted: (channel: string, ...args: unknown[]) =>
      handlers.get(channel)!({ sender: {}, senderFrame: { url: 'https://elsewhere.example/' } }, ...args),
    cleanup: async () => { await extensions.quitting(); await rm(directory, { recursive: true, force: true }); },
  };
}

export type TownFixture = Awaited<ReturnType<typeof townFixture>>;
