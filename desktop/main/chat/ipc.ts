// The native chat layer's IPC surface. New in the portal-desktop shell on
// 2026-09-16; channel semantics ported from BeingDesktop 0.8.26 src/main.cjs's
// `chatView` / `chatSend` / `chatStop` / `chatReload` / `changeChatSession` /
// `renameChatSession` / `chatForgetSession` / `getChatComposerData`
// (docs/interfaces.md §1.2「对话（原生模式）」, §1.3「主进程 → 渲染层推送」).
//
// Registration follows town/ipc.ts: every channel goes through the `handle`
// wrapper main.ts supplies, so it inherits the sender check (main frame of the
// trusted shell URL only) and the quitting guard for free, and the two mutations
// BeingDesktop serializes — `changeChatSession` and `renameChatSession`
// (src/main.cjs lines 137, 142) — go through the same `exclusive` queue.
//
// Arguments arrive from the renderer and are therefore untrusted. Validation here
// is deliberately structural rather than coercive: an object must be a plain one,
// carry no fields outside the whitelist, and hold values of the declared type, or
// the call is refused before it reaches the session layer. Anything that would be
// merely sanitized (text length, image envelope, reference totals) is checked
// where the measured limits live — in `ChatSessions.send` — so one place owns them.
import type {
  ChatComposerData, ChatEventPayload, ChatReloadResult, ChatSendRequest, ChatSendResult,
  ChatState, ChatStopResult, ChatView,
} from '../../shared/desktop-types';
import type { ChatSessions } from './sessions';

type RegisterHandler = (channel: string, callback: (...args: any[]) => unknown) => void;

export interface ChatIpcOptions {
  handle: RegisterHandler;
  exclusive: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Resolved lazily: the sessions object is rebuilt on every Being binding. */
  sessions: () => ChatSessions | null;
  /** Why the conversation layer cannot run at all, when that is not simply "no
   * Being connected yet" — a profile whose Desktop identity could not be read
   * has no scene namespace, and saying 请先连接 Being would send the user to fix
   * the one thing that is already fine. Empty means nothing is wrong. */
  blocked?: () => string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

const invalid = (message: string): Error => Object.assign(new Error(message), { code: 'INVALID_REQUEST' });

/** A plain object whose keys are all known. An unknown field is refused rather
 * than dropped: it means the caller and this contract disagree, and guessing which
 * of the two is right is how a stale renderer silently loses a parameter. */
function fields(value: unknown, allowed: readonly string[], what: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!plain(value)) throw invalid(`${what}参数无效。`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw invalid(`${what}参数无效。`);
  return value;
}

function sessionId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid('会话不存在。');
  return value;
}

export function registerChatIpc({ handle, exclusive, sessions, blocked }: ChatIpcOptions) {
  // Every channel refuses before touching the network when no Being is bound, so
  // the renderer gets one recognizable code rather than a different failure per
  // channel (BeingDesktop's NOT_CONNECTED, src/chat-sessions.cjs line 128).
  const require = (): ChatSessions => {
    const current = sessions();
    if (!current || !current.open) throw Object.assign(new Error(blocked?.() || '请先连接 Being。'), { code: 'NOT_CONNECTED' });
    return current;
  };
  const idle: ChatState = { open: false, version: 0, identityKey: '', active: '', cursor: 0, seeded: false, degraded: false, sessions: [], recovery: { phase: 'idle' } };

  handle('beings:chat-sessions', (): ChatState => {
    const current = sessions();
    return current ? current.snapshot() : idle;
  });

  handle('beings:chat-view', (id: unknown): ChatView => require().view(sessionId(id)));

  handle('beings:chat-send', (input: unknown): Promise<ChatSendResult> => {
    const request = fields(input, ['sessionId', 'text', 'images', 'references'], '发送');
    const id = sessionId(request.sessionId);
    if (typeof request.text !== 'string') throw invalid('消息不能为空。');
    if (request.images !== undefined && !Array.isArray(request.images)) throw invalid('图片参数无效。');
    if (request.references !== undefined && !Array.isArray(request.references)) throw invalid('一条消息最多引用 12 段文本。');
    // Sizes, image formats and reference totals are the session layer's contract.
    return require().send({ sessionId: id, text: request.text, images: request.images, references: request.references });
  });

  handle('beings:chat-stop', (input: unknown): Promise<ChatStopResult> => {
    const request = fields(input, ['sessionId', 'force'], '停止');
    const id = sessionId(request.sessionId);
    if (request.force !== undefined && typeof request.force !== 'boolean') throw invalid('停止参数无效。');
    return require().stop({ sessionId: id, force: request.force === true });
  });

  handle('beings:chat-reload', (): Promise<ChatReloadResult> => require().reload());

  // `null` means "a new conversation", matching BeingDesktop's changeChatSession
  // (docs/interfaces.md §1.2). Both branches return the id that is now active.
  handle('beings:chat-change-session', (id: unknown): Promise<string> => exclusive(async () => {
    const current = require();
    if (id === null || id === undefined) return current.create({ title: '新会话' });
    const target = sessionId(id);
    current.select(target);
    return target;
  }));

  handle('beings:chat-rename-session', (id: unknown, title: unknown): Promise<boolean> => exclusive(async () => {
    const target = sessionId(id);
    if (typeof title !== 'string') throw invalid('会话名须为 1–80 个字符。');
    return require().rename(target, title);
  }));

  handle('beings:chat-forget-session', (id: unknown): boolean => require().forget(sessionId(id)));

  // The kit catalogue and the Town member directory are separate subsystems that
  // arrive in a later stage. Returning the empty shape now keeps the renderer
  // contract fixed, and an empty list is the honest answer: nothing is loaded.
  handle('beings:chat-composer-data', (): ChatComposerData =>
    ({ kits: [], members: [], kitsError: '', membersError: '', connectionRevision: 0 }));
}

/** The two pushes, given the window to send on. Kept beside the handlers so the
 * channel names live in one file (`beings:chat-event`, `beings:chat-state`). */
export interface ChatPushTarget { send(channel: string, payload: unknown): void }

export function chatPush(target: () => ChatPushTarget | null) {
  return {
    event: (payload: ChatEventPayload) => { target()?.send('beings:chat-event', payload); },
    state: (payload: ChatState) => { target()?.send('beings:chat-state', payload); },
  };
}
