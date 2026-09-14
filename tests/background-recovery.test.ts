import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { unixRunner } from '../desktop/main/portal/background';
const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(error: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-recovery-')); roots.push(root);
  await writeFile(path.join(root, 'connection.url'), 'http://127.0.0.1:1/fixture/?token=fixture');
  await writeFile(path.join(root, 'heart-portal'), `#!/bin/sh\nprintf x >> attempts\nprintf '%s' '${error}' >&2\nexit 1\n`, { mode: 0o700 });
  await writeFile(path.join(root, 'run.sh'), unixRunner(root, path.join(root, 'portal.toml'), {
    endpoint: '', being: '', hasToken: true, portalName: 'fixture', portalBinary: path.join(root, 'heart-portal'),
    workspace: root, autoStart: false, backgroundEnabled: true, allowExec: false, kitsEnabled: false,
  }));
  const run = async () => execute('/bin/sh', [path.join(root, 'run.sh')]).then(() => 0, error => error.code);
  return { root, run };
}

it.skipIf(process.platform !== 'darwin')('halts after one conflicting engine attempt even if the system keeps invoking the runner', async () => {
  const f = await fixture('another Portal instance is already running for this relay/Being');
  expect(await f.run()).toBe(1);
  for (let i = 0; i < 8; i++) expect(await f.run()).toBe(0);
  expect(await readFile(path.join(f.root, 'attempts'), 'utf8')).toBe('x');
  expect(await readFile(path.join(f.root, '.portal-start-failure'), 'utf8')).toBe('conflict');
});

it.skipIf(process.platform !== 'darwin')('allows five rapid crash retries then stops and preserves the last error', async () => {
  const f = await fixture('configuration failed');
  for (let i = 0; i < 6; i++) expect(await f.run()).toBe(1);
  for (let i = 0; i < 3; i++) expect(await f.run()).toBe(0);
  expect(await readFile(path.join(f.root, 'attempts'), 'utf8')).toBe('xxxxxx');
  expect(await readFile(path.join(f.root, '.portal-start-failure'), 'utf8')).toBe('crash-limit');
  expect(await readFile(path.join(f.root, 'portal.err.log'), 'utf8')).toBe('configuration failed');
});

it.skipIf(process.platform !== 'darwin')('resets the retry budget after a stable run', async () => {
  const f = await fixture('temporary failure');
  await writeFile(path.join(f.root, '.portal-start-attempt'), `${Math.floor(Date.now() / 1000) - 61} 6`);
  expect(await f.run()).toBe(1);
  expect(await readFile(path.join(f.root, 'attempts'), 'utf8')).toBe('x');
  expect((await readFile(path.join(f.root, '.portal-start-attempt'), 'utf8')).trim().split(' ')[1]).toBe('1');
});
