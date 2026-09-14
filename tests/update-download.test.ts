import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadUpdateFile, stageInstaller } from '../desktop/main/updates/manual-installer';

const roots: string[] = [];
const temporary = async () => { const root = await mkdtemp(path.join(os.tmpdir(), 'portal-download-')); roots.push(root); return root; };
afterEach(async () => {
  for (const root of roots.splice(0)) {
    expect(path.dirname(path.resolve(root))).toBe(path.resolve(os.tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
});

it('reports streamed bytes before completion and verifies the same bytes written to disk', async () => {
  const root = await temporary(), file = path.join(root, 'asset');
  const progress: { received: number; total?: number }[] = [];
  const fetcher = (async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(Buffer.from('ab')); controller.enqueue(Buffer.from('cdef')); controller.close();
  } }), { headers: { 'Content-Length': '6' } })) as typeof fetch;
  const digest = await downloadUpdateFile('https://fixture/asset', file, 100, fetcher,
    (received, total) => progress.push({ received, total }));
  expect(progress).toContainEqual({ received: 2, total: 6 });
  expect(progress.at(-1)).toEqual({ received: 6, total: 6 });
  expect(await readFile(file, 'utf8')).toBe('abcdef');
  expect(digest).toBe(createHash('sha256').update('abcdef').digest('hex'));
});

it('reports bytes without inventing a percentage when Content-Length is missing', async () => {
  const progress: { received: number; total?: number }[] = [];
  await downloadUpdateFile('https://fixture/asset', path.join(await temporary(), 'asset'), 100,
    (async () => new Response('abc')) as typeof fetch,
    (received, total) => progress.push({ received, total }));
  expect(progress.at(-1)).toEqual({ received: 3, total: undefined });
});

it('cancels a stalled response body instead of waiting for its next chunk', async () => {
  const abort = new AbortController();
  let cancelled = false;
  const result = downloadUpdateFile('https://fixture/asset', path.join(await temporary(), 'asset'), 100,
    (async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from('abc')); },
      cancel() { cancelled = true; },
    }))) as typeof fetch,
    received => { if (received === 3) abort.abort(); }, abort.signal);
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  expect(cancelled).toBe(true);
});

it.skipIf(process.platform !== 'win32')('cleans cancelled staging and never produces a ready installer', async () => {
  const root = await temporary(), abort = new AbortController();
  const payload = Buffer.from('partial download');
  const manifest = `${createHash('sha256').update(payload).digest('hex')}  portal-desktop-9.8.7-windows-x64-Setup.exe`;
  const phases: string[] = [];
  const fetcher = (async url => String(url).endsWith('SHA256SUMS.txt') ? new Response(manifest)
    : new Response(new ReadableStream({ start(controller) { controller.enqueue(payload); } }))) as typeof fetch;
  await expect(stageInstaller(root, '9.8.7', 'fixture/releases', process.execPath, fetcher, {
    signal: abort.signal, onProgress: progress => {
      phases.push(progress.phase);
      if (progress.received) abort.abort();
    },
  })).rejects.toMatchObject({ name: 'AbortError' });
  expect(phases).toContain('downloading');
  expect(phases).not.toContain('preparing');
  expect(await readdir(path.join(root, 'client-updates'))).toEqual([]);
});

it.skipIf(process.platform !== 'win32')('does not prepare an installer after a checksum mismatch', async () => {
  const root = await temporary(), phases: string[] = [];
  const fetcher = (async url => new Response(String(url).endsWith('SHA256SUMS.txt')
    ? `${'0'.repeat(64)}  portal-desktop-9.8.7-windows-x64-Setup.exe` : 'corrupt')) as typeof fetch;
  await expect(stageInstaller(root, '9.8.7', 'fixture/releases', process.execPath, fetcher,
    { onProgress: progress => { phases.push(progress.phase); } })).rejects.toThrow('校验失败');
  expect(phases).toContain('verifying');
  expect(phases).not.toContain('preparing');
  expect(await readdir(path.join(root, 'client-updates'))).toEqual([]);
});
