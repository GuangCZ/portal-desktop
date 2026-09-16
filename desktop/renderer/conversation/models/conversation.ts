// The conversation the shell shows: the list of conversations, the projection of
// the active one, and the reply arriving right now. Ported from BeingDesktop
// 0.8.26 renderer/chat-app.js (`local`, `setState`, `refresh`, `onEvent`,
// `send`, `stop`, `keyArg`); 2026-09-16. Protocol behaviour behind every branch
// is the measured one: docs/desktop-message-layer.md §一 (202 / spliced),
// §四 (whose breath a stop would end), §五 (reasoning is never folded into the
// body) and §十 (images).
//
// Nothing here talks to the Being. Every action is an IPC call on
// `window.beings.chat`, every byte shown came back through one.
import { Store, errorText } from '../../shared/models/store';
import type {
  ChatAPI, ChatEventPayload, ChatLiveReply, ChatSessionSummary, ChatState, ChatView,
} from '../../../shared/desktop-types';
import { ComposerModel, type ComposerOptions } from './composer';
import { OrganizerModel } from './organizer';
import { transcript, type TranscriptItem } from './transcript';

/** What the recovery machine is doing, said to the user (chat-app.js line 16).
 * Kept verbatim: these lines are why a late reply reads as patience rather than
 * as a hang. */
export const PHASES: Record<string, string> = {
  streaming: 'Being 正在回复…',
  replaying: '连接恢复中，正在续读回复…',
  reconnecting: '连接中断了，正在自动恢复…',
  'catching-up': '消息已送达，Being 正在处理其他会话，等它回到这里…',
  watching: 'being 正在呼吸…',
};

/** Loom's activity labels for `tool_use` events (its `tuiLabels`). */
export const TOOL_LABELS: Record<string, string> = {
  thinking: '在思考', remember: '在回忆', learn: '在反思', search_web: '在搜索',
  browse_web: '在浏览', read_file: '在阅读', write_file: '在编写', run_command: '在执行',
  list_files: '在查看', portal_exec: '在执行', act: '在行动',
};

/** Where the one-time explanation's dismissal is kept. Same key as 0.8.26, so a
 * user who dismissed it there does not see it again here. */
export const NOTICE_KEY = 'being-chat-notice-v1';

/** The one-time explanation itself. Conversations are a browsing view over one
 * memory, and the rows that predate scene support belong to none of them. */
export const NOTICE_TEXT = '所有会话共享同一个 being 的记忆，会话只是你的浏览视图；v1.7.0 之前的记录没有场景标记，未归入任何会话';

export interface ActivityEntry { label: string; arg: string; done: boolean; error: boolean }
export interface Activity { log: ActivityEntry[]; current: ActivityEntry | null }

/** A confirmation the user has to answer before a stop is retried with `force`. */
export interface StopConfirm { message: string; resolve: (confirmed: boolean) => void }

export const IDLE_STATE: ChatState = {
  open: false, version: 0, identityKey: '', active: '', cursor: 0, seeded: false,
  degraded: false, sessions: [], recovery: { phase: 'idle' },
};

/** The one argument worth showing for a tool call (Loom's `extractKeyArg` over
 * `parseToolInput`, chat-app.js line 38). */
export function keyArg(raw: unknown): string {
  let input: unknown = raw;
  if (typeof raw === 'string') { try { input = JSON.parse(raw); } catch { input = {}; } }
  if (!input || typeof input !== 'object') return '';
  const value = input as Record<string, unknown>;
  const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  const base = (text: string) => text.split(/[\\/]/).filter(Boolean).pop() || text;
  if (typeof value.query === 'string') return cut(value.query, 60);
  if (typeof value.path === 'string') return base(value.path);
  if (typeof value.file_path === 'string') return base(value.file_path);
  if (typeof value.command === 'string') return cut(value.command, 50);
  if (typeof value.url === 'string') { try { return new URL(value.url).hostname; } catch { return cut(value.url, 40); } }
  if (typeof value.topic === 'string') return cut(value.topic, 40);
  if (typeof value.content === 'string') return cut(value.content, 40);
  for (const item of Object.values(value)) if (typeof item === 'string' && item) return cut(item, 40);
  return '';
}

export interface ConversationOptions {
  /** Absent when the page was not opened by the desktop client. */
  chat?: ChatAPI;
  toast: (error: unknown) => void;
  /** What the Being is called, for the meta line above its messages. */
  beingName: () => string;
  composer?: Pick<ComposerOptions, 'read' | 'randomUUID'>;
}

