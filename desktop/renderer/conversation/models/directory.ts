// What `/` and `@` offer, and what an `@` costs. Ported from BeingDesktop 0.8.26
// renderer/chat-composer.js (`builtins`, `load`, `sync`, `prepare`, `publish`),
// with the menu's own state next door in ./menu.ts; 2026-09-16.
//
// Two different things share this model because they share one fact — the member
// directory:
//
//   * The `/` and `@` menus read `data.kits` and `data.members`.
//   * `prepare` decides whether an `@` in a finished message is an address, and
//     `publish` is the only place in the conversation that writes to Town.
//
// The rule that shapes both is 0.8.26's and is worth restating: a public mention
// is published ONLY after the private message is known to have been delivered,
// only from a real key press or click, and never twice. A failed publication is
// reported and dropped — never retried — because the conversation cannot tell a
// message Town refused from one whose receipt was lost on the way back.
import { Store } from '../../shared/models/store';
import type {
  ChatAPI, ChatComposerData, ChatComposerEntry, ChatSendResult, ChatState,
} from '../../../shared/desktop-types';
import type { TownDesktopAPI, TownDesktopMemberCacheState } from '../../../shared/town-desktop-types';
import { buildKitPrompt } from './completion';
import { displayNames, displayText, memberMap, resolve, unresolvedNotice } from './mentions';

/** The two abilities the Being always has. They are not installed, so no
 * catalogue read can add or remove them, and they stay in the menu while the
 * directory is unavailable (chat-composer.js line 5). */
export const builtinEntries = (): ChatComposerEntry[] => [
  { id: 'being-search', name: 'search', handle: 'search', kind: 'kit', builtin: 'search', installed: true, icon: '', description: '网络搜索 · 搜索互联网并读取网页正文。' },
  { id: 'being-browse', name: 'browse', handle: 'browse', kind: 'kit', builtin: 'browse', installed: true, icon: '', description: '网页读取 · 读取公开网页，支持 JavaScript 渲染。' },
];

export const builtinData = (): ChatComposerData => ({
  kits: builtinEntries(), members: [], kitsError: '', membersError: '',
  connectionRevision: 0, revision: 0, expiresAt: 0,
});

/** How long a directory read is trusted when the main process names no expiry
 * (chat-composer.js line 42). */
export const DIRECTORY_MS = 60000;

/** The limits a public mention is held to (chat-composer.js line 113). */
export const MAX_MENTIONS = 20, MAX_PUBLIC_CHARS = 4000;

/** What one send carries. `text` is what the Being is asked; `raw` is what Town
 * would publish — the user's own bytes, without the Kit instructions, because a
 * public message is not the place for a prompt we wrote. */
export interface ComposerPlan {
  text: string;
  raw: string;
  members: string[];
  warning: string;
  connectionRevision: number;
  /** The directory generation this plan was made against. A publication from an
   * older generation is dropped rather than sent under a new identity. */
  epoch: number;
  session: string;
}

export interface MentionWarning {
  mention: string;
  detail: string;
  candidates: { town_id: string; display_name: string }[];
}

const CONTROL = /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g;
const clean = (value: unknown, limit = 100): string =>
  typeof value === 'string' ? value.replace(CONTROL, '').slice(0, limit) : '';

const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

/** Town's `mention_warnings`, which the contract types as `unknown` because the
 * shape is upstream's, read into something a notice can list (town-mentions.js
 * `warnings` and `candidates`). */
export function mentionWarnings(value: unknown): MentionWarning[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map(item => {
    if (typeof item === 'string') return { mention: '', detail: clean(item, 500), candidates: [] };
    const entry = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const seen = new Set<string>();
    const candidates = (Array.isArray(entry.candidates) ? entry.candidates : []).slice(0, 100)
      .map(value => (value && typeof value === 'object' ? value : {}) as Record<string, unknown>)
      .filter(value => typeof value.town_id === 'string' && VALID_ID.test(value.town_id) && !seen.has(value.town_id) && seen.add(value.town_id))
      .map(value => ({ town_id: value.town_id as string, display_name: clean(value.display_name) || (value.town_id as string) }));
    return {
      mention: clean(entry.mention ?? entry.name ?? entry.display_name ?? entry.query ?? entry.token ?? entry.input),
      detail: clean(entry.message ?? entry.reason ?? entry.warning, 500),
      candidates,
    };
  });
}

/** What the composer shows after a publication: the lines 0.8.26's
 * `renderReceipt` wrote into `.chat-composer-notice`, plus the candidates a
 * warning offered so an ambiguous mention can be corrected in the next draft. */
export interface PublishReceipt { lines: string[]; warnings: MentionWarning[] }

export interface DirectoryOptions {
  chat?: ChatAPI;
  /** Reported to the user, never thrown: a notice about a notification is not a
   * reason to lose the message it was about. */
  toast: (message: unknown) => void;
  now?: () => number;
  randomUUID?: () => string;
}

