// The explanation cards. Ported from BeingDesktop 0.8.26
// renderer/chat-selection.js (`openDetail`, `sendDetail`, `refreshDetail`,
// `closeDetail`, `sync` and the `onChatDetailEvent` subscription); 2026-09-16.
//
// A card is a temporary conversation about one quotation. It belongs to the
// conversation it was opened from — one card per conversation, the previous one
// closes — and it is never persisted: the main process gives it a scene namespace
// no real conversation can name and hands it no cache (main/chat/details.ts).
//
// Two behaviours are the ones that make it trustworthy rather than merely
// convenient, and both are asserted in test/chat-selection-ui.cjs:
//
//   * Stopping a card stops that card. It never forces its way into another
//     conversation's breath — the channel has no `force` at all — and a refusal
//     says so instead of retrying.
//   * Closing a card disposes a reader. It does not interrupt the Being and does
//     not resend anything, so a question asked once stays asked once.
import { Store, errorText } from '../../shared/models/store';
import type { ChatAPI, ChatDetailCard, ChatDetailEvent, ChatDetailReference } from '../../../shared/desktop-types';

/** The question a card opens with. The user selected some text and asked for an
 * explanation; this is that request, in the words 0.8.26 uses. */
export const FIRST_QUESTION = '请解释所选文本的含义，补充必要的背景，并用一个具体例子帮助我理解。';

/** The recovery phases that mean「还在说」for a card, as `refreshDetail` reads
 * them (chat-selection.js line 194). */
const BUSY_PHASES = ['streaming', 'replaying', 'catching-up', 'reconnecting'];

export interface DetailCardState {
  parentSessionId: string;
  reference: ChatDetailReference;
  /** Empty until the main process has minted the temporary conversation. */
  sessionId: string;
  /** The follow-up being typed. A failed send puts its text back here. */
  draft: string;
  sending: boolean;
  busy: boolean;
  status: string;
  /** The last failure, kept until the next successful projection replaces it. */
  error: string;
  view: ChatDetailCard | null;
  /** Following the bottom of the card, until the reader scrolls away from it. */
  pinned: boolean;
  closed: boolean;
}

export interface DetailsOptions {
  chat?: ChatAPI;
  toast: (error: unknown) => void;
}

export class DetailsModel extends Store {
  private cards = new Map<string, DetailCardState>();
  /** One generation per card per read, so a slow projection of a card that has
   * been closed — or replaced — cannot overwrite what is on screen. */
  private reads = new Map<string, number>();
  private readonly chat?: ChatAPI;

  constructor(private readonly options: DetailsOptions) {
    super();
    this.chat = options.chat;
  }

  /** Subscribe to the card stream. `reset` means the Being changed and every
   * card is already gone in the main process: drop them here without sending a
   * close for a card that no longer exists (test/chat-selection-ui.cjs, last
   * check: no extra close and no extra stop). */
  start(): () => void {
    if (!this.chat) return () => {};
    const stop = this.chat.onDetailEvent(event => this.receive(event));
    return () => {
      stop();
      // Nothing in flight may land on the next mount's screen.
      for (const card of this.cards.values()) this.reads.set(card.parentSessionId, (this.reads.get(card.parentSessionId) || 0) + 1);
    };
  }

  card(parentSessionId: string): DetailCardState | null {
    return this.cards.get(parentSessionId) || null;
  }

  /** How many cards are open. Not called `open`: that is the verb below, and a
   * card model that cannot be told to open one would be a poor trade. */
  get count(): number { return this.cards.size; }

  /** Every card, in the order they were opened. The page draws all of them and
   * hides the ones whose conversation is not on screen, as 0.8.26 did
   * (chat-selection.js line 216): a card is a conversation's, not the screen's. */
  get list(): DetailCardState[] { return [...this.cards.values()]; }

  receive(event: ChatDetailEvent) {
    if (!event) return;
    if (event.type === 'reset') {
      if (!this.cards.size) return;
      this.cards.clear();
      this.changed();
      return;
    }
    const sessionId = (event as { sessionId?: string }).sessionId;
    for (const card of [...this.cards.values()]) {
      if (sessionId && card.sessionId !== sessionId) continue;
      if (event.type === 'error') card.error = (event as { message?: string }).message || '解释回复中断。';
      void this.refresh(card.parentSessionId);
    }
  }