export class ConversationModel extends Store {
  state: ChatState = IDLE_STATE;
  /** The active conversation's projection, or null while it is being read. */
  view: ChatView | null = null;
  /** The reply arriving now, accumulated from the event stream between
   * projections. `think` is the reasoning stream and stays out of the body. */
  live: ChatLiveReply | null = null;
  activity: Activity | null = null;
  waiting = false;
  sending = false;
  stopping = false;
  reloading = false;
  noticeDismissed = false;
  /** Pinned to the bottom: the stream follows new messages only while the user
   * has not scrolled away from them. */
  pinned = true;
  /** A row the search panel asked us to show, cleared once scrolled to. */
  jumpTo = '';
  /** A projection this conversation could not read. It stays in the line above
   * the composer until the next state update, which is where 0.8.26 put it
   * (chat-app.js line 325 wrote it straight into the phase line, and `setState`
   * overwrote it on the next broadcast). A notice that disappears after six
   * seconds would leave a conversation looking empty with nothing to say why. */
  readError = '';
  confirm: StopConfirm | null = null;
  readonly composer: ComposerModel;
  /** Pins, projects and archives — the sidebar's own view of the same list. */
  readonly organizer = new OrganizerModel();
  /** Which conversation the projection in `view` belongs to. */
  private active = '';
  /** The `state.version` the projection was read at; -1 forces a re-read. */
  private version = -1;
  /** One generation per `view()` request. A response from an older generation —
   * a slow read of the conversation we just left, or of a projection two
   * versions stale — is dropped instead of overwriting what is on screen. */
  private generation = 0;
  private readonly chat?: ChatAPI;

  constructor(private readonly options: ConversationOptions) {
    super();
    this.chat = options.chat;
    this.composer = new ComposerModel({ toast: message => options.toast(message), ...options.composer });
    try { this.noticeDismissed = localStorage.getItem(NOTICE_KEY) === '1'; } catch { this.noticeDismissed = false; }
  }

  start() {
    if (!this.chat) return () => {};
    const stopState = this.chat.onState(state => this.accept(state));
    const stopEvent = this.chat.onEvent(event => this.receive(event));
    void this.chat.sessions().then(state => this.accept(state)).catch(error => this.options.toast(error));
    return () => {
      stopState();
      stopEvent();
      // Nothing in flight may land on the next mount's screen.
      ++this.generation;
      this.cancelConfirm();
    };
  }

  get beingName() { return this.options.beingName() || 'being'; }
  get sessions(): ChatSessionSummary[] { return this.state.sessions; }
  get activeId() { return this.active; }
  get session(): ChatSessionSummary | undefined { return this.state.sessions.find(item => item.id === this.active); }
  /** The conversation layer is bound to a Being and running (`ChatSessions.open`). */
  get connected() { return this.state.open; }
  get phase(): string { return this.state.recovery.phase || 'idle'; }

  /** The line under the composer. A hint about another conversation's breath
   * belongs under that conversation, not this one (chat-app.js line 306). */
  get status(): string {
    if (this.readError) return this.readError;
    const recovery = this.state.recovery;
    const hint = ((!recovery.sessionId || recovery.sessionId === this.active) && recovery.hint) || PHASES[this.phase] || '';
    if (!this.connected) return '尚未连接';
    return this.state.degraded ? `${hint}${hint ? ' · ' : ''}本机未加密，记录仅保留在内存` : hint;
  }

  /** Nothing can be typed without a Being and a conversation to type into. */
  get disabled() { return !this.connected || !this.active; }

  /** Our reader is up for this conversation: show the Being at work from the
   * moment the message leaves, not from its first token. `inFlight` lags the
   * phase by one broadcast, so both are checked (chat-app.js line 316). */
  get stopVisible(): boolean {
    const session = this.session;
    return Boolean(session && (session.busy || session.inFlight)) || ['streaming', 'replaying'].includes(this.phase);
  }

  get noticeVisible() { return this.state.open && !this.noticeDismissed; }

  get items(): TranscriptItem[] { return transcript(this.view, this.live); }

  /** The questions the ⌘F panel searches, newest last, as the shell's index. */
  questions(): { id: string; text: string }[] {
    return (this.view?.rows || [])
      .filter(row => row.role === 'user' && row.content.trim())
      .map(row => ({ id: `row-${row.seq}`, text: row.content.trim().slice(0, 240) }));
  }

  dismissNotice() {
    this.noticeDismissed = true;
    try { localStorage.setItem(NOTICE_KEY, '1'); } catch { /* Optional preference. */ }
    this.changed();
  }

  setPinned(pinned: boolean) { this.pinned = pinned; }

  jump(id: string) {
    this.jumpTo = id;
    this.changed();
  }

  jumped() {
    if (!this.jumpTo) return;
    this.jumpTo = '';
    this.changed();
  }

