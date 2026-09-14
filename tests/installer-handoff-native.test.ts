import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

it.skipIf(process.platform !== 'win32')('runs the Windows installer worker after its client parent exits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portal-handoff 中文 ' "));
  const entry = path.join(root, 'parent.cjs'), marker = path.join(root, 'worker-completed');
  try {
    await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
      import { stageInstaller } from './desktop/manual-installer';
      import { createHash } from 'node:crypto';
      import { readdir, writeFile } from 'node:fs/promises';
      import path from 'node:path';
      (async () => {
        const root = process.argv[2], asset = 'portal-desktop-9.8.7-windows-x64-Setup.exe';
        const payload = Buffer.from('fixture payload');
        const sums = createHash('sha256').update(payload).digest('hex') + '  ' + asset;
        const handoff = await stageInstaller(root, '9.8.7', 'fixture/releases', process.execPath,
          async url => new Response(url.endsWith('SHA256SUMS.txt') ? sums : payload));
        const updates = path.join(root, 'client-updates');
        const script = path.join(updates, (await readdir(updates))[0], 'install.ps1');
        const quote = value => "'" + value.replaceAll("'", "''") + "'";
        // Only the installer body is a fixture. Production staging and worker
        // launch must execute it in a process that survives this parent.
        await writeFile(script, '\\ufeff$ErrorActionPreference="Stop"; Wait-Process -Id ' + process.pid +
          ' -Timeout 20 -ErrorAction SilentlyContinue; if (Get-Process -Id ' + process.pid +
          ' -ErrorAction SilentlyContinue) { exit 1 }; [IO.File]::WriteAllText(' + quote(path.join(root, 'worker-completed')) + ', "survived")');
        await handoff();
      })().catch(error => { console.error(error); process.exitCode = 1; });
    ` }, outfile: entry, bundle: true, platform: 'node', format: 'cjs', loader: { '.py': 'text' } });
    await promisify(execFile)(process.execPath, [entry, root], { windowsHide: true, timeout: 30_000 });
    const deadline = Date.now() + 10_000;
    let content = '';
    while (Date.now() < deadline) {
      content = await readFile(marker, 'utf8').catch(() => '');
      if (content) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(content).toBe('survived');
  } finally {
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}, 45_000);
