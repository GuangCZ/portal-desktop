// The conversation channels' error envelope, both halves. Ported from
// BeingDesktop 0.8.26 src/main.cjs (`townMethods` line 125, `townErrorCodes`
// line 127, the `handle` catch at line 741) and src/preload.cjs (lines 52-76);
// 2026-09-16. BeingDesktop docs/interfaces.md §1.2 marks exactly the five
// channels below「Town 包络」.
//
// Why an envelope rather than an Error: a `code` cannot survive as a field.
// Electron strips custom properties off an Error crossing IPC — src/preload.cjs
// line 52 says so in as many words — and on this side main.ts's handle wrapper
// replaces whatever a handler throws with `new Error(errorLog.report(...))`,
// which is a message and nothing else. So the main process answers a failure on
// these channels with data, and that data is turned back into an Error carrying
// the code the renderer branches on.
//
// WHERE that rebuild happens changed on 2026-09-17 (integration unit IN). It used
// to happen in the preload, which undid itself: `contextBridge` strips a custom
// property off an Error a second time, on the way from the preload's world to the
// page's. MEASURED on this repo's Electron 44.2.0 with a standalone two-file
// fixture — a rejected Error arrives with own properties `["message","stack"]`,
// while the same value rejected as a plain object arrives whole
// (docs/migration/in-shell-errors.md §2). So the envelope now crosses the bridge
// as data on the rejection path, and `desktop/preload/main-world.ts` rebuilds the
// Error inside the page's own world, where nothing is copied.
//
// It lives in `shared` because both halves have to agree on the marker, the code
// allowlist and the truncation, and there is exactly one way for them to agree.

/** The codes allowed to cross. BeingDesktop keeps the same list twice (main and
 * preload) and downgrades anything else to `TOWN_ERROR`, so a code minted by an
 * unrelated subsystem cannot be branched on by mistake. Only the ones the chat
 * layer can actually raise are listed; the rest of 0.8.26's set belongs to Town
 * subsystems that are not ported here. */
export const CHAT_ERROR_CODES = [
  'NOT_CONNECTED', 'SESSION_CHANGED', 'INVALID_REQUEST', 'INVALID_RESPONSE',
  'NETWORK_ERROR', 'SERVICE_ERROR', 'AUTH_REQUIRED', 'RESULT_UNKNOWN', 'BUSY',
  'NEEDS_KEY', 'ROLLED_BACK',
] as const;

export type ChatChannelErrorCode = (typeof CHAT_ERROR_CODES)[number] | 'TOWN_ERROR';

/** What a failing conversation channel resolves with. The marker keeps
 * BeingDesktop's name: these are the same five channels, carrying the same
 * envelope, and a renderer that already knows one knows the other. */
export interface ChatErrorEnvelope {
  __townError: true;
  code: ChatChannelErrorCode;
  message: string;
}

/** BeingDesktop's fallback text for an unrecognised code (src/main.cjs line 741,
 * src/preload.cjs line 61). Kept verbatim: the conversation channels ride the
 * Town envelope in 0.8.26 and this is the sentence a user sees there. */
export const CHAT_ERROR_FALLBACK = 'Town 操作未完成，请稍后重试。';
/** What 0.8.26 uses when the error has no message at all (src/main.cjs line 740). */
const NO_MESSAGE = '操作未完成';
/** src/preload.cjs line 62 truncates the message it is handed back. */
const MAX_MESSAGE = 2000;

const known = (code: unknown): code is (typeof CHAT_ERROR_CODES)[number] =>
  typeof code === 'string' && (CHAT_ERROR_CODES as readonly string[]).includes(code);

/** The control characters `sanitizeText` drops (src/services.cjs line 34): tab,
 * newline and carriage return survive, everything else in C0 and DEL does not.
 * Redaction of URLs and credentials is not repeated here — every message on
 * these channels is an authored constant from `chat/types.ts` MESSAGES or a
 * `fail(code, '…')` literal, so there is nothing of the Being's to leak. */
const clean = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, MAX_MESSAGE);

export const isChatErrorEnvelope = (value: unknown): value is ChatErrorEnvelope =>
  Boolean(value) && typeof value === 'object' && (value as ChatErrorEnvelope).__townError === true;

/** Main-process half: turn a thrown error into the envelope to resolve with. An
 * unknown code takes the generic message too — 0.8.26 refuses to forward the
 * text of a failure it cannot categorise. */
export function chatErrorEnvelope(error: unknown): ChatErrorEnvelope {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (!known(code)) return { __townError: true, code: 'TOWN_ERROR', message: CHAT_ERROR_FALLBACK };
  const message = clean(String((error as Error | null | undefined)?.message || NO_MESSAGE));
  return { __townError: true, code, message: message || CHAT_ERROR_FALLBACK };
}

/** Bridge half: the envelope the preload rejects with, re-checked on this side.
 * Same allowlist and same truncation the Error rebuild used to apply — the main
 * process is trusted, but the code the renderer branches on is validated where it
 * is consumed, as 0.8.26 validates it twice (src/main.cjs and src/preload.cjs). */
export function chatErrorPayload(envelope: ChatErrorEnvelope): ChatErrorEnvelope {
  const code: ChatChannelErrorCode = known(envelope.code) ? envelope.code : 'TOWN_ERROR';
  const message = code !== 'TOWN_ERROR' && typeof envelope.message === 'string' && envelope.message
    ? envelope.message.slice(0, MAX_MESSAGE) : CHAT_ERROR_FALLBACK;
  return { __townError: true, code, message };
}

/** The envelope back into the Error the renderer catches. Built in the page's own
 * world by desktop/preload/main-world.ts; kept here so both halves of the
 * contract stay in one file, and used directly by the preload's fallback path. */
export function chatErrorFromEnvelope(envelope: ChatErrorEnvelope): Error & { code: ChatChannelErrorCode } {
  const payload = chatErrorPayload(envelope);
  return Object.assign(new Error(payload.message), { code: payload.code });
}
