// Ported from BeingDesktop test/town-pairing.test.cjs on 2026-09-16. Fixtures copied verbatim.
import { expect, it } from "vitest";
import { TownPairing } from "../desktop/main/town/channel/pairing-probe";
import type { PairingClient, PairingConnectionContext } from "../desktop/main/town/channel/types";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const tick = () => new Promise((resolve) => setImmediate(resolve));

// The first eight cases of the BeingDesktop file exercise TownClient (src/town-client.cjs),
// which another migration unit ports. Their names are kept so no case is silently dropped.
it.skip("current SDK confirm response persists Town ID and display without requiring removed being_id", () => {});
it.skip("Town-prefixed identities use the town_id confirm field", () => {});
it.skip("a saved Town binding is checked even before the background stream has loaded it", () => {});
it.skip("invalid or conflicting confirm identities cannot replace saved credentials", () => {});
it.skip("a new token survives storage failure in memory and retry never consumes another code", () => {});
it.skip("pair errors distinguish consumed-code uncertainty, invalid code, and rate limit without retry", () => {});
it.skip("changing Being while confirm is pending cannot save or publish its response", () => {});
it.skip("credential diagnostics distinguish missing, unreadable and unavailable storage without secrets", () => {});

type Frame = [string, Record<string, unknown>];
interface PairingFixtureOptions {
  events?: (scene: string) => Frame[];
  response?: (url: string, options: RequestInit) => Promise<Response> | Response;
  active?: () => Response;
  timeoutMs?: number;
}

