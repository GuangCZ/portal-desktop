// 模型配置 and Side by Side, as channels, against a fake Being.
// New in the portal-desktop shell on 2026-09-16 (integration unit I6b); the
// behaviour under test is BeingDesktop 0.8.26's — `getModelConfig` /
// `saveModelConfig` (src/main.cjs lines 1231-1236), `publishModelConfig` (line
// 363) and the epoch rules of docs/interfaces.md §1「纪元字段」.
//
// It installs the real subsystem through the real trusted-sender wrapper with a
// real `SettingsStore` over a temporary profile, because three of the claims
// worth testing are about things a stub would assert nothing about: the channels
// are registered on the wrapper production uses, the epoch follows the SAVED
// address, and the API key never reaches the profile on disk.
//
// Only this subsystem is installed (`installSubsystems(ctx, [installer])`), per
// the registry's own contract: it needs no peer, and `installDesktopExtensions`
// would drag in the tool browser and terminal, whose electron bindings this
// fixture does not fake.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createTrustedHandle } from "../desktop/main/app/ipc";
import { SettingsStore } from "../desktop/main/app/settings";
import { installSubsystems } from "../desktop/main/extensions";
import { installModelSettingsSubsystem } from "../desktop/main/subsystems/model-settings";
import { isChatErrorEnvelope } from "../desktop/shared/chat-errors";
import { publicErrorMessage } from "../desktop/shared/errors";
import type { ModelConfigDto, ModelSettingsState } from "../desktop/shared/model-settings-types";

const DESKTOP = "11111111-1111-4111-8111-111111111111";
const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);
/** The relay secret is `private-relay` in both: several assertions below check
 * that no answer, push or error text ever contains the word `private`. */
const ADDRESS_A = `https://echo.beings.town/cz_being/?token=${TOKEN_A}&relay_secret=private-relay`;
const ADDRESS_B = `https://echo.beings.town/other_being/?token=${TOKEN_B}&relay_secret=private-relay`;
const SHELL = "beings://desktop/";
const CHANNELS = ["beings:model-config-get", "beings:model-config-save", "beings:sbs-set"];
const SECRET = "sk-private-typed-by-the-user";

const json = (value: unknown, status = 200) =>
  new Response(value === null ? null : JSON.stringify(value), { status, headers: value === null ? {} : { "Content-Type": "application/json" } });
const settle = async () => { for (let index = 0; index < 25; index++) await new Promise(resolve => setImmediate(resolve)); };
const secretStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value),
  decryptString: (value: Buffer) => value.toString(),
};
const credential = (address: string) => Buffer.from(address).toString("base64");

/** What the fake Being holds. `api_key` and `base_url`'s credentials are here so
 * that every assertion about redaction has something real to redact. */
const beingConfig = () => ({
  model: "model-current", provider: "openai-responses",
  base_url: "https://user:private@upstream.example/v1?credential=private",
  has_api_key: true, api_key: "private-upstream-key", thinking: "high", temperature: 0.7, sbs_enabled: false,
  presets: [{ id: "preset-a", label: "Model A", model: "model-a", provider: "openai-responses", has_key: true },
    { id: "preset-b", label: "Model B", model: "model-b", provider: "self-hosted", has_key: false }],
});

