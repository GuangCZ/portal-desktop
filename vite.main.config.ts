import { defineConfig } from 'vite';
import { execFileSync } from 'node:child_process';
let revision = 'local';
try { revision = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* Source archive. */ }
// `ws` must stay OUT of the main chunk and inside the asar instead. Vite replaces
// its unresolvable optional peer dependencies with empty stubs, so a bundled copy
// throws "TypeError: bufferUtil.mask is not a function" on the first outbound
// frame — measured, see desktop/main/tools/tool-link.ts's PACKAGING CONTRACT.
// It is a runtime dependency, so @electron/packager keeps it in the asar.
//
// `node-pty` is external for a different reason: it resolves a `.node` binary at
// runtime, which Vite would try to inline. AutoUnpackNativesPlugin unpacks those
// binaries beside the asar so the require finds them.
export default defineConfig({
  define: {
    PORTAL_DESKTOP_BUILD: JSON.stringify(`${revision} · ${new Date().toISOString()}`),
    PORTAL_DESKTOP_UPDATE_REPOSITORY: JSON.stringify(process.env.PORTAL_DESKTOP_UPDATE_REPOSITORY || 'd5z/portal-desktop'),
  },
  build: { rollupOptions: { external: ['electron', 'node-pty', 'ws'] } },
});
