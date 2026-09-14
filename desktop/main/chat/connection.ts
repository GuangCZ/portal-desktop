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
  const endpoint = `${url.origin}/${being}`;
  const relaySecret = url.searchParams.get('relay_secret') || url.searchParams.get('secret') || token;
  if (/[\r\n]/.test(relaySecret)) throw new Error('无效的 relay secret。');
  return { endpoint, being, token, relaySecret, link: `${endpoint}/?token=${token}` };
}

export function redact(text: string, secrets: string[] = []): string {
  let safe = text.replace(/\u001b\[[0-9;]*m/g, '');
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) safe = safe.split(secret).join('[redacted]');
  return safe.replace(/((?:token|secret|api_key)=)[^\s&"']+/gi, '$1[redacted]');
}
