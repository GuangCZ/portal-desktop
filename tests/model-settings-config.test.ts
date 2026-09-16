// `/api/llm/config`, read and written. Ported test for test from BeingDesktop
// 0.8.26 test/model-config.test.cjs (13 tests); 2026-09-16 (integration unit
// I6b), with three added for the Side by Side write this shell introduces
// (integration plan §5.3) and one for the failure half of the runtime line.
//
// The fixture is 0.8.26's: a real `parseConnection` of an address carrying a
// token and a relay secret, a recorded fetch, and a context the test can move
// under the service — which is the only way to exercise the epoch rules, since
// they are all about a reply arriving after the Being changed.
//
// The word `private` appears in every credential in this file on purpose. Several
// assertions are `expect(JSON.stringify(result)).not.toMatch(/private/)`: they
// pass only if nothing the Being said about its own key, its upstream key or its
// URL credentials reached the renderer-facing value.
import { expect, test } from "vitest";
import { ModelConfig, modelConfigDto, validateModelPatch } from "../desktop/main/model-settings/config";
import { parseConnection } from "../desktop/main/common/loom-connection";
import { emptyRuntime, failRuntimeConfig, modelRuntimeState, updateRuntimeConfig } from "../desktop/main/model-settings/runtime";
import type { ModelPatchInput } from "../desktop/shared/model-settings-types";

const config: Record<string, unknown> = {
  model: "model-current", provider: "openai-responses", base_url: "https://api.example.test/v1", has_api_key: true,
  api_key: "private-upstream-key", thinking: "high", temperature: 0.7, sbs_enabled: true,
  presets: [{ id: "preset-a", label: "Model A", model: "model-a", provider: "openai-responses", has_key: true },
    { id: "preset-b", label: "Model B", model: "model-b", provider: "anthropic", has_key: false }],
};
const presets = config.presets as Record<string, unknown>[];
const input: ModelPatchInput = { connectionId: 7, model: "model-a", provider: "openai-responses", baseUrl: "https://api.example.test/v1" };
const ADDRESS = "https://being.example.test/loom/?api=https://being.example.test/heart&token=private-loom-token&relay_secret=private-relay";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

type Recorded = { url: string } & RequestInit;
function fixture(fetchImpl?: (url: string, options: RequestInit) => Response | Promise<Response>) {
  let context = { connection: parseConnection(ADDRESS), connectionId: 7, exiting: false };
  const requests: Recorded[] = [];
  const service = new ModelConfig({
    getContext: () => context,
    fetchImpl: (async (url: string, options: RequestInit) => {
      requests.push({ url, ...options });
      return fetchImpl ? fetchImpl(url, options) : json(config);
    }) as unknown as typeof fetch,
  });
  return { service, requests, changeContext: (value: Partial<typeof context>) => { context = { ...context, ...value }; } };
}
const headerOf = (request: Recorded, name: string) => (request.headers as Record<string, string>)[name];
const bodyOf = (request: Recorded) => JSON.parse(String(request.body));
const code = (error: unknown) => (error as { code?: string }).code;
/** `expect(...).rejects` loses the custom field, so assert on the caught value. */
async function rejection(promise: Promise<unknown>): Promise<Error & { code?: string }> {
  try { await promise; } catch (error) { return error as Error & { code?: string }; }
  throw new Error("expected a rejection");
}

test("configuration exposes only display fields and the runtime preset catalog", () => {
  const result = modelConfigDto({ ...config, base_url: "https://user:private@example.test/v1?token=private#private",
    presets: [...presets, presets[0], null, { model: "" }] }, 7, "now");
  expect(result.connectionId).toBe(7);
  expect(result.config.baseUrl).toBe("https://example.test/v1");
  expect(result.config.hasApiKey).toBe(true);
  expect(result.models.length).toBe(2);
  expect(result.models[0]).toEqual({ id: "model-a", presetId: "preset-a", name: "Model A", provider: "openai-responses", hasApiKey: true, baseUrl: "" });
  expect(result.models[1].hasApiKey).toBe(false);
  expect(result.providers.find(provider => provider.id === "anthropic")?.baseUrl).toBe("https://api.anthropic.com");
  expect(JSON.stringify(result)).not.toMatch(/private|api_key|token=/);
  expect(modelConfigDto({ ...config, presets: undefined }, 7).models).toEqual([]);
  expect(modelConfigDto({ ...config, presets: undefined }, 7).modelsError).toMatch(/自定义模型/);
  expect(modelConfigDto({ ...config, provider: "custom-provider" }, 7).providers[0].id).toBe("custom-provider");
  expect(result.providers.filter(provider => provider.keyless !== false).map(provider => provider.id)).toEqual(["self-hosted"]);
});

