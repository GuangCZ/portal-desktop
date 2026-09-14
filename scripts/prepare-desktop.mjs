import { writeRuntimeBundle } from './runtime-bundle.mjs';
import { mkdir, copyFile, access, chmod } from 'node:fs/promises';
import path from 'node:path';
import './build-chat.mjs';
import { portalSource } from './portal-source.mjs';

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
console.log('Prepared local Loom assets (no CDN requests).');
