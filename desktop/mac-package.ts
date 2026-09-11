import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import { command } from './background';
import { loadRuntimeBundle } from './runtime-update';
import { verifyMacSignature } from './mac-signature';
import signing from './macos-signing.json';

export async function macInstallLocation(executable: string) {
  const current = path.resolve(executable, '../../..');
  if (!current.endsWith('.app')) throw new Error('无法识别当前 macOS 应用目录。');
  if ((await realpath(current)).includes('/AppTranslocation/')) {
    throw new Error('请先将 Portal Desktop 放入“应用程序”文件夹，再从该位置打开并更新。');
  }
  try { await access(path.dirname(current), constants.W_OK); }
  catch { throw new Error('当前应用目录不可写。请将 Portal Desktop 移到可写的应用程序目录后重试，原服务未停止。'); }
  return current;
}

// Check the whole application before stopping the old client, including assets
// outside the Portal executable's separate checksum manifest.
export async function validateMacApp(candidate: string, version: string) {
  const plist = JSON.parse(await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(candidate, 'Contents/Info.plist')]));
  if (plist.CFBundleIdentifier !== signing.clientIdentifier || plist.CFBundleExecutable !== 'Portal Desktop' ||
      plist.CFBundleShortVersionString !== version || plist.CFBundleVersion !== version) {
    throw new Error('安装包版本或应用标识不匹配。');
  }
  const executable = path.join(candidate, 'Contents/MacOS', plist.CFBundleExecutable);
  await access(executable, constants.X_OK);
  const { bundle, binary } = await loadRuntimeBundle(path.join(candidate, 'Contents/Resources'));
  if (bundle.clientVersion !== version) throw new Error('安装包内 Portal 与客户端版本不匹配。');
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch;
  for (const file of [executable, binary]) {
    const architectures = (await command('/usr/bin/lipo', ['-archs', file])).trim().split(/\s+/);
    if (!architectures.includes(arch)) throw new Error('安装包的可执行文件不支持当前 Mac 架构。');
  }
  try {
    await verifyMacSignature(candidate, signing.clientIdentifier);
    await verifyMacSignature(binary, signing.portalIdentifier);
  } catch { throw new Error('macOS 应用或 Portal 的发布签名校验失败，原服务未停止。请下载由官方 Developer ID 签发的完整安装包。'); }
  return bundle;
}