export class ComposerDirectory extends Store {
  data: ChatComposerData = builtinData();
  loading = false;
  loaded = false;
  connected = false;
  /** The last publication's own notice, cleared whenever the conversation or the
   * Being changes — a receipt for a message nobody is looking at any more is
   * noise (chat-composer.js lines 92 and 93). */
  receipt: PublishReceipt | null = null;
  private identity = '';
  private names: ReadonlyMap<string, string> = new Map();
  private namesFor: ChatComposerData | null = null;
  private projector: (text: string) => string = text => text;
  private currentSession = '';
  private generation = 0;
  private membersExpiresAt = 0;
  private membersRevision: number | null = null;
  private town?: TownDesktopAPI;
  private readonly now: () => number;
  private readonly uuid: () => string;

  constructor(private readonly options: DirectoryOptions) {
    super();
    this.now = options.now || (() => Date.now());
    this.uuid = options.randomUUID || (() => crypto.randomUUID());
  }

  get session() { return this.currentSession; }
  get epoch() { return this.generation; }
  get members(): ChatComposerEntry[] { return this.data.members; }
  /**
   * The same directory, keyed for reading rather than for resolving: id → the
   * name the transcript paints in place of it (chat-composer.js hands this list
   * to chat-app.js through `onMembersChanged`, which repaints).
   *
   * Cached against `this.data` by identity, because the transcript asks for it on
   * every repaint — including every streamed token — and rebuilds nothing until
   * a read replaces the directory.
   */
  get displayNames(): ReadonlyMap<string, string> {
    if (this.namesFor !== this.data) {
      this.namesFor = this.data;
      const names = this.names = displayNames(this.data.members);
      this.projector = text => displayText(text, names);
    }
    return this.names;
  }

  /** `displayText` bound to the current directory.
   *
   * A property rather than a closure built in the view, and that is the whole
   * point: it keeps the same identity until a read replaces the directory, so the
   * memoized message bodies below it are not thrown away on every streamed token —
   * and they ARE thrown away, exactly once, when the names change. */
  get project(): (text: string) => string {
    void this.displayNames;
    return this.projector;
  }
  get kits(): ChatComposerEntry[] { return this.data.kits; }
  get hasTown(): boolean { return Boolean(this.town); }

  /**
   * Hand the directory the Town bridge, from the feature model registered in
   * app/models/registry.ts. It is optional on purpose: without it the menus and
   * the notices all work and only the publication is refused, which is the right
   * behaviour for a shell whose Town half is not installed.
   */
  bindTown(town: TownDesktopAPI): () => void {
    this.town = town;
    // The member directory was invalidated upstream (a `profile_changed` event).
    // Drop ours: a name that moved is worse than no name, because it addresses
    // the wrong Being.
    return town.onMembersInvalidated?.((cache: TownDesktopMemberCacheState) => this.invalidate(cache)) || (() => {});
  }

  invalidate(cache?: TownDesktopMemberCacheState) {
    if (cache && this.membersRevision !== null && cache.revision === this.membersRevision) return;
    if (cache) this.membersRevision = cache.revision;
    this.membersExpiresAt = 0;
    this.loaded = false;
    this.loading = false;
    this.generation++;
    this.changed();
    if (this.connected) void this.load();
  }

  /**
   * Follow the conversation layer. A new Being empties the directory before
   * anything is read against it — the previous Being's members are not this
   * one's — and a new conversation drops the previous one's receipt.
   */
  sync(state: ChatState) {
    const identity = JSON.stringify([state.identityKey, state.open]);
    this.connected = state.open;
    if (identity !== this.identity) {
      this.identity = identity;
      this.generation++;
      this.data = builtinData();
      this.loaded = false;
      this.loading = false;
      this.receipt = null;
    }
    const session = state.open ? state.active : '';
    if (session !== this.currentSession) {
      this.currentSession = session;
      this.receipt = null;
    }
    this.changed();
    if (this.connected && !this.loaded && !this.loading) void this.load();
  }

  /**
   * Read the catalogue. A failure keeps the built-in abilities and says which
   * half is missing, so `/search` still works while the Kit list is unavailable
   * (chat-composer.js line 45).
   */
  async load(force = false) {
    if (this.loading || !this.connected || !this.options.chat) return;
    const ticket = this.generation;
    this.loading = true;
    this.changed();
    try {
      const result = await this.options.chat.composerData({ force });
      if (ticket !== this.generation) return;
      // Only entries addressed by a valid id survive: the menu's whole promise is
      // that choosing a row inserts something that resolves.
      this.data = { ...result, members: [...memberMap(result.members).values()] };
      this.loaded = true;
      this.membersExpiresAt = result.expiresAt || this.now() + DIRECTORY_MS;
      this.membersRevision = result.revision ?? this.membersRevision;
    } catch {
      if (ticket !== this.generation) return;
      this.data = { ...builtinData(), kitsError: '工具目录暂时无法加载。', membersError: 'Being 成员暂时无法加载。' };
      this.loaded = true;
    } finally {
      if (ticket === this.generation) {
        this.loading = false;
        this.changed();
      }
    }
  }

