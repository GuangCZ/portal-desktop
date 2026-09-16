// Ported from BeingDesktop src/being-chat.cjs (consumeEvents) on 2026-09-16.
// A truncated trailing event is discarded on purpose; history reconciliation recovers it.
import { chatFail } from './errors';

const MAX_BYTES = 4 * 1024 * 1024;

export type SseData = Record<string, any>;
export type SseHandler = (type: string, data: SseData) => void;

export async function consumeEvents(body: ReadableStream<Uint8Array> | null | undefined, onEvent: SseHandler): Promise<void> {
  if (!body) throw chatFail('INVALID_RESPONSE');
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '', type = '', data: string[] = [], size = 0;
  const flush = () => {
    if (data.length) {
      let parsed: unknown;
      try { parsed = JSON.parse(data.join('\n')); } catch { throw chatFail('INVALID_RESPONSE'); }
      onEvent(type || 'message', (parsed ?? {}) as SseData);
    }
    type = ''; data = []; size = 0;
  };
  const line = (value: string) => {
    if (!value) return flush();
    size += value.length;
    if (size > MAX_BYTES) throw chatFail('INVALID_RESPONSE');
    if (value.startsWith(':')) return;
    const at = value.indexOf(':');
    const key = at < 0 ? value : value.slice(0, at);
    const content = at < 0 ? '' : value.slice(at + 1).replace(/^ /, '');
    if (key === 'event') type = content;
    if (key === 'data') data.push(content);
  };
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      pending += decoder.decode(part.value, { stream: true });
      let match: RegExpExecArray | null;
      while ((match = /\r\n|\r(?!$)|\n/.exec(pending))) {
        line(pending.slice(0, match.index));
        pending = pending.slice(match.index + match[0].length);
      }
      if (pending.length + size > MAX_BYTES) throw chatFail('INVALID_RESPONSE');
    }
  } finally { void reader.cancel().catch(() => {}); }
}