test("self-hosted presets mirror Loom: a keyless provider with a default address that a preset address overrides", () => {
  const selfHosted = { id: "self-hosted-glm", label: "GLM 5.3 Flash", model: "glm-5.3-flash", provider: "self-hosted" };
  const result = modelConfigDto({ ...config, presets: [...presets, selfHosted] }, 7, "now");
  expect(result.models[2]).toEqual({ id: "glm-5.3-flash", presetId: "self-hosted-glm", name: "GLM 5.3 Flash", provider: "self-hosted", hasApiKey: null, baseUrl: "" });
  expect(result.providers.find(provider => provider.id === "self-hosted"))
    .toEqual({ id: "self-hosted", name: "自部署", baseUrl: "http://115.190.110.33:7860/v1", keyless: true });
  expect(result.providers.find(provider => provider.id === "glm"))
    .toEqual({ id: "glm", name: "GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", keyless: false });
  expect(result.providers.find(provider => provider.id === "openai")?.baseUrl).toBe("https://api.openai.com/v1");
  const explicit = modelConfigDto({ ...config, presets: [{ ...selfHosted, base_url: "http://10.0.0.2:7860/v1?key=private" }] }, 7, "now");
  expect(explicit.models[0].baseUrl).toBe("http://10.0.0.2:7860/v1");
  expect(JSON.stringify(explicit)).not.toMatch(/private/);
  expect(validateModelPatch({ connectionId: 7, model: "glm-5.3-flash", provider: "self-hosted", baseUrl: "http://115.190.110.33:7860/v1" }))
    .toEqual({ model: "glm-5.3-flash", provider: "self-hosted", base_url: "http://115.190.110.33:7860/v1" });
});

test("patch accepts custom models, preserves a blank key and rejects hidden write fields", () => {
  expect(validateModelPatch({ ...input, model: " vendor/custom-v2 ", provider: "custom-provider", apiKey: "  " }))
    .toEqual({ model: "vendor/custom-v2", provider: "custom-provider", base_url: input.baseUrl });
  expect(validateModelPatch({ ...input, baseUrl: "", apiKey: " new-private-key " }))
    .toEqual({ model: input.model, provider: input.provider, api_key: "new-private-key" });
  for (const value of [null, [], { ...input, connectionId: undefined }, { ...input, rollback: true }, { ...input, model: "" },
    { ...input, model: "line\nbreak" }, { ...input, provider: "invalid/provider" }, { ...input, apiKey: "a\nb" },
    { ...input, baseUrl: "file:///C:/secret" }, { ...input, baseUrl: "https://user:key@example.test" },
    { ...input, baseUrl: "https://example.test?api_key=private" }, { ...input, baseUrl: "https://example.test/#secret" }]) {
    expect(() => validateModelPatch(value)).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
  }
  // The accessor gate: an input carrying a getter is refused WITHOUT the getter
  // running, so a compromised renderer cannot learn which fields are read.
  let invoked = false;
  const getter: Record<string, unknown> = { ...input };
  Object.defineProperty(getter, "model", { get: () => { invoked = true; return "unexpected"; }, enumerable: true, configurable: true });
  expect(() => validateModelPatch(getter)).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
  expect(invoked).toBe(false);
});

