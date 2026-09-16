// Ported from BeingDesktop 0.8.26 test/p1-name-rules.test.cjs on 2026-09-16 — the cases
// that target this unit's four modules (TownClient, TownSession, town-wire,
// town-library-contract) plus the `candidates` helper TownClient depends on.
//
// Out of this unit and therefore NOT ported here: the BeingTownWriter relay cases
// ("P1 relay accepts pinned town_id-only receipts…", "P1 relay cannot accept an unbound
// or conflicting Town identity"), the TownCachedReads case ("P1 persisted member
// snapshots expire…"), and the renderer town-mentions cases ("P1 own-message
// classification…", "P1 manual names stay raw…"). Where an in-scope case also asserted
// through preload.cjs or TownController, only that half is dropped; the assertion on
// this unit's modules is kept verbatim.
import { describe, expect, it } from "vitest";
import { TownClient } from "../desktop/main/town/session/client";
import { TownSession, messagesDto } from "../desktop/main/town/session/session";
import { candidates } from "../desktop/main/town/session/candidates";
import { matchesTownIdentity } from "../desktop/main/town/session/wire";
import type { TownClientContext, TownClientEvent, TownCredentialStore } from "../desktop/main/town/session/types";

const choices = [{ town_id: "t_a", display_name: "Neuromancer" }, { town_id: "t_b", display_name: "Neuromancer" }];
const warnings = [{ mention: "@Neuromancer", reason: "ambiguous", candidates: choices, server_field: "preserve this" }];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function clientFixture(response?: ((route: string, options: RequestInit) => Response) | null, onEvent: (event: TownClientEvent) => void = () => {}) {
  const context: TownClientContext = { key: "test-session", beingId: "cz_being", revision: 1, connected: true };
  const calls: { route: string; method: string | undefined }[] = [];
  const profile: Record<string, unknown> = { town_id: "t_self", display_name: "Before", mentions: [] };
  const store: TownCredentialStore = { loadCredential: async () => ({ token: "a".repeat(64), townId: "t_self" }) };
  const client = new TownClient({
    getContext: () => context, store, onEvent,
    fetchImpl: (async (url: string, options: RequestInit) => {
      const route = new URL(url).pathname; calls.push({ route, method: options.method });
      if (route === "/api/bonfire/mentions") return json(profile);
      expect(response, "No unexpected external route").toBeTruthy();
      return response!(route, options);
    }) as unknown as typeof fetch,
  });
  return { client, calls, profile, context };
}