  /** A new projection of the conversation list. Everything the view derives from
   * it is recomputed here, in 0.8.26's order (`setState`, chat-app.js line 275). */
  accept(state: ChatState) {
    this.state = state;
    // A state update replaces whatever the last failed read left in the line
    // above the composer, exactly as 0.8.26's `setState` did.
    this.readError = '';
    // The layer closed under an unanswered confirmation: there is no breath
    // left to stop, and the page that drew the dialog may already be gone.
    if (!state.open) this.cancelConfirm();
    const active = state.open ? state.active : '';
    if (active !== this.active) {
      this.active = active;
      this.view = null;
      this.live = null;
      this.activity = null;
      this.version = -1;
      this.pinned = true;
      this.jumpTo = '';
      // A read still in flight belongs to the conversation we just left.
      ++this.generation;
      this.composer.switchTo(active);
    }
    const session = this.session, recovery = state.recovery;
    this.waiting = Boolean(session && (session.inFlight
      || (recovery.sessionId === active && (this.phase === 'streaming' || this.phase === 'replaying'))));
    this.changed();
    if (active && state.version !== this.version) void this.refresh();
  }

  /** Re-read the active conversation's projection. */
  async refresh() {
    const id = this.active, version = this.state.version, ticket = ++this.generation;
    if (!id || !this.chat) return;
    try {
      const view = await this.chat.view(id);
      // Late by a generation, or answering for a conversation we have left.
      if (ticket !== this.generation || view.sessionId !== this.active) return;
      this.view = view;
      this.version = version;
      this.readError = '';
      this.live = view.live ? { text: view.live.text, think: view.live.think, at: view.live.at } : null;
      this.changed();
    } catch (error) {
      if (ticket !== this.generation) return;
      this.readError = errorText(error, '记录读取失败');
      this.changed();
    }
  }

  /** One event of the active conversation's stream. Deltas and tool activity
   * update what is on screen in place; anything else re-reads the projection,
   * because only the main process knows what became durable. */
  receive(event: ChatEventPayload) {
    if (!event || event.sessionId !== this.active) return;
    if (event.type === 'delta' || event.type === 'think') {
      const text = typeof (event as { text?: unknown }).text === 'string' ? (event as { text: string }).text : '';
      this.live = this.live || { text: '', think: '', at: new Date().toISOString() };
      if (event.type === 'delta') this.live = { ...this.live, text: this.live.text + text };
      else this.live = { ...this.live, think: this.live.think + text };
      this.changed();
      return;
    }
    if (event.type === 'tool_use') {
      const data = (event.data || {}) as Record<string, unknown>;
      const name = typeof data.name === 'string' && data.name ? data.name : 'tool';
      const entry: ActivityEntry = { label: TOOL_LABELS[name] || name, arg: keyArg(data.input), done: false, error: false };
      const activity = this.activity || { log: [], current: null };
      this.activity = { log: [...activity.log, entry], current: entry };
      this.changed();
      return;
    }
    if (event.type === 'tool_result') {
      const entry = this.activity?.log.slice().reverse().find(item => !item.done);
      if (entry && this.activity) {
        entry.done = true;
        entry.error = (event.data as Record<string, unknown> | undefined)?.is_error === true;
        this.activity = { log: [...this.activity.log], current: entry.error ? entry : null };
      }
      this.changed();
      return;
    }
    if (event.type === 'reply' || event.type === 'error' || event.type === 'settled') {
      this.live = null;
      this.activity = null;
    }
    this.version = -1;
    void this.refresh();
  }

  /** Send what is in the composer. The composer is emptied first: the message is
   * gone from here either way, and a refusal puts it back where it was typed. */
  async send() {
    if (this.sending || this.disabled || !this.chat) return;
    const refusal = this.composer.refusal();
    if (refusal.blocked) {
      if (refusal.message) this.options.toast(refusal.message);
      return;
    }
    this.sending = true;
    const sessionId = this.active, draft = this.composer.take();
    // The Being is at work from this moment; the projection catches up a broadcast later.
    this.waiting = true;
    this.changed();
    try {
      const result = await this.chat.send({
        sessionId, text: draft.text,
        ...(draft.references.length ? { references: draft.references } : {}),
        ...(draft.images.length ? { images: draft.images.map(({ name, media_type, data, thumb }) => ({ name, media_type, data, thumb })) } : {}),
      });
      // The measured 202: delivered, joined the breath already running, and its
      // reply will arrive on whichever connection is open (docs §一).
      if (result?.spliced) this.options.toast('消息已送达，Being 正在处理其他会话，回复稍后到达。');
    } catch (error) {
      this.composer.restore(sessionId, draft);
      if (this.active === sessionId) this.waiting = false;
      this.options.toast(error);
    } finally {
      this.sending = false;
      this.changed();
    }
  }

