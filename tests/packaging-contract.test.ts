// What typecheck and the rest of this suite are blind to; 2026-09-16.
//
// Three of the I0 seam stage's changes only show up in a packaged build, which is
// the one thing CI cannot produce on every push: `ws` must reach the asar as a
// runtime dependency (a dev dependency is pruned out and `require('ws')` fails
// with MODULE_NOT_FOUND), it must NOT be bundled into the main chunk (Vite stubs
// its optional peer dependencies and the first outbound frame throws
// "TypeError: bufferUtil.mask is not a function" — measured, see
// desktop/main/tools/tool-link.ts), and node-pty's `.node` binaries must be
// unpacked out of the asar or they cannot be loaded at all.
//
// A development tree has every dependency installed either way, so nothing else
// here would notice any of the three regressing. These assertions read the real
// configuration files, so they fail on the commit that breaks the release rather
// than on the release.
//
// The fourth, and the one that cost a packaged build to discover (2026-09-16):
// @electron-forge/plugin-vite sets `packagerConfig.ignore` to
// `file => !file.startsWith('/.vite')` unless one is already set, so being a
// runtime dependency is NOT enough — node_modules is excluded from the package
// wholesale. `packagerIgnore` in forge.config.ts is what lets the few modules that
// must exist as real files through, and it is what these cases pin.
import { describe, expect, it } from "vitest";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import type { ResolvedForgeConfig } from "@electron-forge/shared-types";
import forge, { PACKAGED_MODULES, packagerIgnore } from "../forge.config";
import main from "../vite.main.config";
import pkg from "../package.json";

/** Runtime dependencies pinned to BeingDesktop 0.8.26's own versions, because
 * each is a native or protocol-level component whose behaviour a minor bump can
 * change under the client. */
const PINNED = { "ws": "8.21.3", "node-pty": "1.1.0", "@xterm/xterm": "6.0.0", "@xterm/addon-fit": "0.11.0" };

describe("the packaged client's dependency contract", () => {
  it("keeps ws and node-pty in dependencies, pinned, and out of devDependencies", () => {
    const dependencies = pkg.dependencies as Record<string, string>;
    const devDependencies = pkg.devDependencies as Record<string, string>;
    for (const [name, version] of Object.entries(PINNED)) {
      expect(dependencies[name], name).toBe(version);
      expect(devDependencies[name], name).toBeUndefined();
    }
  });

  it("keeps ws and node-pty out of the main-process bundle", () => {
    const external = (main.build?.rollupOptions?.external ?? []) as string[];
    expect(external).toContain("ws");
    expect(external).toContain("node-pty");
    // electron was already external and must stay so.
    expect(external).toContain("electron");
  });

  it("unpacks native binaries from the asar", async () => {
    expect(forge.packagerConfig?.asar).toBeTruthy();
    const plugin = forge.plugins?.find(entry => (entry as { name?: string }).name === "auto-unpack-natives");
    expect(plugin).toBeInstanceOf(AutoUnpackNativesPlugin);
    // Run the plugin's own hook over this project's real packager config rather
    // than asserting the glob it is documented to use: the glob is the plugin's
    // business, having `.node` files outside the archive is ours.
    const resolve = (plugin as AutoUnpackNativesPlugin).getHooks().resolveForgeConfig!;
    const input = { ...forge, packagerConfig: { ...forge.packagerConfig } } as unknown as ResolvedForgeConfig;
    const resolved = (await resolve(input, {} as never)) as ResolvedForgeConfig;
    const asar = resolved.packagerConfig?.asar;
    expect(typeof asar).toBe("object");
    expect((asar as { unpack?: string }).unpack).toMatch(/\*\.node/);
  });
});

describe("what reaches the packaged tree", () => {
  it("keeps the Vite output", () => {
    expect(packagerIgnore("/.vite")).toBe(false);
    expect(packagerIgnore("/.vite/build/main.js")).toBe(false);
  });

  it("keeps the module directory itself, or nothing beneath it is ever visited", () => {
    // This is the whole bug: plugin-vite's own ignore answers true here, which
    // skips the subtree before @electron/packager's production-dependency pruner
    // can see any of it.
    expect(packagerIgnore("/node_modules")).toBe(false);
  });

  it("keeps ws, node-pty and node-pty's own runtime dependency", () => {
    for (const name of PACKAGED_MODULES) {
      expect(packagerIgnore(`/node_modules/${name}`), name).toBe(false);
      expect(packagerIgnore(`/node_modules/${name}/package.json`), name).toBe(false);
    }
    expect(packagerIgnore("/node_modules/ws/index.js")).toBe(false);
    expect(packagerIgnore("/node_modules/node-pty/lib/index.js")).toBe(false);
    // The rebuild runs on the copied tree, so node-pty's build inputs must travel
    // with it.
    expect(packagerIgnore("/node_modules/node-pty/binding.gyp")).toBe(false);
    expect(packagerIgnore("/node_modules/node-pty/src/unix/pty.cc")).toBe(false);
    expect(packagerIgnore("/node_modules/node-pty/deps/anything")).toBe(false);
  });

  it("keeps only the packaging host's prebuilt binaries", () => {
    expect(packagerIgnore(`/node_modules/node-pty/prebuilds/${process.platform}-${process.arch}/pty.node`)).toBe(false);
    const foreign = process.platform === "win32" ? "darwin" : "win32";
    expect(packagerIgnore(`/node_modules/node-pty/prebuilds/${foreign}-x64/pty.node`)).toBe(true);
  });

  it("leaves out everything that belongs in a bundle", () => {
    // These are dependencies too; the pruner keeps their directory entry, and this
    // filter keeps their contents out, because the renderer and main chunks
    // already contain them.
    for (const file of ["/node_modules/react/index.js", "/node_modules/marked/lib/marked.cjs",
      "/node_modules/@xterm/xterm/lib/xterm.js", "/node_modules/typescript/lib/tsc.js",
      "/desktop/main/main.ts", "/package.json", "/tests/packaging-contract.test.ts"])
      expect(packagerIgnore(file), file).toBe(true);
  });
});