describe("P1 Town name and identity rules", () => {
  it("P1 speak keeps mention_warnings verbatim and emits exactly one simulated POST", async () => {
    const f = clientFixture(() => json({ ok: true, town_id: "t_self", seq: 17, mentions: ["t_c"], mention_warnings: warnings }));
    const result = await f.client.speak({ kind: "bonfire", message: "@Neuromancer hello" });
    expect(result.ok).toBe(true); expect(result.mention_warnings).toEqual(warnings); expect(result.mentions).toEqual(["t_c"]);
    expect(f.calls.filter(c => c.method === "POST").length).toBe(1);
  });

  // The preload.cjs half of this case belongs to a later integration stage; the
  // TownClient half — a definite NOT_SENT carrying redacted detail and filtered
  // candidates — is asserted here.
  it("P1 private recipient 400 reads candidates and preserves a definite not-sent result", async () => {
    const f = clientFixture(() => json({ error: "ambiguous recipient", candidates: [...choices, { town_id: "../invalid", display_name: "No" }] }, 400));
    const captured = await f.client.sendDirectMessage({ recipient: "Neuromancer", content: "fixture" }).catch((e: unknown) => e) as Error & { code: string; detail: string; candidates: unknown };
    expect(captured.code).toBe("NOT_SENT"); expect(captured.detail).toBe("ambiguous recipient");
    expect(captured.candidates).toEqual(choices);
    expect(f.calls.filter(c => c.method === "POST").length).toBe(1);
  });

  it("P1 malformed candidate fields cannot become executable UI or escape the IPC DTO", () => {
    expect(candidates([{ town_id: "t_a", display_name: "<img src=x>", secret: "hidden" }, { town_id: "t_a", display_name: "duplicate" }, null])).toEqual([{ town_id: "t_a", display_name: "<img src=x>" }]);
  });

  // The TownController half of this case belongs to another unit; the TownClient
  // identity surface is asserted here.
  it("P1 identity exposes distinct Loom, verified Town and display fields", async () => {
    const f = clientFixture();
    expect(f.client.state().townId).toBe("");
    const identity = await f.client.identity();
    expect(identity).toEqual({ loomBeingId: "cz_being", townId: "t_self", displayName: "Before" });
    expect(f.client.state().beingId).toBe("cz_being"); expect(f.client.state().loomBeingId).toBe("cz_being"); expect(f.client.state().townId).toBe("t_self");
    f.client.reset(); expect(f.client.state().townId).toBe("");
  });

  it("P1 ambiguous and reused historical names stay unknown while an explicit ID survives", () => {
    const envelope: Record<string, unknown> = { ok: true, global_latest_seq: 1, messages: [{ seq: 1, being: "Echo", message: "past" } as Record<string, unknown>] };
    for (const members of [[{ id: "t_new_owner", name: "Echo" }], [{ id: "t_a", name: "Echo" }, { id: "t_b", name: "Echo" }], []]) {
      const row = messagesDto(envelope, members).messages[0];
      expect(row.beingId).toBe(""); expect(row.authorUnknown).toBe(true); expect(row.beingName).toBe("Echo");
    }
    (envelope.messages as Record<string, unknown>[])[0].town_id = "t_original";
    const row = messagesDto(envelope, [{ id: "t_new_owner", name: "Echo" }]).messages[0];
    expect(row.townId).toBe("t_original"); expect(row.beingId).toBe("t_original"); expect(row.authorUnknown).toBe(undefined);
  });

  it("P1 channel reads verify town_id-only preflight and status against the pinned binding", async () => {
    for (const wrong of [false, true]) {
      const calls: (string | undefined)[] = [];
      const session = new TownSession({
        getContext: () => ({ configured: true, connected: true, beingName: "cz_being", townId: "t_self", connectionId: 1 }),
        fetchImpl: (async (url: string, options: RequestInit) => {
          calls.push(options.method);
          return new URL(url).pathname === "/api/bonfire/mentions" ? json({ town_id: "t_self", mentions: [] }) : json({ town_id: wrong ? "t_other" : "t_self", channels: [{ channel: "feishu", ready: true }] });
        }) as unknown as typeof fetch,
      });
      if (wrong) await expect(session.getChannelStatus()).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
      else expect((await session.getChannelStatus()).channels[0].status).toBe("connected");
      expect(calls.every(method => method === "GET")).toBe(true);
    }
  });

  it("P1 members cache keys current metadata by ID, expires, refreshes manually and fences rename invalidation", async () => {
    let time = 1000, calls = 0, name = "Before";
    let release: true | (() => void) | undefined;
    const session = new TownSession({
      getContext: () => ({}), now: () => time, membersTtlMs: 50,
      fetchImpl: (async () => { calls++; if (release === true) await new Promise<void>(resolve => { release = resolve; }); return json({ community: [{ town_id: "t_self", display_name: name }, { town_id: "t_other", display_name: name }] }); }) as unknown as typeof fetch,
    });
    expect((await session.getMembers()).members.length).toBe(2); await session.getMembers(); expect(calls).toBe(1);
    time += 51; name = "After"; expect((await session.getMembers()).members[0].name).toBe("After"); expect(calls).toBe(2);
    await session.getMembers({ force: true }); expect(calls).toBe(3); expect(session.memberDisplayName("t_self")).toBe("After");
    release = true; const pending = session.getMembers({ force: true }); await new Promise(resolve => setImmediate(resolve)); session.invalidateMembers(); (release as unknown as () => void)();
    await expect(pending).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(session.memberCacheState().expiresAt).toBe(0); expect(session.memberDisplayName("t_self")).toBe("");
  });

  it("P1 verified local profile refresh emits cache invalidation without sending a message", async () => {
    const events: TownClientEvent[] = [];
    const session = new TownSession({ getContext: () => ({}), fetchImpl: (async () => json({ community: [{ town_id: "t_self", display_name: "Before" }] })) as unknown as typeof fetch });
    await session.getMembers();
    const f = clientFixture(null, event => { events.push(event); session.invalidateMembers(); });
    await f.client.identity(); f.profile.display_name = "After"; await f.client.identity({ force: true });
    expect(events).toEqual([{ type: "profile_changed", townId: "t_self" }]);
    expect(session.memberCacheState().expiresAt).toBe(0);
    expect(f.calls.every(c => c.method === "GET")).toBe(true);
  });

  // Only the town-wire half of "P1 exact acceptance fixture keeps Loom, Town and display
  // identities separate across IPC" — the TownController / preload / isOwnMessage
  // assertions belong to other units.
  it("P1 exact acceptance fixture keeps Loom, Town and display identities separate", () => {
    const identity = { loomBeingId: "cz_being", townId: "t_IzYOPP3G0ABJuK2M", displayName: "Neuromancer" };
    expect(matchesTownIdentity({ town_id: identity.townId }, identity)).toBe(true);
    for (const value of [{ town_id: "t_izyopp3g0abjuk2m" }, { town_id: identity.townId, being: "different_loom" }, { display_name: "Neuromancer" }]) expect(matchesTownIdentity(value, identity)).toBe(false);
    expect(matchesTownIdentity({ town_id: identity.townId }, { loomBeingId: "cz_being", townId: "" })).toBe(false);
  });

  // Only the SDK transport of "P1 SDK and relay receipts keep warnings through TownSession
  // and preload without directory-dependent ID addressing": the relay half needs
  // BeingTownWriter and the receipt is asserted directly instead of through preload.
  it("P1 SDK receipts keep warnings through TownSession without directory-dependent ID addressing", async () => {
    const body = "@t_missing_in_cache @Neuromancer fixture";
    const client = clientFixture(() => json({ ok: true, town_id: "t_self", seq: 17, mentions: ["t_missing_in_cache"], mention_warnings: warnings }));
    const session = new TownSession({
      getContext: () => ({ configured: true, connected: true, beingName: "cz_being", townId: "t_self", connectionId: 1 }),
      fetchImpl: (async () => { throw new Error("Exact IDs need no name directory"); }) as unknown as typeof fetch,
      writeImpl: request => client.client.speak({ kind: request.kind, message: request.content }),
    });
    const receipt = await session.sendBonfireMessage({ content: body, mentions: ["t_missing_in_cache"], connectionRevision: 1, requestId: "fixture-request" }) as { ok: boolean; mention_warnings: unknown };
    expect(receipt.ok).toBe(true); expect(receipt.mention_warnings).toEqual(warnings);
    expect(client.calls.filter(call => call.method === "POST").length).toBe(1);
  });
});