async function fixture({ address = ADDRESS_A }: { address?: string } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "model-settings-test-"));
  await writeFile(path.join(directory, "settings.json"), JSON.stringify({ credential: credential(address) }));

  let saved: Record<string, unknown> = beingConfig();
  const patches: Record<string, unknown>[] = [];
  /** Set to make the next GET fail, the way a Being that is briefly unwell does. */
  let readStatus = 200;
  let dropSbs = false;
  const fetchImpl = (async (url: string, options: RequestInit = {}) => {
    const route = new URL(url).pathname.replace(/^\/[a-z_]+/, "");
    if (route !== "/api/llm/config") throw new Error(`no route: ${route}`);
    if (options.method === "PATCH") {
      const patch = JSON.parse(String(options.body));
      patches.push(patch);
      // Loom's own semantics: `sbs_enabled` arrives as the string 'on'/'off' and
      // is stored as a boolean (docs/migration/i6b-model-settings.md §1.7).
      const { sbs_enabled, ...rest } = patch;
      saved = { ...saved, ...rest, ...(sbs_enabled === undefined ? {} : { sbs_enabled: sbs_enabled === "on" }) };
      if (patch.api_key) saved.has_api_key = true;
      return json({ ok: true, config: saved });
    }
    if (readStatus !== 200) return json({ error: "private-detail" }, readStatus);
    const answer: Record<string, unknown> = { ...saved };
    if (dropSbs) delete answer.sbs_enabled;
    return json(answer);
  }) as unknown as typeof fetch;

  const handlers = new Map<string, (event: any, ...args: any[]) => Promise<unknown>>();
  const pushes: { channel: string; payload: any }[] = [];
  const errors: { scope: string; error: unknown }[] = [];
  const mainFrame = { url: SHELL };
  const webContents = { mainFrame, isDestroyed: () => false, send: (channel: string, payload: unknown) => { pushes.push({ channel, payload }); } };
  const window = { isDestroyed: () => false, webContents };
  // Production's own queue shape: one operation at a time, in order.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T,>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation, operation);
    queue = next.catch(() => {});
    return next;
  };
  const store = new SettingsStore(directory, secretStorage, "/nonexistent/portal");
  await store.load();
  const handle = createTrustedHandle({
    register: (channel, listener) => { handlers.set(channel, listener); },
    window: () => window, shellURL: () => SHELL,
    quitting: () => false, recoveryBlocked: () => false,
    report: (_channel, error) => publicErrorMessage(error),
  });
  const extensions = installSubsystems({
    handle, exclusive, window: () => window, store, secretStorage, userData: directory,
    desktopId: DESKTOP, clientVersion: "0.9.0", fetchImpl,
    onError: (scope, error) => { errors.push({ scope, error }); },
  }, [installModelSettingsSubsystem]);

  const call = (channel: string, ...args: unknown[]) =>
    handlers.get(channel)!({ sender: webContents, senderFrame: mainFrame }, ...args) as Promise<any>;
  /** The enveloped channels answer with data, so unwrap the way the preload does. */
  const invoke = async (channel: string, ...args: unknown[]) => {
    const result = await call(channel, ...args);
    if (isChatErrorEnvelope(result)) throw Object.assign(new Error(result.message), { code: result.code });
    return result;
  };
  const failure = async (channel: string, ...args: unknown[]) => {
    const result = await call(channel, ...args);
    expect(isChatErrorEnvelope(result)).toBe(true);
    return result as { code: string; message: string };
  };
  const connect = async () => {
    extensions.connectionVerified(store.connection);
    await extensions.ready.catch(() => {});
    await settle();
  };
  return {
    directory, store, extensions, handlers, pushes, errors, patches, call, invoke, failure, connect,
    /** Bind a different Being the way `beings:save` does: the credential on disk
     * changes and the store re-reads it, so `connectionAddress` — which is what
     * the epoch is computed from — becomes the new one. */
    rebind: async (next: string) => {
      await writeFile(path.join(directory, "settings.json"), JSON.stringify({ credential: credential(next) }));
      await store.load();
    },
    state: () => pushes.filter(push => push.channel === "beings:model-settings-state").at(-1)?.payload as ModelSettingsState,
    states: () => pushes.filter(push => push.channel === "beings:model-settings-state").map(push => push.payload as ModelSettingsState),
    read: () => call("beings:model-config-get") as Promise<ModelConfigDto>,
    setReadStatus: (value: number) => { readStatus = value; },
    setDropSbs: (value: boolean) => { dropSbs = value; },
    savedConfig: () => saved,
    profile: async () => await readFile(path.join(directory, "settings.json"), "utf8"),
    untrusted: (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: {}, senderFrame: { url: "https://elsewhere.example/" } }, ...args),
    cleanup: async () => { await extensions.quitting(); await rm(directory, { recursive: true, force: true }); },
  };
}

test("the three channels register, refuse an untrusted sender, and publish the first read", async () => {
  const f = await fixture();
  try {
    expect(CHANNELS.every(channel => f.handlers.has(channel))).toBe(true);
    await expect(f.untrusted("beings:model-config-get")).rejects.toThrow(/Untrusted/);
    // Nothing has been read yet: the page would say so rather than show a model.
    expect(f.state()).toBe(undefined);
    await f.connect();
    // Binding a Being reads `/api/llm/config` once, unasked, so the settings page
    // and the runtime line are populated before either is opened.
    const state = f.state();
    expect(state.connected).toBe(true);
    expect(state.connectionId).toBe(1);
    expect(state.runtime.configStatus).toBe("connected");
    expect(state.runtime.model).toBe("model-current");
    expect(state.runtime.sideBySide.configured).toBe(false);
    // Unknown, not false: this client has no source for it (runtime.ts).
    expect(state.runtime.sideBySide.active).toBe(null);
    // Redacted on the way out — the Being's own address carries credentials.
    expect(state.runtime.baseUrl).toBe("https://upstream.example/v1");
    expect(JSON.stringify(f.pushes)).not.toMatch(/private/);
    expect(f.errors).toEqual([]);
  } finally { await f.cleanup(); }
});

