/** What every channel but `QUIT_ALLOWED` answers once the client is on its way
 * out (desktop/main/app/ipc.ts). It lives here because the renderer has to
 * recognise it — a push that arrives during a shutdown must not be chased with a
 * read that can only be refused — and the renderer may not import main-process
 * code (tests/architecture.test.ts). One constant, two readers, no drift. */
export const QUITTING_MESSAGE = '客户端正在退出，请稍候。';

/** Whether a failure is that refusal, whichever layer wrapped it. Electron
 * prefixes a rejected invoke with `Error invoking remote method '…': Error: `,
 * so the sentence is matched inside the message rather than against it. */
export const isQuittingRefusal = (error: unknown): boolean =>
  String((error as { message?: unknown } | null | undefined)?.message ?? '').includes(QUITTING_MESSAGE);

/** Only short guidance crosses into notices, dialogs and form errors. */
export function publicErrorMessage(error: unknown, fallback = '操作未完成，请重试或查看日志。'): string {
  const message = String(error instanceof Error ? error.message : error)
    .replace(/^(?:Error: )?Error invoking remote method '[^']+': Error: /, '')
    .replace(/^Error:\s*/, '').trim();
  if (/Failed to get '(?:appData|userData|sessionData)' path/i.test(message)) return '客户端配置目录不可用，请检查系统用户目录后重试。';
  if (/Config file not found:\s*status|不支持状态命令/.test(message)) return '旧 Portal 版本不兼容，请停止旧实例后重试。';
  if (/powershell(?:\.exe)?[^\n]*(?:ENOENT|not found)|(?:ENOENT|not found)[^\n]*powershell/i.test(message)) return 'Windows 命令环境不可用，请检查后重试。';
  if (/EACCES|EPERM|Access is denied|访问被拒绝|权限不足/i.test(message)) return '权限不足，请检查文件或系统权限后重试。';
  if (/ENOENT|Config file not found:/i.test(message)) return '所需文件不存在，请检查配置后重试。';
  if (/ETIMEDOUT|timed out|超时/i.test(message)) return '操作超时，请稍后重试。';
  if (!message || message.length > 110 || /[\r\n]|CLIXML|<Objs?\b|<S\s|_x[0-9a-f]{4}_|FullyQualifiedErrorId|CategoryInfo|RuntimeException|\bspawn\b|[a-z]:[\\/]|\\\\|\bat\s+\S+\(/i.test(message)) return fallback;
  return message;
}
