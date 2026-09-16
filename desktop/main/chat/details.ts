// Ported line for line from BeingDesktop 0.8.26 src/chat-details.cjs (67 lines);
// 2026-09-16.
//
// A fresh scene namespace and an in-memory store per open set of cards. Ordinary ChatSessions
// cannot import these rows, including after a reload. The Being's own memory is still shared.
//
// The isolation is the whole design: a random `desktopId` per generation means
// `sessionFromScene` on the main Desktop's id can never resolve one of these scenes
// (BeingDesktop src/being-chat.cjs sessionFromScene), and no cache is passed, so nothing
// reaches disk. Closing the last card drops the reader without touching the Being: a
// server-side breath is never interrupted and no message is ever resent.
import { randomUUID } from 'node:crypto';
import { validate } from '../../shared/chat-references';
import type { RecoveryTimers } from './recovery';
import { ChatSessions } from './sessions';
import type { ChatSessionEvent, SendOutcome, SessionView } from './sessions';
import type { ChatContext } from './types';

interface DetailsError extends Error { code: string }
const fail = (code: string, message: string): DetailsError => Object.assign(new Error(message), { code });

export interface DetailCard {
  sessionId: string;
  parentSessionId: string;
  reference: { text: string; source: 'you' | 'Being' };
  sending: boolean;
}

export type DetailEvent = ChatSessionEvent | { type: 'reset' } | { type: 'state'; sessionId?: string };

export interface ChatDetailsOptions {
  getContext: () => ChatContext | null | undefined;
  hasParent: (sessionId: string) => boolean;
  onEvent?: (event: DetailEvent) => void;
  clientVersion?: string;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  timers?: RecoveryTimers;
}

export class ChatDetails {
  readonly getContext: ChatDetailsOptions['getContext'];
  readonly hasParent: (sessionId: string) => boolean;
  readonly onEvent: (event: DetailEvent) => void;
  readonly clientVersion: string;
  readonly fetchImpl?: ChatDetailsOptions['fetchImpl'];
  readonly timers?: RecoveryTimers;
  cards = new Map<string, DetailCard>();
  sessions: ChatSessions | null = null;
  ready: Promise<unknown> | null = null;

  constructor({ getContext, hasParent, onEvent = () => {}, clientVersion = '', fetchImpl, timers }: ChatDetailsOptions) {
    this.getContext = getContext; this.hasParent = hasParent; this.onEvent = onEvent;
    this.clientVersion = clientVersion; this.fetchImpl = fetchImpl; this.timers = timers;
  }

  reset(notify = true): void {
    const sessions = this.sessions;
    this.sessions = null; this.ready = null; this.cards.clear();
    sessions?.end();
    if (notify) this.onEvent({ type: 'reset' });
  }

  async open({ parentSessionId, reference }: { parentSessionId?: string; reference?: unknown } = {}): Promise<SessionView & DetailCard & { recovery: unknown }> {
    if (!this.hasParent(parentSessionId as string)) throw fail('INVALID_REQUEST', '来源会话不存在。');
    let checked: DetailCard['reference'];
    try { checked = validate([reference])[0]; } catch (error) { throw fail('INVALID_REQUEST', (error as Error).message); }
    if (this.cards.size >= 8) throw fail('BUSY', '请先关闭一个解释卡片。');
    if (!this.sessions) {
      const sessions: ChatSessions = new ChatSessions({
        desktopId: randomUUID(),
        getContext: () => (this.sessions === sessions ? this.getContext() : { connected: false }),
        clientVersion: this.clientVersion, fetchImpl: this.fetchImpl, timers: this.timers,
        onEvent: event => { if (this.sessions === sessions && this.cards.has(event.sessionId)) this.onEvent(event); },
        onState: () => { if (this.sessions === sessions) this.onEvent({ type: 'state' }); },
      });
      this.sessions = sessions;
      this.ready = sessions.start('temporary-details');
    }
    const sessions = this.sessions;
    await this.ready;
    if (sessions !== this.sessions || !this.hasParent(parentSessionId as string)) throw fail('SESSION_CHANGED', '会话已变化，请重新选择文本。');
    if (this.cards.size >= 8) throw fail('BUSY', '请先关闭一个解释卡片。');
    const sessionId = sessions.create({ title: '更多详情' });
    this.cards.set(sessionId, { sessionId, parentSessionId: parentSessionId as string, reference: checked, sending: false });
    return this.view(sessionId);
  }

  private _card(id: string): DetailCard {
    const card = this.cards.get(id);
    if (!card || !this.sessions || !this.hasParent(card.parentSessionId)) throw fail('INVALID_REQUEST', '解释卡片已关闭。');
    return card;
  }

  view(id: string): SessionView & DetailCard & { recovery: unknown } {
    const card = this._card(id);
    const state = this.sessions!.snapshot();
    const recovery = 'sessionId' in state.recovery && state.recovery.sessionId && state.recovery.sessionId !== id ? { phase: 'idle' } : state.recovery;
    return { ...card, ...this.sessions!.view(id), recovery };
  }

  async send({ sessionId, text }: { sessionId?: string; text?: unknown } = {}): Promise<SendOutcome> {
    const card = this._card(sessionId as string);
    if (card.sending) throw fail('BUSY', '这张卡片正在回复，请稍候。');
    card.sending = true;
    try { return await this.sessions!.send({ sessionId, text, references: [card.reference] }); }
    finally { card.sending = false; if (this.cards.has(sessionId as string)) this.onEvent({ type: 'state', sessionId }); }
  }

  stop(sessionId: string) { this._card(sessionId); return this.sessions!.stop({ sessionId }); }

  close(id: string): true {
    this.cards.delete(id);
    // Disposing readers never interrupts a Being's server-side breath or sends another message.
    if (!this.cards.size) this.reset(false);
    return true;
  }
}