test("the read answers the redacted catalogue and the provider table Loom mirrors", async () => {
  const f = await fixture();
  try {
    await f.connect();
    const dto = await f.read();
    expect(dto.connectionId).toBe(1);
    expect(dto.config.model).toBe("model-current");
    expect(dto.config.hasApiKey).toBe(true);
    expect(dto.models.map(model => model.id)).toEqual(["model-a", "model-b"]);
    // The table is PROVIDERS, not just what the Being listed: a user may switch
    // to a provider that has no preset yet.
    expect(dto.providers.map(provider => provider.id)).toContain("anthropic");
    expect(dto.providers.find(provider => provider.id === "self-hosted")?.keyless).toBe(true);
    expect(JSON.stringify(dto)).not.toMatch(/private|api_key/);
    expect(f.errors).toEqual([]);
  } finally { await f.cleanup(); }
});

test("a save PATCHes, re-reads to confirm, and republishes the runtime line", async () => {
  const f = await fixture();
  try {
    await f.connect();
    const before = f.states().length;
    const dto = await f.invoke("beings:model-config-save", {
      connectionId: 1, model: "model-b", provider: "self-hosted", baseUrl: "http://10.0.0.2:7860/v1", apiKey: SECRET,
    });
    expect(dto.config.model).toBe("model-b");
    expect(dto.config.provider).toBe("self-hosted");
    // The key was forwarded once, in the clear, to the Being — and nowhere else.
    expect(f.patches).toEqual([{ model: "model-b", provider: "self-hosted", base_url: "http://10.0.0.2:7860/v1", api_key: SECRET }]);
    expect(f.savedConfig().has_api_key).toBe(true);
    const state = f.states().at(-1)!;
    expect(state.runtime.model).toBe("model-b");
    expect(f.states().length).toBeGreaterThan(before);
    expect(f.errors).toEqual([]);
  } finally { await f.cleanup(); }
});

test("the API key reaches the Being and nothing else — not the profile, not a push, not a log", async () => {
  const f = await fixture();
  try {
    await f.connect();
    await f.invoke("beings:model-config-save", { connectionId: 1, model: "model-a", provider: "openai-responses", apiKey: SECRET });
    // The three places a credential could linger. `hasApiKey` is the whole of
    // what the renderer learns about it.
    expect(await f.profile()).not.toContain(SECRET);
    expect(JSON.stringify(f.pushes)).not.toContain(SECRET);
    expect(JSON.stringify(f.errors)).not.toContain(SECRET);
    const dto = await f.read();
    expect(JSON.stringify(dto)).not.toContain(SECRET);
    expect(dto.config.hasApiKey).toBe(true);

    // And when the write fails, the message the user is shown carries neither the
    // key nor anything the Being said about it.
    f.setReadStatus(500);
    const envelope = await f.failure("beings:model-config-save", {
      connectionId: 1, model: "model-a", provider: "openai-responses", apiKey: SECRET,
    });
    expect(envelope.message).not.toContain(SECRET);
    expect(envelope.message).not.toMatch(/private/);
    expect(JSON.stringify(f.errors)).not.toContain(SECRET);
  } finally { await f.cleanup(); }
});

test("the writes are enveloped so the page can tell a missing key from an unknown result", async () => {
  const f = await fixture();
  try {
    await f.connect();
    // A patch the validator refuses never reaches the Being.
    const invalid = await f.failure("beings:model-config-save", { connectionId: 1, model: "model-a", provider: "bad/provider" });
    expect(invalid.code).toBe("INVALID_REQUEST");
    expect(f.patches).toEqual([]);
    // An unknown field is refused rather than dropped.
    expect((await f.failure("beings:model-config-save", { connectionId: 1, model: "m", provider: "p", rollback: true })).code).toBe("INVALID_REQUEST");
    // A form composed against a Being that is no longer bound is refused with a
    // code of its own, not applied to whoever is connected now.
    expect((await f.failure("beings:model-config-save", { connectionId: 99, model: "model-a", provider: "openai-responses" })).code).toBe("SESSION_CHANGED");
    // A PATCH whose result cannot be confirmed says so: the user must re-read.
    f.setReadStatus(503);
    const unknown = await f.failure("beings:model-config-save", { connectionId: 1, model: "model-a", provider: "openai-responses" });
    expect(unknown.code).toBe("RESULT_UNKNOWN");
    expect(unknown.message).toMatch(/尚未确认/);
  } finally { await f.cleanup(); }
});

