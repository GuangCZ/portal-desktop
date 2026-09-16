// Ported line for line from BeingDesktop 0.8.26 src/session-titles.cjs (69 lines);
// 2026-09-16. `sanitizeText` comes from BeingDesktop src/services.cjs lines 12-37
// and is carried here verbatim so the redaction the title input relies on does not
// change shape during the port; it merges into a shared redaction module later.
import { createHash } from 'node:crypto';
import type { SessionSummary, SessionTitlesOptions, TitleRow, TitleStore } from './store-types';

/** BeingDesktop src/services.cjs `sanitizeText`: strips ANSI, named secrets, URL
 * credentials and queries, auth headers, key/value secrets and long opaque blobs. */
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

export const defaultTitle = (title: string): boolean => !title || /^(?:新会话|新任务|会话 \d+)$/.test(title);
const eligible = (session: SessionSummary): boolean => !session.titleSource && defaultTitle(session.title);
const RETRY_MS = 5 * 60 * 1000;

// Only conversation text crosses into the title worker. Transports, tool payloads,
// image bytes and Desktop execution context are not part of this input.
export function titleInput(rows: readonly TitleRow[]): string {
  const messages = rows.filter((row): row is TitleRow & { role: string; content: string } =>
    typeof row.role === 'string' && ['user', 'being'].includes(row.role) && typeof row.content === 'string' && Boolean(row.content.trim()));
  if (!messages.some(row => row.role === 'user')) return '';
  return sanitizeText(messages.slice(0, 6).map(row => `${row.role}: ${row.content.slice(0, 1200)}`).join('\n')).slice(0, 4000);
}

export class SessionTitles {
  readonly getStore: () => TitleStore | null;
  readonly available: () => string;
  readonly generate: (sessionId: string, input: string) => Promise<unknown>;
  readonly changed: () => void;
  readonly delay: number;
  attempts = new Map<string, { fingerprint: string; at: number }>();
  epoch = 0;
  running = false;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined = undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined = undefined;

  constructor({ getStore, available, generate, changed, delay = 500 }: SessionTitlesOptions) {
    this.getStore = getStore;
    this.available = available;
    this.generate = generate;
    this.changed = changed;
    this.delay = delay;
  }

  reset() {
    this.epoch++;
    clearTimeout(this.timer); clearTimeout(this.retryTimer);
    this.timer = undefined; this.retryTimer = undefined;
    this.attempts.clear(); this.dirty = false;
  }

  schedule() {
    if (this.running) { this.dirty = true; return; }
    if (this.timer || !this.getStore() || !this.available()) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.run().catch(() => {}); }, this.delay);
    this.timer.unref?.();
  }

  async run() {
    if (this.running) return;
    const store = this.getStore(), epoch = this.epoch;
    if (!store || !this.available()) return;
    this.running = true; this.dirty = false;
    try {
      for (const session of store.summary().sessions) {
        if (epoch !== this.epoch || store !== this.getStore() || !this.available()) break;
        const latest = store.summary().sessions.find(item => item.id === session.id);
        if (!latest || !eligible(latest)) continue;
        const input = titleInput(store.rows(session.id));
        if (!input) continue;
        const fingerprint = createHash('sha256').update(String(this.available()) + input).digest('hex');
        const prior = this.attempts.get(session.id);
        if (prior?.fingerprint === fingerprint && Date.now() - prior.at < RETRY_MS) continue;
        this.attempts.set(session.id, { fingerprint, at: Date.now() });
        let title: unknown;
        try { title = await this.generate(session.id, input); } catch { continue; }
        if (epoch !== this.epoch || store !== this.getStore()) break;
        const current = store.summary().sessions.find(item => item.id === session.id);
        if (!current || !eligible(current) || current.title !== session.title || typeof title !== 'string' || !title.trim() || title.length > 80 || /[\x00-\x1f\x7f]/.test(title)) continue;
        store.rename(session.id, title.trim(), { source: 'auto' });
        await store.touch();
        this.changed();
      }
    } finally {
      this.running = false;
      if (this.dirty) this.schedule();
      clearTimeout(this.retryTimer); this.retryTimer = undefined;
      const delays = (this.getStore()?.summary().sessions || []).filter(eligible)
        .map(session => this.attempts.get(session.id)).filter(Boolean).map(attempt => Math.max(1000, RETRY_MS - (Date.now() - attempt!.at)));
      if (delays.length && this.available()) {
        this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.schedule(); }, Math.min(...delays));
        this.retryTimer.unref?.();
      }
    }
  }
}
