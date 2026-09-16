// The Being identity string is a disk format. Added by the I0 seam stage on
// 2026-09-16, when `chat/connection.ts`'s hand-copied `beingIdentityKey` body was
// replaced by a delegation to `common/loom-connection.ts`.
//
// Two entry points now produce it: `beingIdentityKey(address)` starts from the
// address exactly as `settings.json` saved it, and `sessionPartition(connection)`
// starts from a parsed connection (`chat/session-recovery.ts` and the Electron
// session partition use that one). They have to agree, byte for byte, with
// BeingDesktop 0.8.26 src/security.cjs — the string names the chat-cache file,
// the session-recovery file, the feature-task buckets, the worker directories and
// the TownClientStore keys, so a drift of one character makes a 0.8.x profile's
// state invisible and writes it all again under a new name.
//
// The expected values are literals rather than a second implementation: a helper
// written here would drift in exactly the same way the code under test can.
// Fixture addresses are BeingDesktop's own (test/security.test.cjs and
// test/loom-sessions.test.cjs), covering `api=`, `relay_secret=`, the `secret=`
// alias, a trailing path slash and an http loopback address.
import { describe, expect, it } from "vitest";
import { beingIdentityKey } from "../desktop/main/chat/connection";
import { parseConnection, sessionPartition } from "../desktop/main/common/loom-connection";

const FIXTURES: readonly (readonly [address: string, partition: string])[] = [
  ["https://example.test/loom/?api=https://example.test/a&token=first",
    "persist:loom-v1-a29d46d3dc0159492a2d622fe6356d7d"],
  ["https://example.test/loom/?api=https://example.test/a&token=same-token&relay_secret=first-relay",
    "persist:loom-v1-ed2a654dc43f94687ec7b38272e80671"],
  ["https://example.test/loom/?api=https://example.test/a&token=same-token&secret=first-relay",
    "persist:loom-v1-ed2a654dc43f94687ec7b38272e80671"],
  ["https://being.example.test/alice?api=https://being.example.test/heart&token=private-loom-token&relay_secret=private-relay-secret",
    "persist:loom-v1-8e71ee13b9156cd2abc7dfce3118094f"],
  ["https://beings.example/loom?token=secret",
    "persist:loom-v1-16f42cf48d51416ea4ac1902bae4fbde"],
  ["https://beings.example/loom/?token=secret",
    "persist:loom-v1-7cb148614ae20d7793b2095cb14c9cf9"],
  ["http://127.0.0.1:9000/being/?token=local-only",
    "persist:loom-v1-a8252e11f85d14af6fd3bc32b005adb2"],
];

describe("the Being identity partition", () => {
  it("reproduces BeingDesktop 0.8.26's partition for every address shape", () => {
    for (const [address, partition] of FIXTURES) {
      expect(beingIdentityKey(address), address).toBe(partition);
      expect(sessionPartition(parseConnection(address)), address).toBe(partition);
    }
  });

  it("agrees whichever entry point computes it", () => {
    for (const [address] of FIXTURES) {
      expect(beingIdentityKey(address), address).toBe(sessionPartition(parseConnection(address)));
    }
  });

  it("keeps the trailing path slash and the secret apart from the token", () => {
    // `displayUrl` retains the trailing slash while `apiBase` drops it, which is
    // the whole reason the identity is computed from the address rather than from
    // `Connection`, whose `link` normalizes both away.
    expect(beingIdentityKey("https://beings.example/loom?token=secret"))
      .not.toBe(beingIdentityKey("https://beings.example/loom/?token=secret"));
    // The same Being reached with a different relay secret is a different binding
    // and must not read the first one's cache.
    expect(beingIdentityKey("https://beings.example/loom/?token=secret&relay_secret=one"))
      .not.toBe(beingIdentityKey("https://beings.example/loom/?token=secret&relay_secret=two"));
    // `relay_secret` and `secret` are aliases, so they land on one identity.
    expect(beingIdentityKey("https://beings.example/loom/?token=secret&relay_secret=one"))
      .toBe(beingIdentityKey("https://beings.example/loom/?token=secret&secret=one"));
  });

  it("never leaks the token or the secret into the partition it returns", () => {
    const key = beingIdentityKey("https://beings.example/loom/?token=private-fixture&relay_secret=private-relay");
    expect(key).toMatch(/^persist:loom-v1-[a-f0-9]{32}$/);
    expect(key).not.toMatch(/private-fixture|private-relay|beings\.example/);
  });
});
