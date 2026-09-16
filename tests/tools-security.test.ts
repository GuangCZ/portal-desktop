// Ported line by line from BeingDesktop 0.8.26 test/security.test.cjs on 2026-09-16.
//
// The subject is `desktop/main/common/loom-connection.ts`, which is where
// src/security.cjs ended up. The one case this file used to have for
// `protocolFile` went with it: that function resolved `being://app/...` for the
// Loom document's own protocol, which this shell does not serve, and after I2 and
// I3 landed it still had NO production caller — the tool browser loads remote
// http(s) pages, and the shell's only local document is `beings://desktop`, served
// by `app/protocol.ts` with its own guard (it never decodes the path, so an
// encoded `..%2f` stays a filename rather than becoming a traversal). Keeping a
// test for a function nothing calls is coverage of nothing. IM, 2026-09-16.
import { describe, expect, it } from "vitest";
import { allowedNavigation, endpoint, parseConnection, publicModelUrl, sessionPartition } from "../desktop/main/common/loom-connection";

describe("desktop security boundaries", () => {
  it("connection separates public metadata from credentials", () => {
    const c = parseConnection("https://example.test/being/?token=private&api=https://example.test/being");
    expect(c.displayUrl).toBe("https://example.test/being/");
    expect(c.token).toBe("private");
    expect(new URL(endpoint(c, "/api/status")).searchParams.get("token")).toBe("private");
    expect(c.beingName).toBe("being");
  });
  it("rejects credential forwarding and unsafe schemes", () => {
    for (const url of ["https://example.test/?token=x&api=https://other.test", "http://example.test/a", "file:///C:/a", "https://a:b@example.test/a", "https://example.test/?api=https://example.test/x?token=x"]) expect(() => parseConnection(url)).toThrow();
    expect(parseConnection("http://127.0.0.1:9000/").displayUrl).toBe("http://127.0.0.1:9000/");
  });
  it("native API helper only reads verified endpoints", () => {
    expect(() => endpoint(parseConnection("https://example.test/a"), "/api/chat/stream")).toThrow();
    expect(publicModelUrl("https://name:pass@example.test/v1?key=secret")).toBe("https://example.test/v1");
  });
  it("persistent sessions isolate backends and credentials while retaining the same identity", () => {
    const a = parseConnection("https://example.test/loom/?api=https://example.test/a&token=first");
    const b = parseConnection("https://example.test/loom/?api=https://example.test/b&token=first");
    const c = parseConnection("https://example.test/loom/?api=https://example.test/a&token=second");
    expect(sessionPartition(a)).not.toBe(sessionPartition(b));
    expect(sessionPartition(a)).not.toBe(sessionPartition(c));
    expect(sessionPartition(a)).toBe(sessionPartition({ ...a }));
    expect(sessionPartition(a)).toMatch(/^persist:loom-v1-[a-f0-9]{32}$/);
    expect(sessionPartition(a)).not.toMatch(/first|example/);
  });
  it("persistent sessions isolate secret-only changes and normalize secret parameter aliases", () => {
    const a = parseConnection("https://example.test/loom/?api=https://example.test/a&token=same-token&relay_secret=first-relay");
    const b = parseConnection("https://example.test/loom/?api=https://example.test/a&token=same-token&relay_secret=second-relay");
    const alias = parseConnection("https://example.test/loom/?api=https://example.test/a&token=same-token&secret=first-relay");
    expect(a.displayUrl).toBe(b.displayUrl);
    expect(a.apiBase).toBe(b.apiBase);
    expect(a.token).toBe(b.token);
    expect(a.secret).not.toBe(b.secret);
    expect(sessionPartition(a)).not.toBe(sessionPartition(b));
    expect(sessionPartition(a)).toBe(sessionPartition(alias));
    expect(sessionPartition(a)).not.toMatch(/same-token|first-relay/);
  });

  it("navigation allows slash normalization in both directions but rejects other routes", () => {
    for (const input of ["https://example.test/being", "https://example.test/being/"]) {
      const c = parseConnection(input);
      expect(allowedNavigation(c, "https://example.test/being/")).toBe(true);
      expect(allowedNavigation(c, "https://example.test/being")).toBe(true);
      for (const target of ["https://other.test/being/", "http://example.test/being/", "https://example.test/another", "file:///being"]) expect(allowedNavigation(c, target)).toBe(false);
    }
  });
});
