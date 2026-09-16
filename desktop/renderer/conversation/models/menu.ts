// The `/` and `@` menu's own state. Ported from BeingDesktop 0.8.26
// renderer/chat-composer.js (`key`, `close`, `select`, `refresh`, `keydown`);
// 2026-09-16.
//
// It is a model rather than component state because two surfaces read it — the
// listbox inside the composer and the notice line under it — and because the
// rules worth testing are here: which token the caret is in, what the menu
// offers for it, what an Escape means, and when the catalogue is worth reading
// again.
//
// Nothing here touches the DOM. The caret arrives as two numbers and a chosen
// entry leaves as replacement text plus a caret position; the component owns the
// textarea.
import { Store } from '../../shared/models/store';
import type { ChatComposerEntry } from '../../../shared/desktop-types';
import {
  composerReferences, composerSuggestions, replaceComposerToken, tokenAtCaret,
  type ComposerToken,
} from './completion';
import { memberMap, memberName, resolve, unresolvedNotice } from './mentions';
import type { ComposerDirectory } from './directory';

/** Where the caret is, when the composer is focused and usable. `null` closes
 * the menu — 0.8.26 refuses to draw suggestions for a box nobody is typing in
 * (chat-composer.js line 57). */
export interface Caret { start: number; end: number }

/** Two tokens are the same token while the caret stays inside them: the position
 * of the prefix plus what has been typed since (chat-composer.js line 19). An
 * Escape dismisses exactly this, so moving on to the next word brings the menu
 * back without another keystroke. */
const identify = (token: ComposerToken | null): string => (token ? `${token.start}:${token.prefix}${token.query}` : '');

export class ComposerMenuModel extends Store {
  open = false;
  token: ComposerToken | null = null;
  items: ChatComposerEntry[] = [];
  selected = 0;
  /** The line under the composer: which Kits this message calls, whom it will
   * notify in public, and which `@word` will notify nobody. */
  notice = '';
  private dismissed = '';

  constructor(private readonly directory: ComposerDirectory) { super(); }

  /** `已安装 Kit · 内置能力` or `通知 Being · 消息将公开到篝火` — the second says
   * what choosing a row costs before it is chosen. */
  get heading(): string {
    return this.token?.kind === 'kit' ? '已安装 Kit · 内置能力' : '通知 Being · 消息将公开到篝火';
  }

  /** The half of the catalogue this token needs, when it failed to load. */
  get error(): string {
    return (this.token?.kind === 'kit' ? this.directory.data.kitsError : this.directory.data.membersError) || '';
  }

  /** The status row under the options, or '' when the list speaks for itself. */
  get status(): string {
    if (this.directory.loading) return '正在加载…';
    if (this.error) return this.error;
    if (this.items.length) return '';
    return this.token?.query ? '没有匹配结果' : '暂无 Being 成员';
  }

  /** A failed read is the only state a reload button belongs to: everything else
   * is either already loading or simply empty. */
  get retryable(): boolean {
    return Boolean(this.error) && !this.directory.loading;
  }

  /**
   * Recompute against the draft and the caret.
   *
   * The notice is computed for every draft, menu or no menu: it is about the
   * message, not about the suggestions. The menu itself needs a caret inside a
   * token that has not been dismissed.
   */
  sync(text: string, caret: Caret | null) {
    const data = this.directory.data;
    const lines: string[] = [];
    const kits = composerReferences(text, data.kits, '/');
    if (kits.length) lines.push(`调用 ${kits.map(item => '/' + item.handle).join('、')}`);
    const resolved = resolve(text, data.members);
    if (resolved.members.length) {
      const byId = memberMap(data.members);
      lines.push(`发送后此消息会公开到篝火，并通知 ${resolved.members.map(id => '@' + (memberName(byId.get(id)) || id)).join('、')}`);
    }
    const warning = unresolvedNotice(text, data.members);
    if (warning) lines.push(warning);
    const notice = lines.join(' · ');
    const next = caret && this.directory.connected ? tokenAtCaret(text, caret.start, caret.end) : null;
    if (!next || this.dismissed === identify(next)) {
      this.settle({ open: false, token: null, items: [], selected: 0, notice });
      return;
    }
    const previous = this.token?.kind;
    const items = composerSuggestions(data, next);
    const selected = identify(next) === identify(this.token)
      ? Math.min(this.selected, Math.max(0, items.length - 1))
      : 0;
    this.settle({ open: true, token: next, items, selected, notice });
    // Reading the catalogue is what a `/` is worth once, and what an expired
    // member list is worth again (chat-composer.js line 138). A failed read is
    // NOT: the retry button is its cure, and re-reading on every keystroke would
    // be a request per character. DEVIATION from 0.8.26, which leaves
    // `membersExpiresAt` at zero after a failure and so does re-read.
    if (!this.directory.loading
      && ((next.kind === 'kit' && previous !== 'kit' && this.directory.loaded) || (next.kind === 'member' && this.directory.stale)))
      void this.directory.load();
  }

  /** Move within the list, wrapping at both ends. */
  move(delta: number) {
    if (!this.open || !this.items.length) return;
    this.selected = (this.selected + delta + this.items.length) % this.items.length;
    this.changed();
  }

  /**
   * The text this choice produces, or null when the caret moved out from under
   * the menu while it was open — a race a pointer can win, and one that would
   * otherwise rewrite a word the user is no longer typing.
   *
   * A member is addressed by its id. A display name is not an address, and
   * inserting one would leave a mention that notifies nobody (town-mentions.js:
   * exact ids only).
   */
  choose(index: number, text: string, caret: Caret): { text: string; caret: number } | null {
    const current = tokenAtCaret(text, caret.start, caret.end);
    const item = this.items[index];
    if (!current || !item || identify(current) !== identify(this.token)) return null;
    this.dismissed = '';
    return replaceComposerToken(text, current, { handle: item.kind === 'member' ? item.id : item.handle });
  }

  /** Escape, or an Enter with nothing to choose: this token stays quiet until
   * the caret leaves it. The draft is untouched. */
  dismiss() {
    this.dismissed = identify(this.token);
    this.close();
    this.changed();
  }

  /** The conversation or the Being changed: nothing dismissed carries over. */
  reset() {
    this.dismissed = '';
    this.close();
    this.changed();
  }

  private close() {
    this.open = false;
    this.token = null;
    this.items = [];
  }

  /**
   * Take the recomputed state, and publish it only if it is different.
   *
   * `sync` runs after every render of the composer — the draft can change from
   * outside the textarea, and the caret is DOM state React does not own — so a
   * version bump for an unchanged menu would re-render the composer, which would
   * sync again, forever. Comparing first is what makes the loop terminate.
   */
  private settle(next: { open: boolean; token: ComposerToken | null; items: ChatComposerEntry[]; selected: number; notice: string }) {
    const same = this.open === next.open
      && identify(this.token) === identify(next.token)
      && this.selected === next.selected
      && this.notice === next.notice
      && this.items.length === next.items.length
      && this.items.every((item, index) => item.id === next.items[index].id);
    this.open = next.open;
    this.token = next.token;
    this.items = next.items;
    this.selected = next.selected;
    this.notice = next.notice;
    if (!same) this.changed();
  }
}
