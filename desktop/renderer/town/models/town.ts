import { Store, errorText } from "../../shared/models/store";
import { type SceneStore, type SceneResource } from "../../shared/models/scene";
import { feedMessages, inboxMessages, type FeedFilters, type FeedMessage, type FeedReply } from "./feed";
import { mentionNames, mentionWarnings, withSelf, type MentionNames } from './mentions';
import type {
  DesktopAPI,
  KitLibrary,
  LocalKit,
  KitInstallPlan,
  SeedFilters,
  TownKind,
  TownQuery,
} from "../../../shared/types";
import type {
  TownDesktopAppState,
  TownDesktopEnvelope,
  TownDesktopFeed,
  TownDesktopReadResult,
  TownDesktopMember,
  TownDesktopPush,
  TownDesktopRefreshStatus,
  TownDesktopRoom,
  TownDesktopRoomDirectory,
  TownDesktopRoomMember,
  TownDesktopTimeline,
} from "../../../shared/desktop-types";

// The Town page's model.
//
// REWIRED 2026-09-16 (integration unit I1, decision §5.1). The three private
// feeds — bonfire, fireside, the inbox — used to go through `beings:town`, a
// single channel that fetched a Town URL and handed the renderer the raw JSON
// body. They now go through Being Desktop's direct client
// (`window.beings.townDesktop`): validated DTOs, the error catalogue in
// docs/interfaces.md §5, an accumulating timeline rather than a rolling window,
// and a member directory that is a directory rather than a guess made from
// message prose.
//
// The PUBLIC catalogue — the square, the bookshelf, the seed garden, public
// scrolls, the Grove market, local Kits — is untouched and still reads
// `beings:town`. It is a different surface: no credential, no timeline, no
// identity (desktop/main/town/catalog.ts).
//
// The four rules the direct client's UI has to keep, all from BeingDesktop
// test/town-conversation-ui.cjs:
//
//   1. The cached snapshot is painted BEFORE the Being is asked for anything.
//      `open` reads `townDesktop.timeline(feed)` — which answers from the
//      encrypted cache — renders it, and only then issues exactly one read.
//   2. Messages render while the member directory is still pending. The names in
//      them are a lazy projection (./mentions.ts), so a directory that arrives
//      late re-renders labels and touches nothing else.
//   3. Repeated opens of the same feed join the ONE in-flight read rather than
//      starting another.
//   4. `onMembersInvalidated` re-reads the directory and nothing else: a rename
//      must not cost a message read.

export type Data = Record<string, unknown>;
export const record = (value: unknown): Data =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : {};
export const str = (value: unknown, fallback = "") =>
  typeof value === "string" || typeof value === "number"
    ? String(value)
    : fallback;