function pairingFixture({ events, response, active = () => new Response(null, { status: 204 }), timeoutMs = 90000 }: PairingFixtureOptions = {}) {
  let context: PairingConnectionContext = { connected: true, connection: "https://echo.example/alice?token=loom-fixture", revision: 1 };
  const calls: { url: string; options: RequestInit }[] = [];
  const pairs: { code: string }[] = [];
  const client: PairingClient = {
    store: { assertAvailable() {} },
    state: () => ({}),
    pair: async (value) => { pairs.push(value); return { paired: true }; },
  };
  const pairing = new TownPairing({
    getContext: () => context,
    client,
    timeoutMs,
    fetchImpl: (async (url: string, options: RequestInit) => {
      calls.push({ url, options });
      if (new URL(url).pathname.endsWith("/active")) return active();
      if (response) return response(url, options);
      const { scene_id: scene } = JSON.parse(String(options.body));
      const frames: Frame[] = events ? events(scene) : [["meta", { scene_id: scene }], ["text", { text: "AB0" }], ["text", { text: "1XY" }], ["done", {}]];
      return new Response(frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch,
  });
  return { pairing, client, pairs, calls, switch() { context = { ...context, revision: 2, connection: "https://echo.example/bob?token=other" }; pairing.reset(); } };
}

it("one click pairs once from a complete, scene-bound reply and exposes no code or credential", async () => {
  const f = pairingFixture();
  expect(await f.pairing.connect()).toEqual({ paired: true });
  expect(f.pairs).toEqual([{ code: "AB01XY" }]);
  expect(f.calls.length).toBe(2);
  expect(f.pairing.state().busy).toBe(false);
  expect(JSON.stringify(f.pairing.state()).includes("AB01XY")).toBe(false);
  expect(JSON.stringify(f.pairing.state()).includes("loom-fixture")).toBe(false);
  expect(f.calls[1].options.redirect).toBe("error");
});

it("content_block_delta supports fragmented codes and ignores reasoning and tool results", async () => {
  const f = pairingFixture({ events: (scene) => [["meta", { scene_id: scene }], ["reasoning", { text: "SECRET" }], ["tool_result", { text: "WRONG1" }], ["content_block_delta", { delta: { text: "AB3" } }], ["content_block_delta", { delta: { text: "XY9" } }], ["message_stop", {}]] });
  await f.pairing.connect();
  expect(f.pairs).toEqual([{ code: "AB3XY9" }]);
});

it("foreign, unscoped, incomplete, ambiguous and errored replies never authorize a client", async () => {
  for (const events of [
    (_scene: string): Frame[] => [["meta", { scene_id: "foreign" }], ["text", { text: "AB3XY9" }], ["done", {}]],
    (_scene: string): Frame[] => [["text", { text: "AB3XY9" }], ["done", {}]],
    (scene: string): Frame[] => [["meta", { scene_id: scene }], ["text", { text: "AB3XY9" }]],
    (scene: string): Frame[] => [["meta", { scene_id: scene }], ["text", { text: "AB3XY9 CD4YZ8" }], ["done", {}]],
    (scene: string): Frame[] => [["meta", { scene_id: scene }], ["text", { text: "AB3XY9" }], ["error", { message: "failed" }], ["done", {}]],
    (scene: string): Frame[] => [["meta", { scene_id: scene }], ["text", { text: "AB3XY9" }], ["meta", { scene_id: "foreign" }], ["done", {}]],
  ]) {
    const f = pairingFixture({ events });
    await expect(f.pairing.connect()).rejects.toMatchObject({ code: "PAIRING_INCOMPLETE" });
    expect(f.pairs.length).toBe(0);
    expect(f.calls.length).toBe(2);
  }
});

it("202 queues only one request and falls back without extracting or resending", async () => {
  const f = pairingFixture({ response: () => json({ spliced: true }, 202) });
  await expect(f.pairing.connect()).rejects.toMatchObject({ code: "PAIRING_INCOMPLETE" });
  expect(f.pairs.length).toBe(0);
  expect(f.calls.length).toBe(2);
});

it("busy Being and unavailable safe storage block before sending a chat message", async () => {
  const f = pairingFixture({ active: () => json({ finished: false }) });
  await expect(f.pairing.connect()).rejects.toMatchObject({ code: "BUSY" });
  expect(f.calls.length).toBe(1);
  const g = pairingFixture();
  g.client.store.assertAvailable = () => { throw Object.assign(new Error("unavailable"), { code: "AUTH_REQUIRED" }); };
  await expect(g.pairing.connect()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  expect(g.calls.length).toBe(0);
  const h = pairingFixture();
  h.client.pairing = true;
  await expect(h.pairing.connect()).rejects.toMatchObject({ code: "BUSY" });
  expect(h.calls.length).toBe(0);
});

it("concurrent clicks and switching Being cannot confirm a stale code", async () => {
  let resolve!: (value: Response) => void;
  const f = pairingFixture({ response: () => new Promise<Response>((r) => { resolve = r; }) });
  const pending = f.pairing.connect();
  await tick();
  await expect(f.pairing.connect()).rejects.toMatchObject({ code: "BUSY" });
  f.switch();
  resolve(json({}, 202));
  await expect(pending).rejects.toMatchObject({ code: "SESSION_CHANGED" });
  expect(f.pairs.length).toBe(0);
  expect(f.pairing.state().busy).toBe(false);
});

it("a timeout ignores a late response and never repeats the chat or confirm request", async () => {
  let resolve!: (value: Response) => void;
  const f = pairingFixture({ timeoutMs: 1, response: () => new Promise<Response>((r) => { resolve = r; }) });
  const pending = f.pairing.connect();
  await new Promise((r) => setTimeout(r, 10));
  const scene = JSON.parse(String(f.calls[1].options.body)).scene_id;
  resolve(new Response(`event: meta\ndata: ${JSON.stringify({ scene_id: scene })}\n\nevent: text\ndata: {"text":"AB3XY9"}\n\nevent: done\ndata: {}\n\n`, { headers: { "Content-Type": "text/event-stream" } }));
  await expect(pending).rejects.toMatchObject({ code: "PAIRING_INCOMPLETE" });
  expect(f.pairs.length).toBe(0);
  expect(f.calls.length).toBe(2);
});
