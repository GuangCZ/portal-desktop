// The explanation cards' IPC surface, plus the two channels the conversation
// page still lacked; 2026-09-16.
//
// Channel semantics ported from BeingDesktop 0.8.26 src/main.cjs lines 1208-1218
// (`chatOpenWorkerResult`, `chatDetailOpen/View/Send/Stop/Close`) and line 646
// (the `being:chat-detail-event` push). Shapes: docs/interfaces.md §1.2「对话
// （原生模式）」and §1.3. (`getChatComposerData` stays in ./ipc.ts, where this
// shell already registered it; this unit only gives it its `{force?}` parameter
// and a real answer.)
//
// Five of the six invoke channels answer a failure with an envelope rather than
// throwing: `chatDetailOpen/View/Send/Stop/Close` are added to `townMethods` at
// src/main.cjs line 126, which is what lets a `BUSY` or a `SESSION_CHANGED` reach
// the card. `chat-worker-result` is bare, as `chatOpenWorkerResult` is there.
//
// Validation is this file's, not the card layer's: arguments arrive from the
// renderer, so a request object must be plain, carry no key outside the
// whitelist, and hold values of the declared type before anything downstream sees
// it. The card layer owns what it alone can judge — that a card exists, that a
// quotation is within the reference limits, that eight cards are already open.
import { chatErrorEnvelope } from '../../shared/chat-errors';
import type { ChatDetailCard, ChatDetailEvent, ChatSendResult, ChatStopResult } from '../../shared/desktop-types';
import type { ChatDetails } from './details';

type RegisterHandler = (channel: string, callback: (...args: any[]) => unknown) => void;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

const invalid = (message: string): Error => Object.assign(new Error(message), { code: 'INVALID_REQUEST' });

function fields(value: unknown, allowed: readonly string[], what: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!plain(value)) throw invalid(`${what}参数无效。`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw invalid(`${what}参数无效。`);
  return value;
}

/** A card id, which is a conversation id of the temporary namespace. The refusal
 * text is the card layer's own, so a malformed id and a closed card read alike —
 * both mean「这张卡片不在了」to the user. */
function cardId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid('解释卡片已关闭。');
  return value;
}

export interface ChatDetailsIpcOptions {
  handle: RegisterHandler;
  /** Resolved lazily, like the sessions one. The card layer itself is never
   * absent — it holds no Being binding, only a reader it builds on demand — so
   *「还没连接」is not one of its answers: with nothing bound, `hasParent` is
   * false and opening a card fails with「来源会话不存在。」, which is what
   * BeingDesktop answers too (src/chat-details.cjs `open`). */
  details: () => ChatDetails;
  /** Open a finished Worker's preview in the Desktop browser. Refuses when the
   * conversation is not this Being's, or the Worker is not that conversation's. */
  openWorkerResult: (input: { sessionId: string; workerId: string }) => Promise<unknown>;
}

export function registerChatDetailsIpc({ handle, details, openWorkerResult }: ChatDetailsIpcOptions) {
  const enveloped = (channel: string, callback: (...args: any[]) => unknown) =>
    handle(channel, async (...args: any[]) => {
      try { return await callback(...args); }
      catch (error) { return chatErrorEnvelope(error); }
    });

  enveloped('beings:chat-detail-open', (input: unknown): Promise<ChatDetailCard> => {
    const request = fields(input, ['parentSessionId', 'reference'], '解释卡片');
    if (typeof request.parentSessionId !== 'string' || !UUID.test(request.parentSessionId)) throw invalid('来源会话不存在。');
    // The quotation itself goes to `shared/chat-references.ts` through
    // `ChatDetails.open`, which owns the measured limits (12 selections, 60000
    // characters) and the `source` vocabulary.
    return details().open({ parentSessionId: request.parentSessionId, reference: request.reference }) as Promise<ChatDetailCard>;
  });

  enveloped('beings:chat-detail-view', (id: unknown): ChatDetailCard => details().view(cardId(id)) as ChatDetailCard);

  enveloped('beings:chat-detail-send', (input: unknown): Promise<ChatSendResult> => {
    const request = fields(input, ['sessionId', 'text'], '发送');
    const id = cardId(request.sessionId);
    if (typeof request.text !== 'string') throw invalid('消息不能为空。');
    return details().send({ sessionId: id, text: request.text }) as Promise<ChatSendResult>;
  });

  enveloped('beings:chat-detail-stop', (id: unknown): Promise<ChatStopResult> => details().stop(cardId(id)) as Promise<ChatStopResult>);

  // Closing is the one card operation that must never fail for the caller: the
  // renderer removes the card either way, and a refusal would strand the reader.
  // `ChatDetails.close` answers `true` for an id it has never seen.
  enveloped('beings:chat-detail-close', (id: unknown): boolean => details().close(cardId(id)));

  handle('beings:chat-worker-result', (input: unknown): Promise<unknown> => {
    const request = fields(input, ['sessionId', 'workerId'], '结果预览');
    if (typeof request.sessionId !== 'string' || !UUID.test(request.sessionId)) throw invalid('会话不存在。');
    // A Worker id is minted by `randomUUID`, but the manager's own lookup is by
    // equality, so the only thing to check here is that it is a string of a
    // plausible length rather than an object that would reach a `find`.
    if (typeof request.workerId !== 'string' || !request.workerId || request.workerId.length > 100) throw invalid('结果预览参数无效。');
    return openWorkerResult({ sessionId: request.sessionId, workerId: request.workerId });
  });
}

/** The card stream's push, given the window to send on. Named here so the channel
 * lives in one file, beside the handlers (`beings:chat-detail-event`). */
export interface ChatDetailPushTarget { send(channel: string, payload: unknown): void }

export function chatDetailPush(target: () => ChatDetailPushTarget | null) {
  return (payload: ChatDetailEvent) => { target()?.send('beings:chat-detail-event', payload); };
}
