export interface Connection { endpoint: string; being: string; token: string; relaySecret: string; link: string }

export function parseConnection(input: string): Connection {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error('请输入完整的 Being 链接。'); }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('Being 链接必须使用 HTTPS（本机调试可用 HTTP）。');
  }
  if (url.username || url.password || !/^\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname)) {
    throw new Error('链接格式应为 https://host/being/?token=…');
  }
  const token = url.searchParams.get('token') || '';
  // Portal parses token verbatim rather than URL-decoding it. Restrict to URL-safe tokens.
  if (!/^[a-zA-Z0-9._~-]{1,2048}$/.test(token)) throw new Error('链接缺少有效的 token。');
  const being = url.pathname.replaceAll('/', '');
  const loom = `${url.origin}/${being}`;
  // BeingDesktop 0.8.x addresses may carry `api=` when Loom and the Being API are
  // served from different paths of one origin (BeingDesktop src/security.cjs
  // parseConnection, 2026-09-16). It moves the API base only; the token must never
  // reach another site, so the origin has to match and the value carries no query,
  // fragment or credentials of its own.
  const api = url.searchParams.get('api');
  let endpoint = loom;
  if (api) {
    let target: URL;
    try { target = new URL(api); } catch { throw new Error('链接中的 api 参数必须是同源的完整地址。'); }
    if (target.origin !== url.origin || target.search || target.hash || target.username || target.password) {
      throw new Error('Loom 和 API 必须位于同一来源，避免将连接凭据发送到其他网站。');
    }
    endpoint = target.href.replace(/\/+$/, '');
  }
  const relaySecret = url.searchParams.get('relay_secret') || url.searchParams.get('secret') || token;
  if (/[\r\n]/.test(relaySecret)) throw new Error('无效的 relay secret。');
  // The link is the Loom address Portal connects to and is written to disk as
  // `connection.url`: it deliberately carries no relay secret.
  return { endpoint, being, token, relaySecret, link: `${loom}/?token=${token}` };
}

/** BeingDesktop 0.8.x stores the connection address itself, normalized the same
 * way (fragment removed, every other parameter verbatim), so a settings.json
 * written here stays readable by BeingDesktop's own parseConnection. */
export function connectionCredential(input: string): string {
  parseConnection(input);
  const url = new URL(input.trim());
  url.hash = '';
  return url.href;
}

export function redact(text: string, secrets: string[] = []): string {
  let safe = text.replace(/\u001b\[[0-9;]*m/g, '');
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) safe = safe.split(secret).join('[redacted]');
  return safe.replace(/((?:token|secret|api_key)=)[^\s&"']+/gi, '$1[redacted]');
}
