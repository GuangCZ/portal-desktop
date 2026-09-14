import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import signing from '../../macos-signing.json';

const execute = promisify(execFile);
export const macDmgIdentifier = `${signing.clientIdentifier}.dmg`;
export async function verifyMacSignature(file: string, identifier: string) {
  if (![signing.clientIdentifier, signing.portalIdentifier, macDmgIdentifier].includes(identifier)) throw new Error('Unknown macOS signing identifier.');
  const requirement = `=anchor apple generic and identifier "${identifier}" and certificate leaf[subject.OU] = "${signing.teamId}" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists`;
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', requirement, file], { timeout: 30_000 });
  const result = await execute('/usr/bin/codesign', ['--display', '--verbose=4', file], { timeout: 30_000 });
  const details = result.stdout + result.stderr;
  const timestamp = /^Timestamp=(.+)$/m.exec(details)?.[1].trim();
  if (!timestamp || timestamp.toLowerCase() === 'none') throw new Error('Release signature is missing a secure timestamp.');
  // Disk images contain signed applications but do not themselves execute code.
  if (identifier !== macDmgIdentifier && !/^CodeDirectory .+flags=.+\(.*runtime.*\)/m.test(details)) throw new Error('Release signature is missing hardened runtime.');
}
