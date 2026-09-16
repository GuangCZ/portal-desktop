import type { ForgeConfig } from '@electron-forge/shared-types';
import type { OsxSignOptions } from '@electron/packager';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { ignoreMacSigningFile } from './scripts/mac-signing';
import signing from './desktop/macos-signing.json';
import { macDmgIdentifier, verifyMacSignature } from './desktop/main/updates/mac-signature';
import pkg from './package.json';

const binary = path.resolve('resources', process.platform === 'win32' ? 'heart-portal.exe' : 'heart-portal');
const macLocalTest = process.env.PORTAL_DESKTOP_MAC_LOCAL_TEST === '1';
const macIdentity = macLocalTest ? '-' : signing.identity;
if (process.platform === 'darwin' && macLocalTest && process.env.GITHUB_REF?.startsWith('refs/tags/')) {
  throw new Error('Local-test macOS signatures cannot be published as a release.');
}
// Packager supports continueOnError at runtime but omits it from its public type.
const macSignOptions: OsxSignOptions & { continueOnError: false } = {
  identity: macIdentity,
  continueOnError: false,
  keychain: process.env.PORTAL_DESKTOP_MAC_KEYCHAIN,
  identityValidation: macIdentity !== '-',
  preAutoEntitlements: macIdentity !== '-',
  preEmbedProvisioningProfile: false,
  ignore: ignoreMacSigningFile,
  optionsForFile: () => macIdentity === '-' ? { timestamp: 'none' } : {},
};
// The modules that must reach the packaged app as real files rather than as part
// of a bundle, with their runtime dependencies. MEASURED 2026-09-16, not
// inferred: @electron-forge/plugin-vite sets `packagerConfig.ignore` to
// `file => !file.startsWith('/.vite')`, so node_modules is excluded from the
// package ENTIRELY — moving a module from devDependencies to dependencies changes
// nothing, because @electron/packager never gets as far as pruning. A packaged
// build made before this list existed contained 15 asar entries and no
// node_modules at all.
//
// The plugin skips its own ignore when one is already set (VitePlugin.js
// resolveForgeConfig), which is what the function below relies on. It keeps the
// same '/.vite' rule and adds these subtrees.
//
//   ws         the tool bridge's relay socket. Bundling it does NOT work: Vite
//              stubs its optional peer deps and the first frame throws
//              "bufferUtil.mask is not a function" (desktop/main/tools/tool-link.ts).
//   node-pty   the interactive terminal; resolves a .node binary at runtime, which
//              AutoUnpackNativesPlugin then unpacks beside the asar.
//   node-addon-api  node-pty's only runtime dependency.
//
// Anything added here must be a `dependencies` entry, and its own runtime
// dependencies must be listed too — this is a literal list, not a resolver.
// tests/packaging-contract.test.ts pins both halves.
export const PACKAGED_MODULES = ['ws', 'node-pty', 'node-addon-api'];
const MODULE_PATH = /^\/node_modules\/((?:@[^/]+\/)?[^/]+)(?:\/|$)/;
// node-pty ships 58 MB of prebuilt binaries for four platform/arch pairs. Only
// the packaging host's can ever run, and @electron/rebuild builds a fresh
// `build/Release/pty.node` inside the copied tree anyway — which node-pty's own
// loader prefers over `prebuilds/` (node_modules/node-pty/lib/utils.js:19).
// Cross-packaging a native module is not possible regardless, so the host's
// platform is the right filter. Everything else under node-pty stays: the rebuild
// runs AFTER the copy (measured — the source tree still has no `build/`
// afterwards), so binding.gyp, src/, deps/ and third_party/ must be present.
const FOREIGN_PREBUILD = /^\/node_modules\/node-pty\/prebuilds\/([^/]+)/;
// node-pty's macOS helper is an executable with NO extension, so the plugin's
// `**/{.**,**}/**/*.node` never matches it. node-pty resolves it at
// `<native.dir>/spawn-helper` with `app.asar` rewritten to `app.asar.unpacked`
// (node_modules/node-pty/lib/unixTerminal.js:29-32) and hands the path to
// posix_spawn (src/unix/pty.cc:351, inside `#if defined(__APPLE__)`). Left inside
// the archive there is no file at that path and every `pty.fork` on macOS fails
// with `posix_spawnp failed.` — Linux and Windows do not use a helper at all
// (binding.gyp builds the target only under `OS=="mac"`).
//
// MEASURED 2026-09-16 against @electron/asar 3.4.1, which is what actually
// decides this — `minimatch(relativePath, unpack, { matchBase: true })`
// (lib/asar.js:147) — by packaging a node-pty-shaped tree twice: with the
// plugin's glob alone both spawn-helper copies stay inside app.asar; with this
// one merged in, all four of build/Release/{pty.node,spawn-helper} and
// prebuilds/<host>/{pty.node,spawn-helper} land in app.asar.unpacked, the
// helpers keeping mode 755.
//
// Both directories are listed because @electron/rebuild builds a fresh
// `build/Release/spawn-helper` while packaging (measured: rebuild 3.7.2 against
// Electron 44.2.0 emits a Mach-O arm64 executable beside pty.node) and node-pty's
// loader prefers `build/Release` over `prebuilds/`; the prebuilt copy is the
// fallback and must be outside the archive too.
//
// One asymmetry, measured in a real `electron-forge package` on 2026-09-16: the
// rebuilt helper arrives mode 755 and osx-sign signs it (it is a Mach-O, so
// scripts/mac-signing.ts does not skip it), while the copies npm unpacks into
// `prebuilds/` are mode 644. That only matters if node-pty ever falls back to
// them, which it cannot while Forge's own "Preparing native dependencies" step
// produces build/Release — if that step is ever disabled, chmod the helper.
//
// AutoUnpackNativesPlugin MERGES an existing unpack rather than replacing it —
// `{<existing>,**/{.**,**}/**/*.node}` (AutoUnpackNativesPlugin.js:21-23) — so
// declaring this one keeps the `.node` rule as well. tests/packaging-contract.ts
// packs a real fixture through the merged glob rather than trusting the string.
export const NATIVE_UNPACK = '**/node_modules/node-pty/{build/*,prebuilds/*}/spawn-helper';
export function packagerIgnore(file: string): boolean {
  if (!file) return false;
  if (file.startsWith('/.vite')) return false;
  if (file === '/node_modules') return false;
  const prebuild = FOREIGN_PREBUILD.exec(file);
  if (prebuild && !prebuild[1].startsWith(`${process.platform}-`)) return true;
  const owner = MODULE_PATH.exec(file);
  return owner ? !PACKAGED_MODULES.includes(owner[1]) : true;
}

