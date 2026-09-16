// Ported from BeingDesktop src/security.cjs (parseConnection, sessionPartition) on 2026-09-16.
// The partition string is an identity fingerprint: every field that can change the
// authenticated Being must take part, or a stale session could be reused.
import { createHash } from 'node:crypto';

export interface LoomConnection {
  url: string;
  apiBase: string;
  token: string;
  secret: string;
  displayUrl: string;
  beingName: string;
}

const SESSION_IDENTITY_VERSION = 'v1';

export function parseConnection(input: unknown): LoomConnection {
  if (typeof input !== 'string' || input.length > 8192) throw new Error('请输入有效的 Loom 连接地址。');
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error('连接地址格式不正确。'); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local)) || url.username || url.password) {
    throw new Error('Loom 地址须使用 HTTPS；本机回环地址可使用 HTTP。');
  }
  url.hash = '';
  const api = new URL(url.searchParams.get('api') || `${url.origin}${url.pathname.replace(/\/+$/, '')}`);
  if (api.origin !== url.origin || api.search || api.hash || api.username || api.password) {
    throw new Error('Loom 和 API 必须位于同一来源，避免将连接凭据发送到其他网站。');
  }
  const token = url.searchParams.get('token') || '';
  const secret = url.searchParams.get('relay_secret') || url.searchParams.get('secret') || token;
  return {
    url: url.href,
    apiBase: api.href.replace(/\/+$/, ''),
    token,
    secret,
    displayUrl: `${url.origin}${url.pathname}`,
    beingName: decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || 'Being'),
  };
}

export function sessionPartition(connection: LoomConnection): string {
  const identity = JSON.stringify([SESSION_IDENTITY_VERSION, connection.displayUrl, connection.apiBase, connection.token, connection.secret]);
  return `persist:loom-${SESSION_IDENTITY_VERSION}-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}
