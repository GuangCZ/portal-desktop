// The one text redaction the whole main process shares; 2026-09-16.
//
// Ported from BeingDesktop 0.8.26 src/services.cjs `sanitizeText` (lines 12-37).
// Four migration units each carried their own copy of it — `chat/titles.ts`,
// `town/channel/sanitize.ts`, `town/session/sanitize.ts` and
// `orchestration/vendored.ts` — and a byte comparison of the four bodies found
// them equivalent (the only textual difference was `match =>` against
// `(match) =>`). The copies are gone; this is the implementation.
//
// docs/architecture.md §6.3: logs, activity records, diagnostics exports and IPC
// error prose all pass through here, so a secret that survives this function
// reaches disk and the renderer.
//
// The `secrets` parameter takes the widest of the four signatures on purpose:
// `readonly unknown[]` accepts every caller the copies had (`string[]`,
// `unknown[]`), and non-string members are skipped rather than coerced, exactly
// as 0.8.26 does.
export function sanitizeText(value: unknown, secrets: readonly unknown[] = []): string {
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
