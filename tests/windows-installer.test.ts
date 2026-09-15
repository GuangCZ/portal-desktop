// BeingDesktop 0.8.x ships an NSIS installer with no explicit `nsis.guid`, so
// electron-builder derives one from the appId. Pinning the same derived value
// here keeps the uninstall registry key — and therefore the in-place upgrade —
// identical to the one a 0.8.x installation already registered; 2026-09-16.
import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import installer from "../desktop/windows-installer.json";
import signing from "../desktop/macos-signing.json";

// app-builder-lib/out/targets/nsis/NsisTarget.js:
//   const guid = options.guid || UUID.v5(appInfo.id, ELECTRON_BUILDER_NS_UUID)
// with ELECTRON_BUILDER_NS_UUID = UUID.parse("50e065bc-3134-11e6-9bab-38c9862bdaf3")
// and UUID.v5 = RFC 4122 name-based SHA-1 (builder-util-runtime/out/uuid.js
// `uuidNamed`), i.e. sha1(namespaceBytes ++ nameBytes) with version 5 and the
// RFC 4122 variant stamped into bytes 6 and 8.
const ELECTRON_BUILDER_NS_UUID = "50e065bc-3134-11e6-9bab-38c9862bdaf3";
function uuidV5(name: string, namespace: string) {
  const bytes = createHash("sha1").update(Buffer.from(namespace.replaceAll("-", ""), "hex")).update(name).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}

it("pins the NSIS GUID electron-builder derives from the application identifier", () => {
  expect(installer.appId).toBe("town.beings.desktop");
  // One identifier across the macOS bundle, the Windows installer and the
  // Windows application user model ID.
  expect(signing.clientIdentifier).toBe(installer.appId);
  expect(uuidV5(installer.appId, ELECTRON_BUILDER_NS_UUID)).toBe(installer.guid);
  // A sanity check on the derivation itself, against RFC 4122 appendix B's
  // published example: v5 of "www.example.org" in the DNS namespace.
  expect(uuidV5("www.example.org", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe("74738ff5-5367-5958-9aee-98fffdcd1876");
  // The value the previous identifier produced must no longer be in use.
  expect(installer.guid).not.toBe(uuidV5("town.beings.portal-desktop", ELECTRON_BUILDER_NS_UUID));
});
