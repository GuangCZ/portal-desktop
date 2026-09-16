// The one conversion in the tool subsystem that only a real relay would expose;
// 2026-09-16.
//
// `DesktopToolLink.connect(connection)` was written against BeingDesktop's
// `LoomConnection` — `{url, apiBase, token, secret, displayUrl, beingName}`. The
// portal-desktop shell's `SubsystemContext.store.connection` is a different type
// with a different vocabulary: `{endpoint, being, token, relaySecret, link}`.
// `DesktopToolsOptions.getConnection` is declared `() => unknown`, so handing the
// wrong one past typecheck and past every unit test is not only possible, it is
// the obvious thing to write. What it produces is a WebSocket URL built from
// `undefined` and an empty `loom_token`, and the first place anyone sees that is
// a real relay refusing the handshake.
//
// So this file drives the actual link through the actual subsystem, with a fake
// socket standing in for `ws`, and reads the handshake frame back. The two address
// shapes are the two the client accepts: `?token=` alone, and `?api=` plus
// `?relay_secret=` (integration plan §3.2「类型对齐」).
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installToolsSubsystem } from "../desktop/main/subsystems/tools";
import { DesktopToolLink, type ToolSocketFactory } from "../desktop/main/tools/tool-link";
import { desktopPortalName } from "../desktop/main/app/identity";
import { parseConnection } from "../desktop/main/common/loom-connection";
import type { Connection } from "../desktop/main/chat/connection";
import type {
  DesktopSubsystem, SubsystemContext, SubsystemMap, SubsystemRegistry,
} from "../desktop/main/subsystems/types";
import type { Settings } from "../desktop/shared/types";

const DESKTOP_ID = "11111111-1111-4111-8111-111111111111";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** The `ws` surface `DesktopToolLink` drives, as a class rather than an object
 * literal: production injects `ws`'s own class through `WebSocketImpl`, and a
 * test double of a different shape is how a `new`-time difference hides. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  closed = false;
  listeners = new Map<string, ((event: any) => void)[]>();
  constructor(readonly url: string) { FakeSocket.instances.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; this.emit("close", {}); }
  addEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
  }
  emit(type: string, event: unknown) { for (const listener of this.listeners.get(type) || []) listener(event); }
  /** The relay's side of a successful handshake. */
  accept(beingId: string) {
    this.emit("open", {});
    this.emit("message", { data: JSON.stringify({ ok: true, being_id: beingId, relay_keepalive: "text-v1" }) });
  }
  /** What the client sent as its first frame. */
  get handshake() { return JSON.parse(this.sent[0]) as { being_id: string; loom_token: string; portal_name: string }; }
}

/** The three electron touchpoints `DesktopBrowser` validates at construction.
 *
 * They are here because `DesktopTools` builds the browser, the console and the
 * link in ONE constructor: a browser that refuses its dependencies takes the link
 * down with it, and the link is this file's subject. Production always has real
 * ones, so a fixture without them would be testing a state the client is never
 * in. Classes, not object literals, for the same reason the socket is one. */
class FakeView {
  visible = false;
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  webContents = {
    navigationHistory: { canGoBack: () => false, canGoForward: () => false, goBack: () => {}, goForward: () => {} },
    on: () => {}, removeListener: () => {}, setWindowOpenHandler: () => {},
    loadURL: () => {}, getURL: () => "", isLoading: () => false, isDestroyed: () => false,
    reload: () => {}, stop: () => {}, close: () => {},
    capturePage: async () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), resize() { return this; }, toPNG: () => Buffer.alloc(0) }),
    executeJavaScriptInIsolatedWorld: async () => ({}),
  };
  setBounds(bounds: { x: number; y: number; width: number; height: number }) { this.bounds = bounds; }
  getBounds() { return this.bounds; }
  setVisible(visible: boolean) { this.visible = visible; }
  setBackgroundColor() {}
}
class FakeSession {
  static partitions: string[] = [];
  webRequest = { onBeforeRequest: () => {} };
  setPermissionRequestHandler() {}
  setPermissionCheckHandler() {}
  setDevicePermissionHandler() {}
  on() { return this; }
  removeListener() { return this; }
}
const electronBrowser = () => ({
  WebContentsView: FakeView,
  session: { fromPartition: (partition: string) => { FakeSession.partitions.push(partition); return new FakeSession(); } },
});