test("read and save use the confirmed same-origin config route and sanitized verification", async () => {
  let saved = { ...config };
  const { service, requests } = fixture((_url, options) => {
    if (options.method === "PATCH") {
      saved = { ...saved, ...JSON.parse(String(options.body)) };
      return json({ ok: true, config: saved });
    }
    return json(saved);
  });
  const read = await service.get();
  expect(read.models.length).toBe(2);
  const result = await service.save({ ...input, apiKey: "replacement-private-key" });
  expect(result.config.model).toBe("model-a");
  expect(requests.length).toBe(3);
  for (const request of requests) {
    const url = new URL(request.url);
    expect(url.origin).toBe("https://being.example.test");
    expect(url.pathname).toBe("/heart/api/llm/config");
    expect(url.searchParams.get("token")).toBe("private-loom-token");
    expect(headerOf(request, "X-Relay-Secret")).toBe("private-relay");
    expect(request.redirect).toBe("error");
    expect(request.credentials).toBe("omit");
    expect(request.cache).toBe("no-store");
    expect(request.signal).toBe(undefined);
  }
  expect(bodyOf(requests[1])).toEqual({ model: "model-a", provider: "openai-responses", api_key: "replacement-private-key" });
  expect(JSON.stringify(result)).not.toMatch(/private/);
});

test("successful PATCH requires a matching reread and is never automatically retried", async () => {
  for (const observed of [config, { ...config, model: input.model, provider: "different" },
    { ...config, model: input.model, base_url: "https://different.test" }, { ...config, model: input.model, has_api_key: false }]) {
    const { service, requests } = fixture((_url, options) => options.method === "PATCH" ? json({ ok: true }) : json(observed));
    expect(code(await rejection(service.save({ ...input, apiKey: "new-key" })))).toBe("RESULT_UNKNOWN");
    expect(requests.filter(request => request.method === "PATCH").length).toBe(1);
  }
});

test("missing keys, rollbacks and authorization errors remain safe and distinct", async () => {
  for (const [body, status, expected] of [[{ needs_key: true, error: "private-key" }, 400, "NEEDS_KEY"],
    [{ ok: true, rolled_back: true, error: "private-key" }, 200, "ROLLED_BACK"],
    [{ error: "private-key" }, 403, "AUTH_REQUIRED"],
    [{ ok: false, error: "private-key" }, 500, "RESULT_UNKNOWN"]] as [unknown, number, string][]) {
    const { service, requests } = fixture(() => json(body, status));
    const error = await rejection(service.save(input));
    expect(code(error)).toBe(expected);
    expect(error.message).not.toMatch(/private/);
    expect(requests.length).toBe(1);
    expect(service.busy).toBe(false);
  }
});

test("transport exceptions and invalid or oversized bodies never expose credentials", async () => {
  for (const fetchImpl of [
    () => { throw new Error("private-loom-token private-upstream-key"); },
    () => { throw Object.assign(new Error("private-key"), { code: "NETWORK_ERROR" }); },
    () => new Response("private-key", { status: 200 }),
    () => new Response("{}", { headers: { "Content-Length": String(1024 * 1024 + 1) } }),
  ]) {
    const { service } = fixture(fetchImpl as () => Response);
    expect((await rejection(service.get())).message).not.toMatch(/private/);
    expect((await rejection(service.save(input))).message).not.toMatch(/private/);
  }
});

test("stale forms are rejected before writes and disconnected reads are not sent", async () => {
  const { service, requests, changeContext } = fixture();
  changeContext({ connectionId: 8 });
  expect(code(await rejection(service.save(input)))).toBe("SESSION_CHANGED");
  expect(requests.length).toBe(0);
  changeContext({ connection: null as never });
  expect(code(await rejection(service.get()))).toBe("NOT_CONNECTED");
  expect(requests.length).toBe(0);
});

test("responses from a switched Being are discarded for reads and writes", async () => {
  for (const mutation of [false, true]) {
    let resolveResponse: (value: Response) => void = () => {};
    const pending = new Promise<Response>(resolve => { resolveResponse = resolve; });
    const { service, changeContext, requests } = fixture(() => pending);
    const result = mutation ? service.save(input) : service.get();
    changeContext({ connectionId: 8 });
    resolveResponse(json(mutation ? { ok: true } : config));
    expect(code(await rejection(result))).toBe("SESSION_CHANGED");
    expect(requests.length).toBe(1);
  }
});