const config: ForgeConfig = {
  outDir: process.env.PORTAL_DESKTOP_PACKAGE_OUT || 'out',
  packagerConfig: {
    asar: { unpack: NATIVE_UNPACK },
    ignore: packagerIgnore,
    // Packager also derives macOS's display name from its executable name.
    executableName: process.platform === 'darwin' ? 'Being Desktop' : 'being-desktop',
    appBundleId: signing.clientIdentifier,
    ...(process.platform === 'darwin' ? {
      osxSign: macSignOptions,
      // Match Heart Portal: Developer ID + hardened runtime + timestamp;
      // notarization is deliberately deferred, with no automatic submission.
    } : {}),
    icon: path.resolve('resources/branding/app'),
    extraResource: [binary, path.resolve('resources/HEART-PORTAL-LICENSE'), path.resolve('resources/branding'), path.resolve('resources/runtime-bundle.json')],
  },
  hooks: {
    prePackage: async () => {
      if (!existsSync(binary)) throw new Error('Portal binary missing. Run npm run build:portal first.');
      if (process.platform === 'darwin') execFileSync(process.execPath, ['scripts/sign-macos-runtime.mjs'], { stdio: 'inherit' });
    },
    postPackage: async (_forgeConfig, result) => {
      if (result.platform === 'darwin' && !macLocalTest) {
        for (const output of result.outputPaths) {
          const app = path.join(output, `${pkg.productName}.app`);
          await verifyMacSignature(app, signing.clientIdentifier);
          await verifyMacSignature(path.join(app, 'Contents/Resources/heart-portal'), signing.portalIdentifier);
        }
      }
    },
    postMake: async (_forgeConfig, makeResults) => {
      if (process.platform === 'darwin') {
        for (const dmg of makeResults.flatMap(result => result.artifacts).filter(file => file.endsWith('.dmg'))) {
          execFileSync('/usr/bin/codesign', ['--force', '--sign', macIdentity, '--identifier', macDmgIdentifier,
            ...(macLocalTest ? ['--timestamp=none'] : ['--timestamp']),
            ...(process.env.PORTAL_DESKTOP_MAC_KEYCHAIN ? ['--keychain', process.env.PORTAL_DESKTOP_MAC_KEYCHAIN] : []), dmg], { stdio: 'inherit' });
          if (!macLocalTest) await verifyMacSignature(dmg, macDmgIdentifier);
        }
      }
      return makeResults;
    },
  },
  makers: [
    new MakerZIP({}, ['darwin', 'linux', 'win32']),
    new MakerDMG({ title: 'Being Desktop', icon: path.resolve('resources/branding/app.icns'), format: 'ULFO' }, ['darwin']),
  ],
  // node-pty's `.node` binaries cannot be loaded from inside an asar, so the
  // plugin adds `asar.unpack: '**/{.**,**}/**/*.node'` to the rule declared above
  // (measured against @electron-forge/plugin-auto-unpack-natives 7.11.2, which
  // rewrites packagerConfig.asar in a resolveForgeConfig hook and throws if asar
  // is off). Its glob covers the binaries; NATIVE_UNPACK covers the extensionless
  // macOS spawn-helper it cannot see.
  //
  // node-pty 1.1.0 ships N-API prebuilds for darwin-arm64, darwin-x64, win32-x64
  // and win32-arm64, so no electron-rebuild step is needed on the platforms this
  // client ships — the binary is ABI-stable across Node and Electron versions.
  // Linux has no prebuild: a Linux MakerZIP target would need python3 + make +
  // g++ on the build machine. See docs/migration/i0-seams.md.
  plugins: [new AutoUnpackNativesPlugin({}), new VitePlugin({
    build: [
      { entry: 'desktop/main/main.ts', config: 'vite.main.config.ts', target: 'main' },
      { entry: 'desktop/preload/preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
    ],
    renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
  })],
};
export default config;