  /**
   * Open a card about a quotation.
   *
   * The previous card of this conversation is closed first, and its temporary
   * conversation is given back — 0.8.26 passes `false` there for the focus move,
   * not for the disposal (chat-selection.js line 131 into line 125). Skipping
   * the release would leave a reader in the main process that nothing can ever
   * close again.
   */
  async open(parentSessionId: string, reference: ChatDetailReference) {
    if (!this.chat || !parentSessionId) return;
    const previous = this.cards.get(parentSessionId);
    if (previous) this.dispose(previous, true);
    const card: DetailCardState = {
      parentSessionId, reference, sessionId: '', draft: '', sending: false, busy: false,
      status: '正在打开…', error: '', view: null, pinned: true, closed: false,
    };
    this.cards.set(parentSessionId, card);
    const ticket = (this.reads.get(parentSessionId) || 0) + 1;
    this.reads.set(parentSessionId, ticket);
    this.changed();
    try {
      const view = await this.chat.detailOpen({ parentSessionId, reference });
      if (card.closed || this.cards.get(parentSessionId) !== card) {
        // The card went away while it was being opened: give the temporary
        // conversation back rather than leaving a reader nobody can close.
        void this.chat.detailClose(view.sessionId).catch(() => {});
        return;
      }
      card.sessionId = view.sessionId;
      card.view = view;
      this.changed();
      await this.send(parentSessionId, FIRST_QUESTION);
    } catch (error) {
      if (card.closed || this.cards.get(parentSessionId) !== card) return;
      card.status = errorText(error, '解释卡片打开失败');
      card.error = card.status;
      this.changed();
    }
  }

  setDraft(parentSessionId: string, value: string) {
    const card = this.cards.get(parentSessionId);
    if (!card) return;
    card.draft = value;
    this.changed();
  }

  setPinned(parentSessionId: string, pinned: boolean) {
    const card = this.cards.get(parentSessionId);
    if (card) card.pinned = pinned;
  }

  /** Ask a follow-up. `initial` is the opening question, which is sent for the
   * user rather than typed by them. */
  async send(parentSessionId: string, initial?: string) {
    const card = this.cards.get(parentSessionId);
    if (!this.chat || !card) return;
    const text = initial || card.draft;
    if (card.closed || card.sending || !card.sessionId || !text.trim()) return;
    card.sending = true;
    card.error = '';
    card.status = '正在解释…';
    if (!initial) card.draft = '';
    this.changed();
    try {
      await this.chat.detailSend({ sessionId: card.sessionId, text });
    } catch (error) {
      if (!card.closed) {
        // Anything typed since the send began stays: the returned text goes
        // first, so nothing the user wrote is lost either way.
        card.draft = text + (card.draft ? '\n' + card.draft : '');
        card.error = errorText(error, '追问未能发送');
      }
    } finally {
      card.sending = false;
      if (!card.closed) await this.refresh(parentSessionId);
      this.changed();
    }
  }

  /** Re-read one card. */
  async refresh(parentSessionId: string) {
    const card = this.cards.get(parentSessionId);
    if (!this.chat || !card || !card.sessionId || card.closed) return;
    const ticket = (this.reads.get(parentSessionId) || 0) + 1;
    this.reads.set(parentSessionId, ticket);
    try {
      const view = await this.chat.detailView(card.sessionId);
      if (card.closed || this.reads.get(parentSessionId) !== ticket || this.cards.get(parentSessionId) !== card) return;
      card.view = view;
      const phase = view.recovery?.phase || 'idle';
      card.busy = card.sending || BUSY_PHASES.includes(phase);
      card.status = card.error || view.recovery?.hint || (card.busy ? '正在解释…' : '');
      this.changed();
    } catch (error) {
      if (card.closed || this.reads.get(parentSessionId) !== ticket) return;
      card.status = errorText(error, '解释卡片读取失败');
      this.changed();
    }
  }

  /** Stop this card's reply. A refusal is reported in the card and nothing is
   * retried: the breath belongs to another conversation and is not ours to end. */
  async stop(parentSessionId: string) {
    const card = this.cards.get(parentSessionId);
    if (!this.chat || !card || !card.sessionId) return;
    try {
      const result = await this.chat.detailStop(card.sessionId);
      if (!result.stopped) card.status = '当前回复不属于这张卡片，未停止其他会话。';
    } catch (error) {
      card.status = errorText(error, '停止未完成');
    } finally {
      this.changed();
    }
  }

  close(parentSessionId: string) {
    const card = this.cards.get(parentSessionId);
    if (!card) return;
    this.dispose(card, true);
    this.changed();
  }

  /** Drop a conversation's card because the conversation itself is gone. */
  forget(parentSessionId: string) {
    const card = this.cards.get(parentSessionId);
    if (card) { this.dispose(card, true); this.changed(); }
  }

  private dispose(card: DetailCardState, release: boolean) {
    card.closed = true;
    this.cards.delete(card.parentSessionId);
    this.reads.set(card.parentSessionId, (this.reads.get(card.parentSessionId) || 0) + 1);
    // Disposing a reader never interrupts the Being's breath and never resends.
    if (release && card.sessionId) void this.chat?.detailClose(card.sessionId).catch(error => this.options.toast(error));
  }
}