test("saving rejects concurrent requests and discards older configuration reads", async () => {
  let resolveOld: (value: Response) => void = () => {};
  let resolvePatch: (value: Response) => void = () => {};
  const old = new Promise<Response>(resolve => { resolveOld = resolve; });
  const patch = new Promise<Response>(resolve => { resolvePatch = resolve; });
  let reads = 0;
  const { service } = fixture((_url, options) =>
    options.method === "PATCH" ? patch : (++reads === 1 ? old : json({ ...config, model: input.model })));
  const prior = service.get();
  const saving = service.save(input);
  expect(code(await rejection(service.get()))).toBe("BUSY");
  expect(code(await rejection(service.save(input)))).toBe("BUSY");
  resolvePatch(json({ ok: true }));
  expect((await saving).config.model).toBe(input.model);
  resolveOld(json(config));
  expect(code(await rejection(prior))).toBe("BUSY");
});

test("confirmed model snapshot updates configuration without claiming runtime or stream health", () => {
  const previous = emptyRuntime();
  const next = updateRuntimeConfig(previous, modelConfigDto(config, 7, "now"));
  expect(next.model).toBe(config.model);
  expect(next.configStatus).toBe("connected");
  expect(next.configCheckedAt).toBe("now");
  expect(next.sideBySide.configured).toBe(true);
  expect(next.status).toBe("unknown");
  expect(next.activeStream.active).toBe(null);
  expect(previous.model).toBe("");
});

test("unchanged displayed addresses preserve private URL fields when the model is saved", async () => {
  let saved: Record<string, unknown> = { ...config, base_url: "https://user:private@example.test/v1?credential=private" };
  const { service, requests } = fixture((_url, options) => {
    if (options.method === "PATCH") { saved = { ...saved, ...JSON.parse(String(options.body)) }; return json({ ok: true }); }
    return json(saved);
  });
  const original = await service.get();
  expect(original.config.baseUrl).toBe("https://example.test/v1");
  await service.save({ ...input, baseUrl: original.config.baseUrl });
  expect(bodyOf(requests[1]).base_url).toBe(undefined);
  expect(saved.base_url).toBe("https://user:private@example.test/v1?credential=private");
});

test("a stalled save belongs to its original connection and cannot lock a new Being", async () => {
  let resolveOld: (value: Response) => void = () => {};
  let resolveNew: (value: Response) => void = () => {};
  const old = new Promise<Response>(resolve => { resolveOld = resolve; });
  const next = new Promise<Response>(resolve => { resolveNew = resolve; });
  let mutations = 0;
  const { service, changeContext } = fixture((_url, options) =>
    options.method === "PATCH" ? (++mutations === 1 ? old : next) : json({ ...config, model: input.model }));
  const first = service.save(input);
  changeContext({ connection: parseConnection("https://another.example.test/being"), connectionId: 8 });
  expect(service.busy).toBe(false);
  expect((await service.get()).connectionId).toBe(8);
  const second = service.save({ ...input, connectionId: 8 });
  expect(service.busy).toBe(true);
  resolveOld(json({ ok: true }));
  expect(code(await rejection(first))).toBe("SESSION_CHANGED");
  expect(service.busy).toBe(true);
  resolveNew(json({ ok: true }));
  expect((await second).connectionId).toBe(8);
  expect(service.busy).toBe(false);
});

// ── New in this shell: the Side by Side write (integration plan §5.3) ─────────
//
// Its wire shape was MEASURED, not inferred: Loom 1.8.0's own `toggleSbs` sends
// `{sbs_enabled: 'on'|'off'}` — the STRING, not a boolean — and reads a boolean
// back. See docs/migration/i6b-model-settings.md §1.7.

test("Side by Side is written the way Loom writes it: the string on, a boolean back", async () => {
  let enabled = false;
  const { service, requests } = fixture((_url, options) => {
    if (options.method === "PATCH") {
      enabled = JSON.parse(String(options.body)).sbs_enabled === "on";
      return json({ ok: true, config: { ...config, sbs_enabled: enabled } });
    }
    return json({ ...config, sbs_enabled: enabled });
  });
  const result = await service.setSideBySide(true, 7);
  expect(bodyOf(requests[0])).toEqual({ sbs_enabled: "on" });
  expect(headerOf(requests[0], "Content-Type")).toBe("application/json");
  expect(result.config.sbsEnabled).toBe(true);
  // A PATCH is confirmed by re-reading, exactly as `save` is: two requests, and
  // the value that comes back is the Being's, never the one that was asked for.
  expect(requests.map(request => request.method)).toEqual(["PATCH", "GET"]);
  await service.setSideBySide(false, 7);
  expect(bodyOf(requests[2])).toEqual({ sbs_enabled: "off" });
  expect(enabled).toBe(false);
});

