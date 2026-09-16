// Ported from BeingDesktop src/being-chat.cjs (MESSAGES, fail) on 2026-09-16.
// Codes and Chinese wording are load-bearing: renderer and tests match on them.

export const CHAT_MESSAGES: Record<string, string> = {
  NOT_CONNECTED: '请先连接 Being。',
  SESSION_CHANGED: 'Being 连接已变化，旧请求已取消。',
  INVALID_REQUEST: '请求参数无效。',
  INVALID_RESPONSE: 'Being 返回格式无效。',
  NETWORK_ERROR: '与 Being 的连接中断，请稍后重试。',
  SERVICE_ERROR: 'Being 服务暂时不可用。',
  AUTH_REQUIRED: 'Being 连接凭据无效，请重新连接。',
  ABORTED: '请求已取消。',
  RESULT_UNKNOWN: '发送结果未确认，请刷新后核对再决定是否重发。',
};

/** An Error carrying the stable machine-readable code the renderer switches on. */
export interface CodedError extends Error { code: string }

export const codedError = (code: string, message: string): CodedError =>
  Object.assign(new Error(message), { code });

export const chatFail = (code: string): CodedError =>
  codedError(code, CHAT_MESSAGES[code] || CHAT_MESSAGES.SERVICE_ERROR);

export const errorCode = (error: unknown): string =>
  error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : '';
