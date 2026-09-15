// Ported line by line from BeingDesktop 0.8.26 src/desktop-identity.cjs; 2026-09-16.
// The Desktop ID is the persistent identity of one profile: it names this
// desktop's tool bridge on the Portal relay (BeingDesktop docs/interfaces.md
// §6.2「桌面工具桥」) and is carried by native chat requests, so it must survive
// restarts, differ per profile, and never be replaced silently.
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validDesktopId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function desktopPortalName(id: unknown): string {
  if (!validDesktopId(id)) throw new Error('Desktop 身份无效。');
  return 'being-desktop-tools-' + id.toLowerCase();
}

export async function loadDesktopId(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'desktop-id.json');
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (!validDesktopId(value?.desktopId)) throw new Error('Invalid identity');
    return value.desktopId.toLowerCase();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Desktop 身份文件无法读取，原文件已保留。');
  }
  const desktopId = randomUUID();
  const temporary = `${file}.${desktopId}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ desktopId }) + '\n', { mode: 0o600, flag: 'wx' });
    // Publish a complete file without replacing a concurrently created identity.
    try { await link(temporary, file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return await loadDesktopId(directory);
      throw error;
    }
  } finally { await rm(temporary, { force: true }); }
  return desktopId;
}