test("a Side by Side change the Being did not apply is RESULT_UNKNOWN, not a flip", async () => {
  // The PATCH reports success but the re-read still says off: the client refuses
  // to claim the change rather than showing what it asked for.
  const ignored = fixture((_url, options) =>
    options.method === "PATCH" ? json({ ok: true, config: config }) : json({ ...config, sbs_enabled: false }));
  expect(code(await rejection(ignored.service.setSideBySide(true, 7)))).toBe("RESULT_UNKNOWN");
  // A Being that stops answering the field at all is unknown, not off.
  const silent = fixture((_url, options) => {
    const { sbs_enabled, ...rest } = config;
    void sbs_enabled;
    return options.method === "PATCH" ? json({ ok: true }) : json(rest);
  });
  expect(code(await rejection(silent.service.setSideBySide(true, 7)))).toBe("RESULT_UNKNOWN");
  // A rolled-back change keeps its own code so the page can say the Being undid it.
  const rolled = fixture(() => json({ ok: true, rolled_back: true, error: "private-key" }, 200));
  const error = await rejection(rolled.service.setSideBySide(true, 7));
  expect(code(error)).toBe("ROLLED_BACK");
  expect(error.message).not.toMatch(/private/);
});

test("Side by Side obeys the same epoch and busy rules as a model save", async () => {
  const stale = fixture();
  expect(code(await rejection(stale.service.setSideBySide(true, 8)))).toBe("SESSION_CHANGED");
  expect(stale.requests.length).toBe(0);
  for (const bad of [[null, 7], [true, -1], [true, 1.5], ["on", 7]] as [unknown, unknown][]) {
    const { service, requests } = fixture();
    expect(code(await rejection(service.setSideBySide(bad[0] as boolean, bad[1] as number)))).toBe("INVALID_REQUEST");
    expect(requests.length).toBe(0);
  }
  // A toggle in flight is a write in flight: reads and saves wait for it.
  let resolvePatch: (value: Response) => void = () => {};
  const patch = new Promise<Response>(resolve => { resolvePatch = resolve; });
  const { service } = fixture((_url, options) => options.method === "PATCH" ? patch : json(config));
  // `config` reads back `sbs_enabled: true`, so this is the toggle that confirms.
  const toggling = service.setSideBySide(true, 7);
  expect(service.busy).toBe(true);
  expect(code(await rejection(service.get()))).toBe("BUSY");
  expect(code(await rejection(service.save(input)))).toBe("BUSY");
  resolvePatch(json({ ok: true }));
  expect((await toggling).config.sbsEnabled).toBe(true);
  expect(service.busy).toBe(false);
});

test("a failed read puts the configuration line back to unknown rather than leaving it stale", () => {
  // The other half of `updateRuntimeConfig`, and the reason tests/sbs-refresh.mjs
  // can assert「503 → 未知，刷新可恢复」: a read that did not come back must not
  // leave a Side by Side state on screen that its own message calls unknown.
  const confirmed = updateRuntimeConfig(emptyRuntime(), modelConfigDto(config, 7, "now"));
  expect(confirmed.sideBySide.configured).toBe(true);
  const failed = failRuntimeConfig(confirmed, "later");
  expect(failed.configStatus).toBe("error");
  expect(failed.configError).toMatch(/当前值未知/);
  expect(failed.configCheckedAt).toBe("later");
  expect(failed.model).toBe("");
  expect(failed.sideBySide.configured).toBe(null);
  // The half that belongs to the conversation layer is untouched by either.
  expect(failed.status).toBe(confirmed.status);
  expect(failed.activeStream).toEqual(confirmed.activeStream);
  // What the push carries is exactly the configuration half.
  expect(Object.keys(modelRuntimeState(failed)).sort())
    .toEqual(["baseUrl", "configCheckedAt", "configError", "configStatus", "model", "provider", "sideBySide"]);
});
