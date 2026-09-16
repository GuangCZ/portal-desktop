// Ported from BeingDesktop src/services.cjs (sanitizeText) on 2026-09-16.
// Any text that can reach the renderer passes through here: secrets, credentials
// inside URLs, headers and control characters must not survive.

export function sanitizeText(value: unknown, secrets: unknown[] = []): string {
  let text = String(value ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('[redacted]');
  }
  text = text.replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi, (match) => {
    try {
      const url = new URL(match);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch { return '[redacted URL]'; }
  });
  text = text
    .replace(/\b(?:Cookie|Set-Cookie|Authorization|Proxy-Authorization)\s*:[^\r\n]*/gi, '[redacted header]')
    .replace(/\bBearer\s+[^\s,"']+/gi, 'Bearer [redacted]')
    .replace(/(["']?(?:[\w-]*(?:token|secret|password|credential)[\w-]*|api[_-]?key|key|authorization|cookie|set-cookie)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, '$1[redacted]')
    .replace(/\bsk-[a-z0-9_-]+\b/gi, '[redacted]')
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)?\b/g, '[redacted]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[redacted]')
    .replace(/\b[a-zA-Z0-9_+/=-]{48,}\b/g, '[redacted]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return text.slice(0, 2000);
}
