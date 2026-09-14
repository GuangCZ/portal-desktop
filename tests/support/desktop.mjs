import path from 'node:path';
import { access, readFile } from 'node:fs/promises';

export async function desktopExecutable() {
  const { productName } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const executable = process.env.PORTAL_DESKTOP_EXECUTABLE || (process.platform === 'darwin'
    ? path.resolve(`out/${productName}-darwin-${process.arch}/${productName}.app/Contents/MacOS/${productName}`)
    : path.resolve(`out/${productName}-${process.platform}-${process.arch}`, process.platform === 'win32' ? 'portal-desktop.exe' : 'portal-desktop'));
  try { await access(executable); }
  catch { throw new Error(`客户端测试包不存在，请先运行 npm run package：${executable}`); }
  return executable;
}

export function backgroundCoverage() {
  if (process.env.PORTAL_DESKTOP_TEST_BACKGROUND === '0') return { enabled: false, reason: 'PORTAL_DESKTOP_TEST_BACKGROUND=0：当前运行环境不执行真实系统登录服务测试' };
  if (process.platform !== 'darwin') return { enabled: false, reason: '本桌面 E2E 的系统登录服务分支仅支持 macOS；Windows 真实计划任务与 Portal 安装升级由 test:windows-upgrade 和 native upgrade tests 单独验证' };
  return { enabled: true };
}
