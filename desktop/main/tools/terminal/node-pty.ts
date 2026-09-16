// The one file in this repository that reaches for node-pty; 2026-09-16.
//
// BeingDesktop 0.8.26 loaded it inline, inside `create()`'s try block:
// `this.pty ||= require('node-pty')` (src/desktop-terminal.cjs). The port kept
// the lazy load and the failure behaviour but moved the lookup behind
// `setDefaultPtyFactory`, so `DesktopTerminal` stays testable without a native
// module. This registers the real one.
//
// PACKAGING CONTRACT — all of it measured, none inferred
// (docs/migration/i0-seams.md §H, and forge.config.ts):
//
//  · `createRequire`, not a static `import`. `vite.main.config.ts` lists
//    'node-pty' in `build.rollupOptions.external`, so a static import would be
//    left as a bare specifier in an ESM bundle and fail to resolve at runtime;
//    and bundling it is not an option either, because the package is a loader for
//    a `.node` binary.
//  · The module has to be INSIDE the asar. `@electron-forge/plugin-vite` sets
//    `packagerConfig.ignore` to exclude the whole of node_modules; forge.config.ts
//    overrides that with `packagerIgnore`, which lets 'node-pty',
//    'node-addon-api' and 'ws' through. Being in `dependencies` is necessary and
//    not sufficient.
//  · The BINARY has to be outside it. `plugin-auto-unpack-natives` unpacks
//    `**/*.node`, and forge.config.ts adds `NATIVE_UNPACK` for macOS's
//    `spawn-helper`, which has no extension and which `pty.fork` execs by path.
//
// None of that is visible to typecheck or vitest — the development tree has a
// node_modules — so `tests/packaging-contract.test.ts` pins the configuration and
// a packaged smoke run is what proves the whole chain (integration plan §6.3).
import { createRequire } from 'node:module';
import { setDefaultPtyFactory } from './terminal';
import type { PtyFactory } from './types';

const nodeRequire = createRequire(import.meta.url);

/**
 * Point `DesktopTerminal` at the real node-pty. Called once from the terminal
 * subsystem's installer, mirroring where BeingDesktop's boot() built the terminal
 * (src/main.cjs line 1710).
 *
 * The module is NOT loaded here: the factory is a thunk, resolved on the first
 * `create()`. A machine whose native module is missing or built for the wrong ABI
 * therefore still opens the client, and fails only when someone asks for a
 * terminal — with BeingDesktop's own sentence,「无法启动 … 交互终端，请检查终端
 * 组件与系统安装。」, since the throw happens inside the same try block a failed
 * `require` used to.
 */
export function registerNodePty(): void {
  setDefaultPtyFactory(() => nodeRequire('node-pty') as PtyFactory);
}
