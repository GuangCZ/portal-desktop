// Ported from BeingDesktop 0.8.26 src/orchestration-message.cjs lines 16-37;
// 2026-09-16. Kept here rather than with the orchestration port so the store can
// use it now; the two merge in a later stage.
//
// Runtime context is transient request metadata. It is supplied to Heart as text
// (scene_meta is routing metadata, not content), but it is not part of what the
// human said, so the durable row is stored unframed. History returns the framed
// text verbatim, which is why unwrapping happens on the way to disk rather than
// on the way out.
const PREFIX = '[Being Desktop request context v1; length=';
const SUFFIX = '\n[/Being Desktop request context v1]\n\n';

/**
 * Strip a request-context frame from a user message.
 *
 * The declared length is the authority: a frame whose footer sits exactly where
 * the header said it would is removed without inspecting the context at all. The
 * second branch is the tolerance for a context whose own text was rewritten after
 * the length was computed — it is accepted only when the footer lands no later
 * than the declared end and the context looks like one Desktop itself wrote.
 * Anything else is returned untouched: a message that merely begins with those
 * characters is the user's own text.
 *
 * The original's `typeof text !== 'string'` guard is carried by the signature
 * here; its only caller checks `typeof value.content === 'string'` first.
 */
export function unwrapMessage(text: string): string {
  if (!text.startsWith(PREFIX)) return text;
  const header = /^\[Being Desktop request context v1; length=(\d{1,6})\]\n/.exec(text);
  if (!header) return text;
  const end = header[0].length + Number(header[1]);
  if (text.slice(end, end + SUFFIX.length) === SUFFIX) return text.slice(end + SUFFIX.length);
  const footer = text.indexOf(SUFFIX, header[0].length);
  const context = text.slice(header[0].length, footer).trimEnd();
  if (footer >= header[0].length && footer <= end && context.startsWith('[Being Desktop 当前消息环境]\n')
    && (context.endsWith('[/Being Desktop 当前消息环境]') || context.endsWith('[/Being Desktop Orchestrator mode]')))
    return text.slice(footer + SUFFIX.length);
  return text;
}
