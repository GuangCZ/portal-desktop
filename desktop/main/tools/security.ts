// Ported line by line from BeingDesktop 0.8.26 src/security.cjs on 2026-09-16.
// See docs/architecture.md §7「安全模型与边界」: parseConnection accepts HTTPS
// only (loopback may use HTTP), forbids URL credentials and requires the `api`
// parameter to stay same-origin; endpoint() exposes three read-only routes.
import path from 'node:path';
import { createHash } from 'node:crypto';

const SESSION_IDENTITY_VERSION = 'v1';

export interface LoomConnection {
  url: string;
  apiBase: string;
  token: string;
  secret: string;
  displayUrl: string;
  beingName: string;
}

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
  return {url: url.href, apiBase: api.href.replace(/\/+$/, ''), token, secret,
    displayUrl: `${url.origin}${url.pathname}`, beingName: decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || 'Being')};
}

export function endpoint(connection: Pick<LoomConnection, 'apiBase' | 'token'>, route: string): string {
  if (!['/api/status','/api/llm/config','/api/stream/active'].includes(route)) throw new Error('Unsupported read endpoint');
  const url = new URL(connection.apiBase + route);
  if (connection.token) url.searchParams.set('token', connection.token);
  return url.href;
}

export function publicModelUrl(value: string): string {
  try { const u = new URL(value); return `${u.origin}${u.pathname}`; } catch { return ''; }
}

export function protocolFile(root: string, rawUrl: string): string {
  const u = new URL(rawUrl);
  if (u.protocol !== 'being:' || u.hostname !== 'app') throw new Error('Unknown app resource');
  const relative = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error('Invalid resource path');
  return resolved;
}

export function sessionPartition(connection: LoomConnection): string {
  const identity = JSON.stringify([SESSION_IDENTITY_VERSION, connection.displayUrl, connection.apiBase, connection.token, connection.secret]);
  return `persist:loom-${SESSION_IDENTITY_VERSION}-${createHash('sha256').update(identity).digest('hex').slice(0,32)}`;
}

export function allowedNavigation(connection: Pick<LoomConnection, 'url'>, target: string): boolean {
  try {
    const expected=new URL(connection.url);
    const actual=new URL(target);
    return actual.origin===expected.origin && actual.pathname.replace(/\/+$/,'')===expected.pathname.replace(/\/+$/,'');
  } catch { return false; }
}