test("Side by Side writes Loom's own shape and the display follows the Being's echo", async () => {
  const f = await fixture();
  try {
    await f.connect();
    expect(f.state().runtime.sideBySide.configured).toBe(false);
    const dto = await f.invoke("beings:sbs-set", true, 1);
    expect(f.patches).toEqual([{ sbs_enabled: "on" }]);
    expect(dto.config.sbsEnabled).toBe(true);
    expect(f.state().runtime.sideBySide.configured).toBe(true);
    await f.invoke("beings:sbs-set", false, 1);
    expect(f.patches.at(-1)).toEqual({ sbs_enabled: "off" });
    expect(f.state().runtime.sideBySide.configured).toBe(false);
    // Neither argument is trusted, and a refused one sends nothing.
    const before = f.patches.length;
    expect((await f.failure("beings:sbs-set", "on", 1)).code).toBe("INVALID_REQUEST");
    expect((await f.failure("beings:sbs-set", true, 99)).code).toBe("SESSION_CHANGED");
    expect(f.patches.length).toBe(before);
    expect(f.errors).toEqual([]);
  } finally { await f.cleanup(); }
});

test("a read that does not come back puts Side by Side back to unknown, and a refresh recovers it", async () => {
  const f = await fixture();
  try {
    await f.connect();
    await f.invoke("beings:sbs-set", true, 1);
    expect(f.state().runtime.sideBySide.configured).toBe(true);

    // 503: the values on screen are no longer claimed. This is the rule
    // tests/sbs-refresh.mjs pins, and the reason the subsystem records a failed
    // read itself rather than waiting for a poll it does not have.
    f.setReadStatus(503);
    await expect(f.read()).rejects.toThrow();
    expect(f.state().runtime.configStatus).toBe("error");
    expect(f.state().runtime.sideBySide.configured).toBe(null);
    expect(f.state().runtime.model).toBe("");

    // A Being that answers without the field at all is also unknown, not off.
    f.setReadStatus(200);
    f.setDropSbs(true);
    await f.read();
    expect(f.state().runtime.configStatus).toBe("connected");
    expect(f.state().runtime.sideBySide.configured).toBe(null);
    expect(f.state().runtime.model).toBe("model-current");

    // And a good read restores it.
    f.setDropSbs(false);
    await f.read();
    expect(f.state().runtime.sideBySide.configured).toBe(true);
  } finally { await f.cleanup(); }
});

test("the epoch follows the Being's identity, not the number of verifications", async () => {
  const f = await fixture();
  try {
    await f.connect();
    expect(f.state().connectionId).toBe(1);
    // DEVIATION from 0.8.26, deliberate: its `generation` increments on every
    // `verifyConnection`, which invalidates a form the user is holding. Here
    // re-verifying the same Being is not a change at all.
    await f.connect();
    await f.connect();
    expect(f.state().connectionId).toBe(1);
    expect((await f.read()).connectionId).toBe(1);

    // A different Being is a different epoch, a cleared form and a fresh read.
    await f.rebind(ADDRESS_B);
    await f.connect();
    expect(f.state().connectionId).toBe(2);
    expect(f.state().connected).toBe(true);
    // The form the user was holding for the previous Being is refused.
    expect((await f.failure("beings:model-config-save", { connectionId: 1, model: "model-a", provider: "openai-responses" })).code).toBe("SESSION_CHANGED");
    expect(f.errors).toEqual([]);
  } finally { await f.cleanup(); }
});

test("clearing the connection empties the line and refuses everything that follows", async () => {
  const f = await fixture();
  try {
    await f.connect();
    expect(f.state().runtime.model).toBe("model-current");
    await f.extensions.connectionCleared();
    const state = f.state();
    expect(state.connected).toBe(false);
    expect(state.connectionId).toBe(2);
    expect(state.runtime.model).toBe("");
    expect(state.runtime.sideBySide.configured).toBe(null);
    await expect(f.read()).rejects.toThrow(/请先配置 Being 连接。/);
    expect((await f.failure("beings:sbs-set", true, 2)).code).toBe("NOT_CONNECTED");
    expect(f.errors).toEqual([]);
  } finally { await f.cleanup(); }
});
