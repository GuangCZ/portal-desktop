import { writeRuntimeBundle } from './runtime-bundle.mjs';
import { mkdir, copyFile, access, chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { portalSource } from './portal-source.mjs';

// `desktop/generated` is the renderer's publicDir (vite.renderer.config.ts), so
// whatever lands here is copied beside the packaged shell. Until 2026-09-16 it
// also held the compiled Loom document; that went with the iframe, but the
// shell still bundles these libraries and has to ship their notices.
const generated = path.resolve('desktop/generated');
await mkdir(generated, { recursive: true });
const notices = [];
// The four runtime dependencies added by the I0 seam stage on 2026-09-16 ship
// inside the asar whether or not a chunk imports them, so their notices belong
// here too: `ws` (the tool bridge's relay socket), `node-pty` (the interactive
// terminal) and the two `@xterm` packages the terminal panel renders with.
for (const [name, file] of [['marked', 'LICENSE.md'], ['highlight.js', 'LICENSE'],
  ['react', 'LICENSE'], ['react-dom', 'LICENSE'], ['scheduler', 'LICENSE'],
  ['ws', 'LICENSE'], ['node-pty', 'LICENSE'],
  ['@xterm/xterm', 'LICENSE'], ['@xterm/addon-fit', 'LICENSE']]) {
  notices.push(`${name}\n${await readFile(path.join('node_modules', name, file), 'utf8')}`);
}
await writeFile(path.join(generated, 'THIRD-PARTY-LICENSES.txt'), notices.join('\n\n---\n\n'));

const binaryName = process.platform === 'win32' ? 'heart-portal.exe' : 'heart-portal';
const destination = path.resolve('resources', binaryName);
await mkdir('resources', { recursive: true });
try { await access(destination); }
catch {
  const source = path.join(portalSource, 'target/release', binaryName);
  try { await copyFile(source, destination); if (process.platform !== 'win32') await chmod(destination, 0o755); }
  catch { console.log('Portal binary not found. Chat is available; run npm run build:portal to bundle the local engine.'); }
}
try { await access(destination); await writeRuntimeBundle(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
console.log('Prepared local desktop assets (no CDN requests).');