/** A `SubsystemContext` with nothing in it but what this unit reads. */
async function fixture(connectionAddress: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "beings-tools-connection-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const pushes: { channel: string; payload: unknown }[] = [];
  const errors: { scope: string; error: unknown }[] = [];
  const built = new Map<string, DesktopSubsystem>();
  const registry: SubsystemRegistry = {
    get: <K extends keyof SubsystemMap>(key: K) => (built.get(key as string) as SubsystemMap[K] | undefined) ?? null,
    require: <K extends keyof SubsystemMap>(key: K) => {
      const value = built.get(key as string);
      if (!value) throw new Error(`子系统 ${String(key)} 未安装。`);
      return value as SubsystemMap[K];
    },
  };
  const context = {
    handle: (channel: string, callback: (...args: any[]) => unknown) => { handlers.set(channel, callback); },
    exclusive: <T>(operation: () => Promise<T>) => operation(),
    window: () => null,
    store: {
      connection: null as Connection | null,
      connectionAddress,
      settings: { workspace: "", projectWorkspace: "" } as unknown as Settings,
      extras: {},
      saveExtra: async () => {},
    },
    electron: {
      ...electronBrowser(),
      net: { fetch, request: null, isOnline: () => true },
      clipboard: { readText: async () => "", writeText: async () => {} },
      shell: { openPath: async () => "", openExternal: async () => {} },
      safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() },
    },
    userData: directory,
    desktopId: DESKTOP_ID,
    clientVersion: "0.9.0",
    fetchImpl: fetch,
    onError: (scope: string, error: unknown) => { errors.push({ scope, error }); },
    registry,
    push: (channel: string, payload: unknown) => { pushes.push({ channel, payload }); },
  } as unknown as SubsystemContext;
  const subsystem = installToolsSubsystem(context);
  built.set(subsystem.key as string, subsystem as unknown as DesktopSubsystem);
  cleanups.push(() => subsystem.quitting?.());
  return { subsystem, handlers, pushes, errors, context };
}

/** The real `DesktopToolLink`, with the real `connect`, and only the transport
 * faked. `DesktopTools` builds its own link and offers no way to substitute the
 * socket, so the link is built here and handed exactly what the subsystem's
 * `getConnection` answered — which is the seam this file exists to pin. */
async function handshake(connection: unknown) {
  FakeSocket.instances.length = 0;
  const link = new DesktopToolLink({
    invokeTool: async () => ({ content: [{ type: "text", text: "{}" }], isError: false }),
    portalName: desktopPortalName(DESKTOP_ID),
    WebSocketImpl: FakeSocket as unknown as ToolSocketFactory,
  });
  cleanups.push(() => { link.dispose(); });
  const connecting = link.connect(connection);
  const socket = FakeSocket.instances.at(-1);
  if (!socket) { await connecting; throw new Error("the link opened no socket"); }
  socket.accept(new URL(String((connection as { url: string }).url)).pathname.split("/").filter(Boolean)[0]);
  await connecting;
  return { socket, link };
}

/** What the shell would have handed the link if nobody had converted: the saved
 * profile's own `Connection`, whose fields the link has never heard of. */
const shellConnection = (address: string): Connection => ({
  endpoint: new URL(address).origin,
  being: "agatha",
  token: "secret-token",
  relaySecret: "secret-token",
  link: address,
});