  /**
   * Stop the reply this conversation is waiting for. The main process refuses
   * rather than guesses when the breath belongs elsewhere: `other-scene` names
   * the conversation that owns it, `unknown` means a bubble just closed and the
   * next speaker is not known yet (docs §四). Either way the user decides, and
   * only then does `force` go out.
   */
  async stop() {
    if (this.stopping || !this.active || !this.chat) return;
    this.stopping = true;
    this.changed();
    const sessionId = this.active;
    try {
      const result = await this.chat.stop({ sessionId });
      if (result.stopped) return;
      if (result.reason === 'other-scene') {
        const who = result.ownerTitle ? `「${result.ownerTitle}」` : '另一个会话';
        if (await this.ask(`Being 正在回复的是${who}，不是这个会话。要停止那边的回复吗？`))
          await this.chat.stop({ sessionId, force: true });
      } else if (result.reason === 'unknown') {
        // A bubble just closed: the last speaker is known, the next one is not.
        const last = result.ownerTitle ? `刚说完的是「${result.ownerTitle}」，接下来轮到谁还不确定。` : '无法确认 Being 正在回复哪个会话。';
        if (await this.ask(`${last}仍要停止当前这口气吗？`))
          await this.chat.stop({ sessionId, force: true });
      } else if (result.reason === 'autonomous') {
        this.options.toast('Being 正在自己思考，没有属于会话的回复可以停止。');
      } else {
        this.options.toast('当前没有正在进行的回复。');
      }
    } catch (error) {
      this.options.toast(error);
    } finally {
      this.stopping = false;
      this.changed();
    }
  }

  /**
   * Answer a confirmation nobody can see any more with "no". The dialog belongs
   * to the conversation page, which the shell unmounts as soon as the settings
   * lose their token, while this model lives as long as the window: without
   * this the promise in `ask` never settles, `stop`'s `finally` never runs, and
   * the stop button stays disabled until the window is closed.
   */
  cancelConfirm() {
    this.confirm?.resolve(false);
  }

  private ask(message: string): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      this.confirm = {
        message,
        resolve: confirmed => {
          this.confirm = null;
          this.changed();
          resolve(confirmed);
        },
      };
      this.changed();
    });
  }

  /** Re-read the newest window as a fresh baseline. What the truncation banner
   * and the shell's refresh control both call. */
  async reload() {
    if (this.reloading || !this.chat || !this.state.open) return;
    this.reloading = true;
    this.changed();
    try {
      const result = await this.chat.reload();
      if (result.error) this.options.toast(result.error);
    } catch (error) {
      this.options.toast(error);
    } finally {
      this.reloading = false;
      this.changed();
    }
  }

  /** Returns the new conversation's id, so a caller that opened it inside a
   * project can file it there. */
  async create(): Promise<string> {
    if (!this.chat) return '';
    try { return await this.chat.changeSession(null); } catch (error) { this.options.toast(error); return ''; }
  }

  async select(sessionId: string) {
    if (!this.chat || sessionId === this.active) return;
    try { await this.chat.changeSession(sessionId); } catch (error) { this.options.toast(error); }
  }

  /** Returns whether it was saved, so the inline editor can stay open on a
   * refusal with the text the user typed (renderer/app.js line 1486). */
  async rename(sessionId: string, title: string): Promise<boolean> {
    if (!this.chat) return false;
    try {
      await this.chat.renameSession(sessionId, title);
      return true;
    } catch (error) {
      this.options.toast(error);
      return false;
    }
  }

  /** Deletes the local record of a conversation. The Being's own history is not
   * touched — this is our browsing view, not its memory. */
  async forget(sessionId: string): Promise<boolean> {
    if (!this.chat) return false;
    try {
      await this.chat.forgetSession(sessionId);
      this.composer.forget(sessionId);
      this.organizer.forget(sessionId);
      return true;
    } catch (error) {
      this.options.toast(error);
      return false;
    }
  }

  /** What the shell shows beside the connection label. */
  get connectionState(): string {
    if (!this.state.open) return 'connecting';
    if (this.phase === 'reconnecting') return 'reconnecting';
    if (this.state.recovery.gaveUp) return 'degraded';
    return 'online';
  }

  /** Put a quotation into the draft of the active conversation, used by the
   * companion panel. Refuses when there is already a draft, as the Loom page
   * did: the user's own words are not overwritten by a quotation. */
  placeDraft(text: string): boolean {
    if (this.disabled || this.composer.text.trim()) return false;
    this.composer.setText(text);
    return true;
  }
}
