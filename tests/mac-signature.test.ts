import { expect, it } from 'vitest';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { command } from '../desktop/main/portal/background';
import { verifyMacSignature } from '../desktop/main/updates/mac-signature';
import signing from '../desktop/macos-signing.json';

it('keeps the Portal signing identity and identifier aligned with the pinned upstream signer', async () => {
  const script = await readFile('heart-portal/scripts/package-portal-macos.py', 'utf8');
  expect(script).toContain(`IDENTITY = '${signing.identity}'`);
  expect(script).toContain(`IDENTIFIER = '${signing.portalIdentifier}'`);
  expect(script).toContain(`certificate leaf[subject.OU] = "${signing.teamId}"`);
});

it.skipIf(process.platform !== 'darwin')('rejects an intact ad hoc signature even with the correct Portal identifier', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-signature-policy-'));
  try {
    const binary = path.join(root, 'fixture');
    await copyFile('/usr/bin/true', binary);
    await command('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--options', 'runtime', '--identifier', signing.portalIdentifier, binary]);
    await command('/usr/bin/codesign', ['--verify', '--strict', binary]);
    await expect(verifyMacSignature(binary, signing.portalIdentifier)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