describe("the tool subsystem's Loom connection", () => {
  it("hands the link BeingDesktop's parsed connection, not the shell's own Connection", async () => {
    const address = "https://loom.example.test/agatha?token=secret-token";
    const f = await fixture(address);
    const connection = f.subsystem.tools!.getConnection();
    // Every field the link reads, and the two names it would have found on a
    // portal-desktop `Connection` instead (`endpoint`, `relaySecret`).
    expect(connection).toEqual({
      url: "https://loom.example.test/agatha?token=secret-token",
      apiBase: "https://loom.example.test/agatha",
      token: "secret-token",
      secret: "secret-token",
      displayUrl: "https://loom.example.test/agatha",
      beingName: "agatha",
    });
    expect(connection).not.toHaveProperty("endpoint");
    expect(connection).not.toHaveProperty("relaySecret");
  });

  it("reaches the relay at the Loom's own origin, with the Being id and token from the address", async () => {
    const address = "https://loom.example.test/agatha?token=secret-token";
    const f = await fixture(address);
    const { socket } = await handshake(f.subsystem.tools!.getConnection());
    expect(socket.url).toBe("wss://loom.example.test/_relay");
    expect(socket.handshake).toEqual({
      being_id: "agatha",
      loom_token: "secret-token",
      portal_name: `being-desktop-tools-${DESKTOP_ID}`,
    });
  });

  it("keeps `relay_secret` out of the handshake and still uses the `api=` address's origin", async () => {
    // `api=` moves the API base; the relay stays on the Loom's own origin, and
    // `relay_secret` is the cache identity's, never the link's.
    const address = "https://loom.example.test/agatha?token=secret-token&api=https://loom.example.test/api&relay_secret=a-different-secret";
    const f = await fixture(address);
    const { socket } = await handshake(f.subsystem.tools!.getConnection());
    expect(socket.url).toBe("wss://loom.example.test/_relay");
    expect(socket.handshake.loom_token).toBe("secret-token");
    expect(Object.keys(socket.handshake).sort()).toEqual(["being_id", "loom_token", "portal_name"]);
    // …while the parsed connection did pick the relay secret up, which is what
    // makes it the wrong thing to confuse with the token.
    expect(parseConnection(
      "https://loom.example.test/agatha?token=secret-token&api=https://loom.example.test/api&relay_secret=a-different-secret",
    ).secret).toBe("a-different-secret");
  });

  it("speaks ws, not wss, to a loopback Being", async () => {
    const f = await fixture("http://127.0.0.1:8899/agatha?token=secret-token");
    const { socket } = await handshake(f.subsystem.tools!.getConnection());
    expect(socket.url).toBe("ws://127.0.0.1:8899/_relay");
  });

  // THE CASE THIS FILE IS FOR. Hand the link the shell's own `Connection` — the
  // value `getConnection` would return if the conversion were dropped — and it
  // refuses before opening a socket, because it finds neither a `url` to parse
  // nor a `token` to send. The refusal is the good outcome; without the
  // conversion, production would reach this same code with this same value.
  it("refuses the shell's own Connection outright, rather than dialling a wrong relay", async () => {
    const address = "https://loom.example.test/agatha?token=secret-token";
    // Measured, not assumed: the refusal comes from `connect`'s own identity
    // check, because `Connection.link` happens to be a parseable Loom address
    // while `Connection.url` is undefined — so the link gets as far as looking
    // for a Being id and a token and finds neither.
    await expect(handshake(shellConnection(address))).rejects.toThrow("Loom 连接缺少有效的 Being 身份或令牌。");
    expect(FakeSocket.instances).toEqual([]);
  });

  it("advertises the Desktop's own Portal name on the link the subsystem built", async () => {
    const f = await fixture("https://loom.example.test/agatha?token=secret-token");
    expect(f.subsystem.tools!.link.capabilities().place).toBe(`being-desktop-tools-${DESKTOP_ID}`);
  });

  it("answers null while no Being is saved, so connecting refuses instead of dialling nowhere", async () => {
    const f = await fixture("");
    expect(f.subsystem.tools!.getConnection()).toBe(null);
    await expect(f.subsystem.tools!.perform("link.connect")).rejects.toThrow("请先连接 Being。");
    expect(FakeSocket.instances.filter(socket => socket.url.includes("undefined"))).toEqual([]);
  });

  it("answers null for an address it cannot parse, and reports why", async () => {
    // An address that reached the store from an older profile: HTTP, not
    // loopback. The link must not be handed a half-built object.
    const f = await fixture("http://loom.example.test/agatha?token=secret-token");
    expect(f.subsystem.tools!.getConnection()).toBe(null);
    expect(f.errors.map(entry => entry.scope)).toContain("tools-connection");
  });
});