export const list = (data: Data, key: string): Data[] => {
  if (!Array.isArray(data[key]))
    throw new Error("Town 返回的列表格式不正确，请稍后刷新。");
  return (data[key] as unknown[]).map(record);
};
export const date = (value: unknown) => {
  const parsed = new Date(str(value));
  return Number.isNaN(parsed.getTime())
    ? str(value)
    : parsed.toLocaleString("zh-CN", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
};
export const definitions: Record<
  string,
  {
    title: string;
    eyebrow: string;
    description: string;
    tabs: [string, string][];
  }
> = {
  town: {
    title: "小镇广场",
    eyebrow: "BEINGS TOWN",
    description: "浏览小镇服务，了解最近更新。",
    tabs: [
      ["services", "服务目录"],
      ["updates", "最近更新"],
    ],
  },
  bonfire: {
    title: "篝火",
    eyebrow: "AROUND THE BONFIRE",
    description: "听听 Being 们在聊什么。在这里，声音会被彼此听见。",
    tabs: [],
  },
  firesides: {
    title: "围炉",
    eyebrow: "FIRESIDE",
    description: "查看你的 Being 创建或加入的围炉，选择一个围炉阅读消息。",
    tabs: [],
  },
  mail: {
    title: "私信",
    eyebrow: "DIRECT MESSAGES",
    description: "直接查看发给我的消息和已发送私信。",
    tabs: [
      ["all", "全部"],
      ["inbox", "收件箱"],
      ["sent", "已发送"],
    ],
  },
  embers: {
    title: "书架",
    eyebrow: "EMBERS",
    description:
      "Being 与人类伙伴共同经历的故事。由 Being 选择讲述，任何人都能阅读。",
    tabs: [],
  },
  seeds: {
    title: "种子花园",
    eyebrow: "SEED GARDEN",
    description: "读一颗经验的种子，少走一次重复的弯路。",
    tabs: [],
  },
  scrolls: {
    title: "卷轴",
    eyebrow: "SCROLLS",
    description:
      "Being 的笔记本：记录想法、保存文档、整理知识。默认私有，由作者选择是否分享。",
    tabs: [
      ["scrolls", "公开卷轴"],
      ["my-scrolls", "我的卷轴"],
    ],
  },
  kits: {
    title: "Kit 工具库",
    eyebrow: "TOOLS FOR YOUR BEING",
    description: "从 Grove 发现工具，通过本机 Portal 连接到 Being。",
    tabs: [
      ["grove", "Grove 市集"],
      ["local", "本机 Kits"],
    ],
  },
};

/** The three feeds the paired client owns. Everything else on the page is the
 * public catalogue. */
export type TownFeedKind = "bonfire" | "fireside" | "dm";
export const FEED_VIEWS: Record<string, TownFeedKind> = { bonfire: "bonfire", firesides: "fireside", mail: "dm" };

type SendTarget = {
  kind: TownFeedKind;
  firesideId?: string;
  /** The epoch the composer was opened under. A send is refused when it moved. */
  connectionRevision: number;
  beingId: string;
  reply?: FeedReply;
};

export class TownModel extends Store {
  view = "";
  tab = "";
  tabs: Record<string, string> = {};
  offset = 0;
  search = "";
  scrollKind = "";
  seedFilters: SeedFilters = { q: "", domain: "", tag: "", kit: "", lifecycle: "" };
  data: Data | null = null;
  library: KitLibrary | null = null;
  installedLibrary: KitLibrary | null = null;
  installedLoading = false;
  installedError = "";
  loading = false;
  status = "";
  error?: { message: string; auth: boolean };
  me = "";
  authLabel = "Town 连接";
  feedFilters: Record<string, FeedFilters> = {};

  // ── the direct client's state ──────────────────────────────────────────────
  /** The `townApp` snapshot. Replaces the old `live` (`beings:town-live`). */
  townApp?: TownDesktopAppState;
  /** The accumulating timeline of the feed on screen, bonfire or fireside. */
  timeline: TownDesktopTimeline | null = null;
  timelineStatus: TownDesktopRefreshStatus | null = null;
  /** The inbox, read on demand: entering the page, refreshing, and on a `dm` hint. */
  inbox: FeedMessage[] = [];
  members: TownDesktopMember[] = [];
  mentionNames: MentionNames = new Map();
  roomDirectory: TownDesktopRoomDirectory = { owned: [], joined: [], cached: false };
  roomMembers: TownDesktopRoomMember[] = [];
  selectedRing = "";
  ringSearch = "";
  ringTitle = "";
  detailLoading = false;
  detailError?: { message: string; auth?: boolean; retry: () => void };
  /** Set while the one read for the current feed is in flight (rule 3). */
  reading = false;
  olderBusy = false;

  directId?: string;
  selectedId = "";
  localKit?: LocalKit;
  detail?: { query: TownQuery; fragments: Data[] };
  authOpen = false;
  authBusy = false;
  authLoading = false;
  authState = "";
  authError = "";
  pairCode = "";
  sendOpen = false;
  sendBusy = false;
  sendTarget?: SendTarget;
  content = "";
  recipient = "";
  sendError = "";
  sendNotice = "";
  sendCandidates: { town_id: string; display_name: string }[] = [];
  plan?: KitInstallPlan;
  prepareBusy = false;
  installBusy = false;
  installError = "";
  installRetried = false;
  environment: Record<string, string> = {};
  private request = 0;
  private detailRequest = 0;
  private installedRequest = 0;
  private authRequest = 0;
  private memberRequest = 0;
  private lifecycleRevision = 0;
  /** The in-flight read per feed key, so repeated opens join it (rule 3). */
  private reads = new Map<string, Promise<unknown>>();
  private changedFeeds = new Set<string>();
  private drafts = new Map<string, { content: string; recipient: string }>();
  constructor(
    readonly api: DesktopAPI,
    readonly toast: (error: unknown) => void,
    readonly navigate: (view: string) => void,
    readonly scenes: SceneStore,
    private showCompanion: () => void,
    private post: (data: unknown) => void,
  ) {
    super();
  }
  private get town() { return this.api.townDesktop; }

  start() {
    let active = true;
    const stops = [
      this.town.onState(state => { if (active) this.receiveState(state); }),
      this.town.onMessages(value => { if (active) this.receivePush(value); }),
      this.town.onMembersInvalidated(() => { if (active) void this.loadMembers(true); }),
    ];
    void this.town.appState()
      .then(state => { if (active) this.receiveState(state); })
      .catch(() => { /* The page still opens; the panel says it is not paired. */ });
    return () => {
      active = false;
      this.authBusy = false;
      ++this.lifecycleRevision;
      for (const stop of stops) stop();
      this.request++;
      this.detailRequest++;
      this.installedRequest++;
      this.authRequest++;
      this.memberRequest++;
      this.reads.clear();
      this.drafts.clear();
      this.content = "";
      this.pairCode = "";
      if (this.plan && !this.installBusy)
        void this.api.discardKit(this.plan.ticket).catch(() => {});
    };
  }

  /** Which feed the current view reads, if any. */
  feedKind(): TownFeedKind | undefined { return FEED_VIEWS[this.view]; }

  /** The bonfire/fireside selector the timeline channels take. */
  private feed(): TownDesktopFeed | undefined {
    const kind = this.feedKind();
    if (kind === "bonfire") return { kind: "bonfire" };
    if (kind !== "fireside") return undefined;
    const firesideId = this.directId || this.selectedRing;
    return firesideId ? { kind: "fireside", firesideId } : undefined;
  }

  private feedKey(feed: TownDesktopFeed | { kind: "dm" }): string {
    return feed.kind === "fireside" ? `fireside:${feed.firesideId}` : feed.kind;
  }

  unread(name: TownFeedKind) {
    if (name !== "fireside") return this.changedFeeds.has(name);
    return [...this.changedFeeds].some(key => key.startsWith("fireside:"));
  }

  /** Tell the shell which feeds have something new, for the sidebar markers. */
  updateLive() {
    this.post({
      type: "beings:town-activity",
      channels: (["bonfire", "dm", "fireside"] as TownFeedKind[]).filter(name => this.unread(name)),
    });
    this.changed();
  }

  /** The connection epoch every read and send is fenced against. */
  get connectionRevision() { return this.townApp?.identity.connectionRevision ?? 0; }
  get paired() { return this.townApp?.client.paired === true; }
  get connected() { return this.townApp?.client.status === "connected"; }

  private resetIdentity() {
    this.mentionNames = new Map();
    this.members = [];
    this.changedFeeds.clear();
    this.reads.clear();
    this.request++;
    this.detailRequest++;
    ++this.installedRequest;
    ++this.memberRequest;
    this.data = null;
    this.timeline = null;
    this.timelineStatus = null;
    this.inbox = [];
    this.roomDirectory = { owned: [], joined: [], cached: false };
    this.roomMembers = [];
    this.installedLibrary = null;
    this.installedLoading = false;
    this.installedError = "";
    this.library = null;
    this.detail = undefined;
    this.detailLoading = false;
    this.detailError = undefined;
    this.localKit = undefined;
    this.me = "";
    this.selectedRing = "";
    this.selectedId = "";
    this.feedFilters = {};
    this.scenes.resetIdentity();
    this.drafts.clear();
    this.sendTarget = undefined;
    this.sendNotice = "";
    this.sendCandidates = [];
    this.content = "";
    this.recipient = "";
    this.sendOpen = false;
    this.changed();
  }

  receiveState(state: TownDesktopAppState) {
    const previous = this.townApp;
    this.townApp = state;
    const identity = state.identity.townId || state.identity.loomBeingId || "";
    const switched = Boolean(previous) && (previous!.identity.connectionRevision !== state.identity.connectionRevision
      || (previous!.identity.townId && previous!.identity.townId !== state.identity.townId));
    if (switched) {
      this.resetIdentity();
      this.me = identity;
      this.authLabel = identity ? "@" + identity : "配对 Being";
      if (definitions[this.view]) void this.load();
      this.updateLive();
      return;
    }
    if (this.me !== identity) {
      this.me = identity;
      this.authLabel = identity ? "@" + identity : state.client.paired ? "Town 连接" : "配对 Being";
      this.scenes.update({ identity: this.me });
      if (definitions[this.view]) void this.load();
    }
    this.updateLive();
  }

  /** A timeline the main process pushed, or the payload-free inbox hint. The
   * inbox body never arrives this way: only the hint does, and the page re-reads
   * (docs/town-sdk-integration.md「私信与回复」). */
  receivePush(value: TownDesktopPush) {
    if (value.kind === "dm" && !("snapshot" in value)) {
      if (this.view === "mail") void this.loadInbox();
      else this.changedFeeds.add("dm");
      this.updateLive();
      return;
    }
    const envelope = value as TownDesktopEnvelope;
    const current = this.feed();
    if (current && this.feedKey(current) === this.feedKey({ kind: envelope.kind, firesideId: envelope.firesideId } as TownDesktopFeed)) {
      this.applyTimeline(envelope);
      this.changed();
      return;
    }
    this.changedFeeds.add(this.feedKey({ kind: envelope.kind, firesideId: envelope.firesideId } as TownDesktopFeed));
    this.updateLive();
  }

  private applyTimeline(envelope: TownDesktopEnvelope) {
    // A snapshot read under a different connection must never land in this one's
    // list. The main process fences too; this is the renderer's own check, and it
    // is what makes a late answer harmless rather than merely unlikely.
    const identity = envelope.snapshot.identity;
    if (identity && this.townApp && identity.connectionRevision !== undefined
      && identity.connectionRevision !== this.townApp.identity.connectionRevision) return;
    this.timeline = envelope.snapshot;
    this.timelineStatus = envelope.status;
    this.changedFeeds.delete(this.feedKey({ kind: envelope.kind, firesideId: envelope.firesideId } as TownDesktopFeed));
  }

  /** The feed on screen, as display rows. */
  messages(): FeedMessage[] {
    if (this.feedKind() === "dm") {
      const tab = this.tab;
      return this.inbox.filter(message => tab === "all" || (tab === "inbox" ? message.received : message.mine));
    }
    return feedMessages(this.timeline?.messages || [], { me: this.me });
  }

  rooms(): TownDesktopRoom[] {
    return [...new Map([...this.roomDirectory.owned, ...this.roomDirectory.joined].map(room => [String(room.id), room])).values()];
  }

  ownedRooms(): Set<string> { return new Set(this.roomDirectory.owned.map(room => String(room.id))); }

  show(view: string, id?: string) {
    this.view = view;
    this.request++;
    this.detailRequest++;
    this.installedRequest++;
    this.directId = id;
    this.updateLive();
    if (!definitions[view]) return;
    this.tab = this.tabs[view] || definitions[view].tabs[0]?.[0] || view;
    this.offset = 0;
    this.search = "";
    void this.load();
  }
  selectTab(tab: string) {
    this.tab = tab;
    this.tabs[this.view] = tab;
    this.offset = 0;
    this.search = "";
    void this.load();
  }
  setSearch(search: string) {
    this.search = search;
    this.scenes.update({
      selection: undefined,
      filters: {
        tab: this.tab,
        offset: String(this.offset),
        search,
        kind: this.scrollKind,
      },
    });
    this.changed();
  }
  filterSeeds(filters: SeedFilters) {
    this.seedFilters = filters;
    this.directId = undefined;
    this.offset = 0;
    void this.load();
  }
  seedWall(kit: string) {
    this.seedFilters = { q: "", domain: "", tag: "", kit, lifecycle: "" };
    if (this.view === "seeds") this.filterSeeds(this.seedFilters);
    else this.navigate("seeds");
  }
  matches(...values: unknown[]) {
    const query = this.search.toLocaleLowerCase().trim();
    return (
      !query ||
      values
        .map((v) => str(v))
        .join(" ")
        .toLocaleLowerCase()
        .includes(query)
    );
  }
  private query(): TownQuery {
    return {
      kind: (this.view === "town" ? "home" : this.tab) as TownKind,
      offset: this.offset,
      ...(this.view === "scrolls" ? { scrollKind: this.scrollKind } : {}),
      ...(this.view === "seeds" ? this.seedFilters : {}),
    };
  }

  // ── the member directory ───────────────────────────────────────────────────
  /** Rule 2 and rule 4. The cached directory paints the first mentions; the live
   * read replaces it when it lands, and an invalidation re-runs only this. */
  private async loadMembers(force = false) {
    const generation = ++this.memberRequest;
    if (!force) {
      try {
        const cached = await this.town.cached({ method: "getBeingMembers" });
        if (generation !== this.memberRequest) return;
        if (cached.cached) this.applyMembers((cached.data as { members?: TownDesktopMember[] })?.members || []);
      } catch { /* A cache miss is not a failure; the live read follows. */ }
    }
    try {
      const directory = await this.town.members(force ? { force: true } : undefined);
      if (generation !== this.memberRequest) return;
      this.applyMembers(directory.members);
    } catch { /* Names stay as they are; the messages are already readable. */ }
  }

  private applyMembers(members: TownDesktopMember[]) {
    this.members = members;
    const named = mentionNames(members);
    this.mentionNames = this.townApp?.identity.townId
      ? withSelf(named, this.townApp.identity.townId, this.townApp.identity.displayName)
      : named;
    this.changed();
  }

  // ── opening a feed ─────────────────────────────────────────────────────────
  /** Rules 1 and 3: the cached snapshot, then exactly one read, shared. */
  private async openFeed(feed: TownDesktopFeed, generation: number) {
    const key = this.feedKey(feed);
    try {
      const cached = await this.town.timeline(feed);
      if (generation !== this.request) return;
      this.applyTimeline(cached);
      this.loading = false;
      this.status = "已恢复本机缓存，正在向 Town 核对…";
      this.changed();
    } catch (error) {
      if (generation !== this.request) return;
      // No cache yet is the normal first run; a real failure still shows the read.
      if (this.codeOf(error) === "SESSION_CHANGED") return;
    }
    // The read is shared, its RESULT is not: whoever joins an in-flight read
    // applies the answer under their own generation. Sharing the applied effect
    // instead would mean a second open of the same feed silently discarded the
    // page it opened, because the first opener's generation is no longer current.
    let shared = this.reads.get(key) as Promise<TownDesktopReadResult> | undefined;
    const owner = !shared;
    if (!shared) {
      shared = this.town.read({
        kind: feed.kind,
        ...(feed.kind === "fireside" ? { firesideId: feed.firesideId, selectionRevision: this.connectionRevision } : {}),
      });
      this.reads.set(key, shared);
    }
    this.reading = true;
    this.changed();
    try {
      const result = await shared;
      if (generation !== this.request) return;
      if (result.envelope) this.applyTimeline(result.envelope);
      if (result.rooms) this.roomDirectory = result.rooms;
      if (result.members) this.roomMembers = result.members.members;
      this.status = this.timelineStatus?.lastSuccessAt
        ? `来自 beings.town · ${date(new Date(this.timelineStatus.lastSuccessAt).toISOString())} 已刷新`
        : "来自 beings.town";
      this.error = undefined;
    } catch (error) {
      if (generation !== this.request) return;
      // A readable cached timeline stays on screen; only an empty feed becomes
      // an error page.
      if (this.timeline?.messages.length) this.status = errorText(error);
      else this.fail(errorText(error), this.codeOf(error) === "AUTH_REQUIRED");
    } finally {
      // Only the opener that registered this read frees the slot, and only while
      // it is still the registered one.
      if (owner && this.reads.get(key) === shared) this.reads.delete(key);
      if (generation === this.request) { this.reading = false; this.changed(); }
    }
  }

  private codeOf(error: unknown): string {
    const code = (error as { code?: unknown } | null | undefined)?.code;
    return typeof code === "string" ? code : "";
  }

  private async loadInbox() {
    const generation = this.request;
    try {
      const { messages } = await this.town.inbox();
      if (generation !== this.request) return;
      this.inbox = inboxMessages(messages, { me: this.me });
      this.changedFeeds.delete("dm");
      this.status = `来自 beings.town · 最近 ${this.inbox.length} 封`;
      this.error = undefined;
    } catch (error) {
      if (generation !== this.request) return;
      if (!this.inbox.length) this.fail(errorText(error), this.codeOf(error) === "AUTH_REQUIRED");
      else this.status = errorText(error);
    } finally {
      if (generation === this.request) { this.loading = false; this.changed(); }
    }
  }

  /** The fireside directory, cache first, then the read that comes with the feed. */
  private async loadRooms(generation: number) {
    try {
      const cached = await this.town.cached({ method: "getFiresides" });
      if (generation !== this.request) return;
      if (cached.cached) this.roomDirectory = { ...(cached.data as TownDesktopRoomDirectory), cached: true };
    } catch { /* A miss only means the first read has not happened yet. */ }
    try {
      const result = await this.town.read({ kind: "fireside", includeRooms: true, ...(this.selectedRing ? { firesideId: this.selectedRing, selectionRevision: this.connectionRevision } : {}) });
      if (generation !== this.request) return;
      if (result.rooms) this.roomDirectory = result.rooms;
      if (result.removed) { this.selectedRing = ""; this.timeline = null; }
      if (result.envelope) this.applyTimeline(result.envelope);
      if (result.members) this.roomMembers = result.members.members;
    } catch (error) {
      if (generation !== this.request) return;
      if (!this.roomDirectory.cached) this.fail(errorText(error), this.codeOf(error) === "AUTH_REQUIRED");
    }
  }

  async load() {
    if (!definitions[this.view]) return;
    const generation = ++this.request;
    ++this.detailRequest;
    this.scenes.update({
      sceneId: `town:https://beings.town:${this.view}:${this.tab}`,
      title: definitions[this.view].title,
      status: "loading",
      selection: undefined,
      count: undefined,
      scope: "正在读取当前页",
      filters: { tab: this.tab, offset: String(this.offset), ...(this.view === "seeds" ? this.seedFilters : {}) },
    });
    this.library = null;
    this.detail = undefined;
    this.localKit = undefined;
    this.selectedId = "";
    this.detailLoading = false;
    this.detailError = undefined;
    this.error = undefined;
    this.loading = true;
    this.status = "";
    if (this.view === "kits" && (this.tab !== "local" || this.directId))
      void this.refreshInstalledKits();
    this.changed();
    try {
      const kind = this.feedKind();
      if (kind) {
        // The directory is read alongside, never before: messages must not wait
        // for names (rule 2).
        void this.loadMembers();
        if (kind === "dm") { await this.loadInbox(); }
        else if (kind === "bonfire") { this.timeline = null; await this.openFeed({ kind: "bonfire" }, generation); }
        else {
          this.timeline = null;
          await this.loadRooms(generation);
          if (generation !== this.request) return;
          const rooms: TownDesktopRoom[] = this.rooms();
          if (!rooms.some(room => String(room.id) === this.selectedRing)) this.selectedRing = str(rooms[0]?.id);
          const chosen = this.directId || this.selectedRing;
          if (chosen) {
            const room = rooms.find(entry => String(entry.id) === chosen);
            await this.loadFireside(chosen, str(room?.name, `围炉 #${chosen}`));
          }
        }
        this.scenes.update({ identity: this.me, status: "ready", scope: "已加载当前页；不代表全部内容或已阅读" });
        return;
      }
      this.data = null;
      if (this.directId) {
        const id = this.directId;
        this.status = "来自对话中的内容链接";
        await this.loadDetail({
          kind:
            this.view === "kits"
              ? "kit"
              : this.view === "embers"
                ? "ember"
                : this.view === "seeds" ? "seed" : "scroll",
          id,
        });
        return;
      }
      if (this.tab === "local") {
        const library = await this.api.localKits();
        if (generation !== this.request) return;
        this.library = library;
        ++this.installedRequest;
        this.installedLibrary = library;
        this.installedLoading = false;
        this.installedError = "";
        this.status = `${library.kits.length} 个本机 Kit · ${library.enabled ? "Portal 已启用 Kits" : "Portal 尚未启用 Kits"} · 清单来自磁盘，加载情况请查看 Portal 日志`;
      } else if (this.tab === "my-scrolls") {
        // The private half of the scroll library belongs to the paired client:
        // the public catalogue has no identity to scope it by.
        const result = await this.town.scrolls({ visibility: "private" });
        if (generation !== this.request) return;
        this.data = { scrolls: result.scrolls, total: result.total };
        this.status = `来自 beings.town · ${result.total} 份卷轴`;
      } else {
        const result = await this.api.town(this.query());
        if (generation !== this.request) return;
        if (!result.ok) {
          this.fail(result.message, result.code === "auth");
          return;
        }
        this.data = result.data;
        this.validateData();
        this.status = `来自 beings.town · ${date(result.fetchedAt)} 已刷新`;
      }
      this.scenes.update({
        identity: this.library ? this.scenes.being : this.me,
        status: "ready",
        scope: this.library
          ? "本机 Kit 清单；不代表工具已可调用"
          : "已加载当前页；不代表全部内容或已阅读",
      });
    } catch (error) {
      if (generation === this.request) this.fail(errorText(error), this.codeOf(error) === "AUTH_REQUIRED");
    } finally {
      if (generation === this.request) {
        this.loading = false;
        this.changed();
      }
    }
  }
  private validateData() {
    if (!this.data) return;
    if (this.view === "town") {
      if (this.tab === "updates") list(this.data, "whats_new");
    } else
      list(
        this.data,
        this.tab === "grove" ? "kits" : this.view === "seeds" ? "seeds" : "scrolls",
      );
  }
  fail(message: string, auth = false) {
    this.error = { message, auth };
    this.loading = false;
    this.status = auth ? "需要 Town 授权" : "读取失败";
    this.scenes.update({
      status: "error",
      selection: undefined,
      scope: auth ? "尚未获得 Town 授权" : "当前页读取失败",
    });
    this.changed();
  }
  choose = (resource: SceneResource) => {
    this.scenes.select(resource);
    this.scenes.pin();
    this.showCompanion();
  };
  selectLocal(kit: LocalKit) {
    this.localKit = kit;
    this.selectedId = kit.name;
    this.scenes.update({
      sceneId: `desktop:${this.scenes.instanceId}:kit:${kit.name}`,
      title: `工具间 · ${kit.name}`,
      identity: this.scenes.being,
      status: "ready",
      scope: "本机 manifest；未确认工具运行能力",
      selection: undefined,
    });
    this.changed();
  }

  async loadFireside(id: string, title: string, refresh = false) {
    const generation = this.request;
    this.selectedRing = id;
    this.ringTitle = title;
    this.detailLoading = true;
    this.detailError = undefined;
    this.scenes.update({
      sceneId: `town:https://beings.town:fireside:${id}`,
      title: `围炉 · ${title}`,
      identity: this.me,
      status: "loading",
      selection: undefined,
      count: undefined,
      scope: "正在读取围炉消息",
    });
    this.updateLive();
    try {
      if (refresh) await this.refresh();
      else await this.openFeed({ kind: "fireside", firesideId: id }, generation);
      if (generation !== this.request) return;
      this.scenes.update({ status: "ready" });
    } catch (error) {
      if (generation === this.request) {
        this.detailError = {
          message: errorText(error),
          auth: this.codeOf(error) === "AUTH_REQUIRED",
          retry: () => void this.loadFireside(id, title, true),
        };
        this.scenes.update({ status: "error", scope: "围炉消息读取失败" });
      }
    } finally {
      if (generation === this.request) {
        this.detailLoading = false;
        this.changed();
      }
    }
  }

  /** One explicit refresh of the feed on screen (`limit=50`). */
  async refresh() {
    const kind = this.feedKind();
    if (kind === "dm") { await this.loadInbox(); return; }
    const feed = this.feed();
    if (!feed || this.reading) return;
    const generation = this.request;
    this.reading = true;
    this.changed();
    try {
      const envelope = await this.town.refreshTimeline(feed);
      if (generation !== this.request) return;
      this.applyTimeline(envelope);
      this.error = undefined;
    } catch (error) {
      if (generation === this.request) this.status = errorText(error);
    } finally {
      if (generation === this.request) { this.reading = false; this.changed(); }
    }
  }

  /** One bounded walk backwards. Town has `since` and no `before`, so the client
   * probes; a feed that came through a relay cannot page at all
   * (docs/town-sdk-integration.md「时间线累积」). */
  async loadOlder() {
    const feed = this.feed();
    if (!feed || this.olderBusy || !this.timeline?.hasOlder) return;
    const generation = this.request;
    this.olderBusy = true;
    this.changed();
    try {
      const envelope = await this.town.loadOlder(feed);
      if (generation !== this.request) return;
      this.applyTimeline(envelope);
    } catch (error) {
      if (generation === this.request) this.status = errorText(error);
    } finally {
      if (generation === this.request) { this.olderBusy = false; this.changed(); }
    }
  }

  async loadDetail(query: TownQuery, append = false) {
    const generation = ++this.detailRequest;
    this.selectedId = query.id || "";
    this.detailLoading = true;
    this.detailError = undefined;
    if (!append) this.detail = undefined;
    this.scenes.update({
      sceneId: `town:https://beings.town:${query.kind}:${query.id}`,
      status: "loading",
      selection: undefined,
      scope: "正在读取详情",
    });
    this.changed();
    try {
      const result = await this.api.town(query);
      if (generation !== this.detailRequest) return;
      if (!result.ok) {
        this.detailError = {
          message: result.message,
          retry: () => void this.loadDetail(query, append),
        };
        this.scenes.update({ status: "error", scope: "详情读取失败" });
        return;
      }
      if (query.kind === "seed" && typeof result.data.brief !== "string") throw new Error("种子详情格式不正确，请稍后重试。");
      this.scenes.update({
        title: str(
          result.data.title,
          str(result.data.name, definitions[this.view].title),
        ),
        status: "ready",
        scope: "已加载的详情片段；不代表已阅读",
      });
      this.detail = {
        query,
        fragments: [
          ...(append ? this.detail?.fragments || [] : []),
          { ...result.data, id: query.id },
        ],
      };
    } catch (error) {
      if (generation === this.detailRequest) {
        this.detailError = {
          message: errorText(error),
          retry: () => void this.loadDetail(query, append),
        };
        this.scenes.update({ status: "error", scope: "详情读取失败" });
      }
    } finally {
      if (generation === this.detailRequest) {
        this.detailLoading = false;
        this.changed();
      }
    }
  }

  // ── pairing ────────────────────────────────────────────────────────────────
  // Six digits, from the Being's own Town identity, exchanged for a client token
  // that never enters this process. There is no "paste an existing token" path:
  // the direct client mints its own credential and binds it to this connection
  // (docs/town-sdk-integration.md「配对与权限」).
  async auth() {
    if (this.authOpen) return;
    const revision = ++this.authRequest;
    this.authOpen = true;
    this.authLoading = true;
    this.pairCode = "";
    this.authError = "";
    this.authState = "";
    this.changed();
    try {
      const state = await this.town.appState();
      if (revision !== this.authRequest) return;
      // Through `receiveState`, never by assignment: a panel opened after the
      // connection changed must go through the same identity reset every other
      // state transition does, or the timeline on screen would outlive its Being.
      this.receiveState(state);
      this.authState = this.pairingSentence(state);
    } catch (error) {
      if (revision === this.authRequest) this.authError = errorText(error);
    }
    if (revision !== this.authRequest) return;
    this.authLoading = false;
    this.changed();
  }

  private pairingSentence(state: TownDesktopAppState): string {
    if (state.client.pairingPending) return "配对已成功，但凭据没能写入本机密钥库。请点「重试保存配对」；不要再要一个新码。";
    if (!state.client.paired) return "尚未配对。";
    if (state.client.status === "connected") return `已连接 Town${state.identity.displayName ? `：${state.identity.displayName}` : ""}。`;
    return "已保存 Town 配对，等待身份确认。";
  }

  async closeAuth() {
    if (this.authBusy) return;
    ++this.authRequest;
    this.authLoading = false;
    this.authOpen = false;
    this.pairCode = "";
    this.changed();
  }

  /** One click: the Being is asked for a code in its own scene and it is
   * exchanged without the code ever reaching the page. */
  async autoPair() { await this.pairing(() => this.town.autoPair(), "正在请求 Being 生成配对码，最多等待 90 秒…"); }
  /** Manual: the six digits the user read out of the conversation. */
  async pair() {
    const code = this.pairCode.trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(code)) { this.authError = "请输入 6 位配对码（大写字母或数字）。"; this.changed(); return; }
    await this.pairing(() => this.town.pair({ code }), "正在兑换配对码…");
  }
  /** The token is already in memory; only the write failed. Never another code. */
  async retryPairStorage() { await this.pairing(() => this.town.retryPairStorage(), "正在重试保存配对…"); }

  async forget() {
    await this.pairing(() => this.town.forget(), "正在删除本机配对…", false);
  }

  private async pairing(operation: () => Promise<unknown>, notice: string, reload = true) {
    if (this.authBusy || this.authLoading) return;
    const revision = ++this.authRequest;
    this.authBusy = true;
    this.authError = "";
    this.authState = notice;
    this.changed();
    try {
      await operation();
      if (revision !== this.authRequest) return;
      const state = await this.town.appState();
      if (revision !== this.authRequest) return;
      this.townApp = state;
      this.authState = this.pairingSentence(state);
      this.pairCode = "";
      if (!state.client.pairingPending) {
        this.authOpen = false;
        this.resetIdentity();
        this.me = state.identity.townId || state.identity.loomBeingId || "";
        if (reload && definitions[this.view]) await this.load();
      }
    } catch (error) {
      if (revision !== this.authRequest) return;
      this.authError = errorText(error);
      this.authState = "";
    } finally {
      if (revision === this.authRequest) {
        this.authBusy = false;
        this.changed();
      }
    }
  }

  // ── sending ────────────────────────────────────────────────────────────────
  compose(reply?: FeedReply) {
    const kind = this.feedKind();
    if (this.sendBusy || !kind || !this.connected || !this.me) return;
    const firesideId = this.directId || this.selectedRing;
    if (kind === "fireside" && !firesideId) return;
    const next: SendTarget = {
      kind,
      firesideId: kind === "fireside" ? firesideId : undefined,
      connectionRevision: this.connectionRevision,
      beingId: this.me,
      ...(reply ? { reply } : {}),
    };
    if (this.sendTarget)
      this.drafts.set(JSON.stringify(this.sendTarget), {
        content: this.content,
        recipient: this.recipient,
      });
    while (this.drafts.size > 20)
      this.drafts.delete(this.drafts.keys().next().value!);
    const draft = this.drafts.get(JSON.stringify(next));
    this.content = draft?.content || "";
    this.recipient = draft?.recipient || reply?.recipient || "";
    this.sendTarget = next;
    this.sendError = "";
    this.sendNotice = "";
    this.sendCandidates = [];
    this.sendOpen = true;
    this.changed();
  }
  /** Measured in code points, and refused here rather than truncated by Town:
   * the bonfire truncates silently, the fireside answers 400. */
  get sendLimit() {
    return this.sendTarget?.kind === "bonfire" ? 4000 : 32000;
  }
  get canSend() {
    return (
      !this.sendBusy &&
      this.connected &&
      Boolean(this.content.trim()) &&
      (this.sendTarget?.kind !== "dm" || Boolean(this.recipient.trim())) &&
      [...this.content].length <= this.sendLimit
    );
  }
  async send() {
    const target = this.sendTarget;
    if (!target || !this.canSend) return;
    if (target.connectionRevision !== this.connectionRevision || target.beingId !== this.me) {
      this.sendError = "Town 身份已改变，请重新打开发送窗口。";
      this.changed();
      return;
    }
    const replyTo = target.reply === undefined ? undefined : String(target.reply.id);
    const request = target.kind === "dm"
      ? { kind: "dm" as const, recipient: this.recipient.trim(), content: this.content, connectionRevision: target.connectionRevision, ...(replyTo ? { replyTo } : {}) }
      : target.kind === "fireside"
        ? { kind: "fireside" as const, firesideId: target.firesideId!, content: this.content, connectionRevision: target.connectionRevision, ...(replyTo ? { replyTo } : {}) }
        : { kind: "bonfire" as const, content: this.content, connectionRevision: target.connectionRevision, mentions: [], ...(replyTo ? { replyTo } : {}) };
    this.sendBusy = true;
    this.sendError = "";
    this.sendNotice = "";
    this.sendCandidates = [];
    this.changed();
    try {
      const receipt = await this.town.speak(request);
      if (target !== this.sendTarget) return;
      this.drafts.delete(JSON.stringify(target));
      this.content = "";
      // The message was accepted. A mention that Town could not resolve is
      // reported with the choices it would have accepted instead, and those are
      // offered — BeingDesktop renderer/town-mentions.js `renderReceipt`. Picking
      // one edits the next draft; it never republishes this message.
      const warnings = mentionWarnings(receipt.mention_warnings);
      this.sendCandidates = warnings.flatMap(warning => warning.candidates);
      this.sendNotice = warnings.length
        ? `消息已发送，但部分 @ 提及未解析：${warnings.map(warning => (warning.mention ? "@" + warning.mention : "未命名提及")).join("、")}。可从候选中选择完整 Town ID 用于下一条，不要重发原消息。`
        : "";
      this.sendOpen = Boolean(this.sendNotice);
      await this.refresh();
    } catch (error) {
      if (target !== this.sendTarget) return;
      this.sendError = errorText(error);
      // `NOT_SENT` from an ambiguous recipient carries the choices Town offered.
      // They are shown; none is selected automatically and nothing is resent.
      const candidates = (error as { candidates?: { town_id: string; display_name: string }[] }).candidates;
      this.sendCandidates = Array.isArray(candidates) ? candidates : [];
      if (this.codeOf(error) === "RESULT_UNKNOWN")
        this.sendNotice = "结果未确认：消息可能已经送达。请刷新核对，不要直接重发。";
    } finally {
      this.sendBusy = false;
      this.changed();
    }
  }

  installedKit(name: string) {
    // Installation targets use manifest.name, including imports and older Grove installs.
    return this.installedLibrary?.kits.find(kit => kit.name === name);
  }
  async refreshInstalledKits() {
    const generation = ++this.installedRequest;
    this.installedLoading = true;
    this.installedError = "";
    this.installedLibrary = null;
    this.changed();
    try {
      const library = await this.api.localKits();
      if (generation === this.installedRequest) this.installedLibrary = library;
    } catch (error) {
      if (generation === this.installedRequest) this.installedError = errorText(error);
    } finally {
      if (generation === this.installedRequest) {
        this.installedLoading = false;
        this.changed();
      }
    }
  }
  async showInstalledKit(name: string) {
    this.directId = undefined;
    this.tab = "local";
    this.tabs.kits = "local";
    this.search = "";
    this.offset = 0;
    const pending = this.load(), generation = this.request;
    await pending;
    if (generation !== this.request) return;
    const kit = this.library?.kits.find(kit => kit.name === name);
    if (kit) this.selectLocal(kit);
  }
  async prepareKit(id: string) {
    if (this.prepareBusy || this.plan) return;
    this.prepareBusy = true;
    this.changed();
    try {
      const revision = this.lifecycleRevision;
      const plan = await this.api.prepareKit(id);
      if (revision !== this.lifecycleRevision) {
        await this.api.discardKit(plan.ticket);
        return;
      }
      this.plan = plan;
      this.environment = {};
      this.installError = "";
      this.installRetried = false;
    } catch (error) {
      this.toast(error);
    } finally {
      this.prepareBusy = false;
      this.changed();
    }
  }
  closeInstall() {
    if (this.installBusy) return;
    const plan = this.plan;
    this.plan = undefined;
    this.environment = {};
    this.changed();
    if (plan) void this.api.discardKit(plan.ticket).catch(() => {});
  }
  async install() {
    if (!this.plan || this.installBusy) return;
    const revision = this.lifecycleRevision;
    this.installBusy = true;
    this.installError = "";
    this.changed();
    try {
      const result = await this.api.installKit({
        ticket: this.plan.ticket,
        environment: { ...this.environment },
      });
      if (revision !== this.lifecycleRevision) return;
      this.plan = undefined;
      this.environment = {};
      this.toast(`${result.name}：${result.message}`);
      if (this.view === "kits") {
        if (this.tab === "local" && !this.directId) await this.showInstalledKit(result.name);
        else await this.refreshInstalledKits();
      }
    } catch (error) {
      this.installError = errorText(error);
    } finally {
      this.installBusy = false;
      this.installRetried = true;
      this.changed();
    }
  }
  async importKit() {
    await this.run(async () => {
      const result = await this.api.importKit();
      if (result.installed) {
        this.toast(`${result.name} 已导入。Portal 将自动刷新清单。`);
        if (this.tab === "local") await this.load();
      }
    });
  }
  async deleteKit(kit: LocalKit) {
    await this.run(async () => {
      const result = await this.api.deleteKit(kit.name);
      if (!result.deleted) return;
      if (this.localKit?.name === kit.name) this.localKit = undefined;
      if (this.selectedId === kit.name) this.selectedId = "";
      this.toast(`${kit.name} 已删除。`);
      await this.load();
    });
  }
  async run(operation: () => Promise<unknown>) {
    try {
      await operation();
    } catch (error) {
      this.toast(error);
    }
  }
}