  /** Our copy of the member list is current enough to decide what an `@` means. */
  get fresh(): boolean {
    return this.loaded && !this.loading && !this.data.membersError && this.now() < this.membersExpiresAt;
  }

  /** Worth reading again for a member token. A failed read is excluded: it has
   * a retry button of its own, and treating it as staleness would mean one
   * request per keystroke. */
  get stale(): boolean {
    return !this.data.membersError && this.now() >= this.membersExpiresAt;
  }

  /**
   * Turn a finished draft into a plan, or refuse it.
   *
   * `trusted` is whether the send came from a real key press or click. A public
   * message is a consequence a page's own script must not be able to cause, so a
   * synthetic submit is refused outright rather than sent privately with the
   * publication quietly skipped (chat-composer.js line 111).
   */
  prepare(text: string, trusted: boolean): ComposerPlan {
    const resolved = resolve(text, this.data.members);
    // An `@` typed against a stale directory is worth one more read, in the
    // background: the message still goes now, with what is known now.
    if (!this.fresh && !this.loading && /(^|\s)@[^\s/@]+/u.test(text)) void this.load();
    const members = resolved.members;
    if (members.length && (!trusted || !Number.isSafeInteger(this.data.connectionRevision)))
      throw new Error('请在输入框按 Enter 或点击发送，确认公开通知 Being。');
    if (members.length && text.includes('\0'))
      throw new Error('公开通知不能包含空字符，请检查消息内容。');
    if (members.length > MAX_MENTIONS || (members.length && resolved.text.length > MAX_PUBLIC_CHARS))
      throw new Error(`公开通知最多提及 ${MAX_MENTIONS} 位 Being，消息不能超过 ${MAX_PUBLIC_CHARS} 字。`);
    const warning = unresolvedNotice(text, this.data.members);
    if (warning) this.options.toast(warning);
    this.receipt = warning ? { lines: [warning], warnings: [] } : null;
    this.changed();
    return {
      text: buildKitPrompt(resolved.text, this.data.kits),
      raw: resolved.text,
      members,
      warning,
      connectionRevision: this.data.connectionRevision,
      epoch: this.generation,
      session: this.currentSession,
    };
  }

  /**
   * Publish the mention, once, after the private message landed.
   *
   * Every early return is a refusal to guess: an unconfirmed private delivery, a
   * Being that changed under the send, a Town that is not installed. None of them
   * retries — a publication whose receipt was lost has still been made, and
   * sending it again would say the same thing twice in public.
   */
  async publish(plan: ComposerPlan, result: ChatSendResult | null | undefined) {
    if (!plan.members.length) return;
    const toast = (message: string) => this.options.toast(message);
    if (!result || (!result.streamed && !result.spliced))
      return toast('聊天送达状态待确认，尚未发布篝火通知；不会自动重发。');
    if (plan.epoch !== this.generation || !this.connected)
      return toast('Being 连接已变化，尚未发布篝火通知。');
    if (!this.town)
      return toast('本机未接入 Town，尚未发布篝火通知；不会自动重发。');
    try {
      const receipt = await this.town.speak({
        kind: 'bonfire', content: plan.raw, mentions: plan.members,
        connectionRevision: plan.connectionRevision, requestId: this.uuid(),
      });
      if (receipt?.ok !== true || !receipt.id)
        return toast('篝火通知未确认送达，请打开篝火检查；不会自动重发。');
      // The receipt arrived for a conversation nobody is looking at any more.
      if (plan.epoch !== this.generation || plan.session !== this.currentSession) return;
      const warnings = mentionWarnings(receipt.mention_warnings);
      const lines = ['消息已公开到篝火。'];
      lines.push(receipt.mentions?.length
        ? `Town 已接受提及通知：${receipt.mentions.map(id => '@' + clean(id)).join('、')}`
        : 'Town 尚未确认提及通知。');
      if (warnings.length) lines.push('部分提及未送达；消息已发布，已接受的提及不受影响。');
      if (plan.warning) lines.push(plan.warning);
      this.receipt = { lines, warnings };
      this.changed();
      toast(warnings.length
        ? '消息已公开到篝火；部分提及未送达，请查看下方候选列表。'
        : receipt.mentions?.length
          ? '消息已公开到篝火，Town 已接受提及通知。'
          : '消息已公开到篝火；Town 尚未确认提及通知。');
    } catch {
      toast('篝火通知未确认送达，请打开篝火检查；不会自动重发。');
    }
  }
}
