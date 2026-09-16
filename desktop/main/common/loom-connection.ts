// The Loom address as BeingDesktop 0.8.26 parses it, and the identity string it
// hashes into; 2026-09-16.
//
// Ported line by line from BeingDesktop 0.8.26 src/security.cjs. Two migration
// units arrived with their own copies — `tools/security.ts` and
// `town/channel/loom-connection.ts` — and a byte comparison of the two found
// `parseConnection` differing only by a trailing comma and `sessionPartition`
// identical; both copies are gone and this is the implementation.
//
// `sessionPartition` is a DISK FORMAT, not an implementation detail. It names the
// Electron session partition of the Loom page, the session-recovery file
// (`chat/session-recovery.ts`), the conversation cache file, the feature-task
// buckets, the worker directories and the TownClientStore keys. Reproduce it byte
// for byte or a 0.8.x profile's state becomes invisible and is written again
// under a new name. `tests/identity-partition.test.ts` pins it against
// `chat/connection.ts`'s `beingIdentityKey`, which computes the same string
// starting from the saved address rather than from a parsed connection.
//
// See docs/architecture.md §7「安全模型与边界」: parseConnection accepts HTTPS
// only (loopback may use HTTP), forbids URL credentials, and requires the `api`
// parameter to stay same-origin; endpoint() exposes three read-only routes.
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

/** The four fields that take part in the identity. Narrower than `LoomConnection`
 * so `chat/session-recovery.ts`'s `RecoveryConnection` — which is exactly these
 * four — can be partitioned without inventing a `url` and a `beingName`. */
export type ConnectionIdentity = Pick<LoomConnection, 'displayUrl' | 'apiBase' | 'token' | 'secret'>;

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

export function sessionPartition(connection: ConnectionIdentity): string {
  const identity = JSON.stringify([SESSION_IDENTITY_VERSION, connection.displayUrl, connection.apiBase, connection.token, connection.secret]);
  return `persist:loom-${SESSION_IDENTITY_VERSION}-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
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

export function allowedNavigation(connection: Pick<LoomConnection, 'url'>, target: string): boolean {
  try {
    const expected=new URL(connection.url);
    const actual=new URL(target);
    return actual.origin===expected.origin && actual.pathname.replace(/\/+$/,'')===expected.pathname.replace(/\/+$/,'');
  } catch { return false; }
}
