// The message-channel page and the Town feature catalogue, as one model;
// 2026-09-16 (integration unit I7).
//
// Ported rule for rule from BeingDesktop 0.8.26 renderer/town-app.js lines
// 900-1040 (the channel page, its three-card header and its wizard) and
// renderer/app.js lines 819-1010 (the Town catalogue and what each feature mode
// does when it is activated).
//
// THE THREE RACE GATES (renderer/town-app.js line 1015)
//
// Every channel request re-checks three things before it writes anything back:
// the connection epoch it started under, the request counter, and the card that
// was selected. All three can change while a Being is thinking, and a late answer
// that lands on the wrong card is worse than no answer — it would report one
// channel's state under another's name.
//
// WHAT A READ MAY NOT DO (docs/channel-sessions.md「已有绑定状态」)
//
// Opening the page, switching card and refreshing are read-only: they query the
// service, they never ask the Being and never register a channel. When that read
// cannot confirm a state, the last confirmed one is KEPT and the failure is shown
// beside it — an unreadable channel is not an unbound channel, and telling the
// user to reconnect a channel that is already connected is the one mistake this
// page must not make.
import { Store, errorText } from "../../shared/models/store";
import { isTownErrorEnvelope } from "../../../shared/town-desktop-errors";
import type { DesktopAPI } from "../../../shared/types";
import type {
  ChannelDraftAck, ChannelDraftPush, ChannelOutcomeState, ChannelServiceStatus,
  ChannelTownFeature, ChannelWorkerState,
} from "../../../shared/desktop-types";
import type { FeatureModelFactory } from "../../app/models/registry";

/** renderer/town-app.js line 912: the three cards, in order. `wecom` is listed
 * and permanently unsupported — its absence would read as「not built yet」, and
 * the service genuinely has no 企业微信 path. */
export const CHANNEL_CARDS: readonly { id: string; name: string; subtitle: string }[] = [
  { id: "feishu", name: "飞书", subtitle: "连接飞书机器人" },
  { id: "wechat", name: "微信", subtitle: "检查可用连接方式" },
  { id: "wecom", name: "企业微信", subtitle: "暂不支持" },
];

/** renderer/town-app.js line 17, the entries a channel can show. */
export const CHANNEL_STATUS: Record<string, string> = {
  unknown: "待确认", connected: "已连接", connecting: "连接中", pending: "等待确认",
  working: "Being 正在处理", registered: "已登记", error: "操作失败", failed: "操作失败",
  waiting: "等待扫码", expired: "二维码已过期", disabled: "已停用", disconnected: "未连接",
  unsupported: "暂不支持", uncertain: "结果待确认",
};

/** The four statuses that mean「there is a binding」(renderer/town-app.js line 941). */
const BOUND = ["connected", "registered", "pending", "waiting"];
/** Statuses that invalidate a QR image (renderer/town-app.js line 994). */
const NO_QR = ["expired", "connected", "disconnected", "disabled"];
const QR_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
const MAX_QR = 2_000_000;

export type ChannelBusy = "connect" | "status" | "inspect";

/** One card's remembered state (renderer/town-app.js `channelStates`): switching
 * away and back shows what was last confirmed rather than starting from unknown. */
interface CardState {
  status: string;
  detail: string;
  qr: string;
  readError: string;
  wizard: boolean;
  step: number;
}

const EMPTY: CardState = { status: "unknown", detail: "", qr: "", readError: "", wizard: false, step: 0 };

/** Turn an envelope back into an Error, HERE rather than in the preload.
 *
 * MEASURED on the packaged client (desktop/shared/channel-types.ts,
 * `ChannelErrorResult`): `contextBridge` copies an Error across the isolated-world
 * boundary by message and stack alone, so a `code` attached in the preload is
 * gone by the time this model sees it. Built on this side it survives, because it
 * never crosses anything — and `code` is what separates「Desktop 暂无权限直接读取
 * 渠道状态」from「暂时未能读取渠道状态」, two sentences the user acts on differently.
 *
 * A rejection is still handled the ordinary way by the caller's `catch`; this
 * only converts the data form. */
export function unwrap<T>(answer: T | { __townError: true; code: string; message: string }): T {
  if (!isTownErrorEnvelope(answer)) return answer as T;
  throw Object.assign(new Error(answer.message), { code: answer.code });
}

/** The Town catalogue is validated before it is drawn (renderer/app.js line 827):
 * nine features, unique ids, three known modes, four non-empty strings. A short
 * catalogue means this client and the Being disagree about what Town offers, and
 * drawing the part they agree on would hide that. */
const TOWN_FEATURE_IDS = ["scroll", "ember", "bonfire", "fireside", "beings", "grove", "portal", "channel", "workspace"];

/** Which of the six fixed feature drafts exist (BeingDesktop src/town.cjs
 * `DRAFTS`). `channel`, `bonfire`, `grove` and `portal` are pages in this client;
 * asking the Being about them in prose is refused there, so the button is not
 * drawn here. */
const FEATURE_DRAFTS = ["scroll", "fireside", "beings", "workspace"];

/** Where a feature-task's「打开功能页」lands. Town's own views are I1's
 * (renderer/town/models/town.ts `definitions`); `channel` is this unit's panel. */
const TASK_VIEWS: Record<string, string> = {
  bonfire: "bonfire", fireside: "firesides", scroll: "scrolls", grove: "kits", portal: "portal", beings: "town",
};

/** What this model needs of `AppModel`. Structural, because the model layer may
 * not import the shell's components (tests/architecture.test.ts) and because a
 * narrow surface is what makes this testable without a whole shell. */
export interface ChannelHost {
  /** The shell's outbound message channel, reassigned by the conversation bridge.
   * Read at call time, never captured: the bridge replaces it on every mount. */
  post(data: unknown): void;
  navigate(view: string, id?: string): void;
  toast(error: unknown): void;
  readonly features: { featureTasks?: { setNavigate(handler: ((feature: string, task: { id: string }) => void) | null): void } };
}

export class ChannelModel extends Store {
  open = false;
  tab: "channel" | "features" = "channel";
  /** The selected card. BeingDesktop opens on 飞书 (renderer/town-app.js line 52). */
  selected = "feishu";
  status = "unknown";
  detail = "";
  qr = "";
  readError = "";
  wizard = false;
  step = 0;
  busy = new Set<ChannelBusy>();
  /** The epoch every request is fenced against; the Town layer supplies it. */
  connectionRevision = 0;
  connected = false;

  catalog: ChannelTownFeature[] = [];
  catalogStatus: "idle" | "loading" | "ready" | "error" = "idle";
  catalogError = "";
  checkedAt = "";
  /** The feature or operation whose draft is being prepared, for the button. */
  drafting = "";
  draftError = "";
  draftReady = "";

  private cards = new Map<string, CardState>();
  private request = 0;
  private stopped = false;

  constructor(private readonly api: DesktopAPI, private readonly host: ChannelHost) { super(); }

  start(): () => void {
    this.stopped = false;
    const offState = this.api?.channel?.onState?.(state => this.receiveWorker(state)) ?? (() => {});
    const offDraft = this.api?.channel?.onDraft?.(push => this.receiveDraft(push)) ?? (() => {});
    // A push only carries a change; the epoch has to be known before the first
    // request, so it is read once here.
    void this.api?.channel?.state?.().then(state => { if (!this.stopped) this.receiveWorker(state); }).catch(() => { /* An unreachable main process leaves the page disconnected, which is what it shows. */ });
    // 「打开功能页 / 到功能页处理」: until some unit installs a destination the
    // feature-task page does not draw the button at all (I4).
    this.host.features.featureTasks?.setNavigate((feature) => this.openFeature(feature));
    return () => {
      this.stopped = true;
      this.request++;
      this.host.features.featureTasks?.setNavigate(null);
      offState(); offDraft();
    };
  }

  show(open: boolean, tab?: "channel" | "features") {
    this.open = open;
    if (tab) this.tab = tab;
    this.changed();
    if (!open) return;
    if (this.tab === "features" && this.catalogStatus === "idle") void this.loadCatalog();
    if (this.tab === "channel" && this.selected !== "wecom" && this.status === "unknown") void this.inspect();
  }

  selectTab(tab: "channel" | "features") {
    this.tab = tab;
    this.changed();
    if (tab === "features" && this.catalogStatus !== "ready") void this.loadCatalog();
  }

  /** renderer/town-app.js line 913: switching card abandons whatever is in flight,
   * restores what that card last confirmed, and reads its state again. */
  select(id: string) {
    if (this.selected === id) return;
    this.request++;
    this.busy.clear();
    this.selected = id;
    Object.assign(this, EMPTY, this.cards.get(id) ?? {});
    this.changed();
    if (id !== "wecom") void this.inspect();
  }

  startWizard() {
    this.wizard = true;
    this.step = 0;
    this.changed();
    void this.begin();
  }

  /** The cards' subtitles (renderer/town-app.js line 941). */
  cardStatus(id: string): string {
    if (id === "wecom") return "暂不支持";
    const status = id === this.selected ? this.status : this.cards.get(id)?.status;
    if (status === "connected") return "已连接";
    return BOUND.includes(status ?? "") ? "已有渠道登记" : "查看绑定状态";
  }

  get pending(): boolean { return this.busy.size > 0; }
  get bound(): boolean { return BOUND.includes(this.status); }
  get statusLabel(): string { return CHANNEL_STATUS[this.status] || "待确认"; }

  begin() { return this.operate("begin", "connect"); }
  check() { return this.operate("check", "status"); }
  inspect() { return this.operate("inspect", "inspect"); }

  /** renderer/town-app.js `channelOperation`, rule for rule. */
  private async operate(method: "begin" | "check" | "inspect", key: ChannelBusy): Promise<void> {
    if (!this.connected || this.selected === "wecom" || this.pending) return;
    const revision = this.connectionRevision;
    const selected = this.selected;
    const request = ++this.request;
    this.busy.add(key);
    if (method === "begin") this.wizard = true;
    // A read leaves the last confirmed result alone; the two Being-facing calls
    // clear it, because they are about to replace it.
    if (method !== "inspect") { this.detail = ""; this.qr = ""; this.readError = ""; }
    this.changed();
    try {
      const response = await this.call(method, { channel: selected, connectionRevision: revision });
      if (this.stale(request, revision, selected)) return;
      const list = (response as { channels?: ChannelOutcomeState[] })?.channels;
      const candidate = Array.isArray(list) ? list.find(entry => entry?.channel === selected) : response as ChannelOutcomeState;
      const result = (candidate?.channel && candidate.channel !== selected ? null : candidate) ?? ({} as ChannelOutcomeState);
      if (method === "inspect" && (!result.status || result.status === "unknown") && this.bound) {
        this.readError = "当前接口未能确认最新状态，暂时保留上次确认结果。";
        this.remember();
        return;
      }
      this.applyResult(result);
    } catch (error) {
      if (this.stale(request, revision, selected)) return;
      if (method === "inspect") {
        const known = this.bound;
        if (!known) this.status = "unknown";
        const reason = (error as { code?: string })?.code === "AUTH_REQUIRED" ? "Desktop 暂无权限直接读取渠道状态。" : "暂时未能读取渠道状态。";
        this.readError = `${known ? "保留上次确认的状态。" : ""}${reason}这不代表未绑定，无需重复连接。可请 Being 核对绑定状态。`;
      } else {
        this.status = "error";
        this.detail = errorText(error);
      }
      this.remember();
    } finally {
      if (request === this.request) { this.busy.delete(key); this.changed(); }
    }
  }

  private async call(method: "begin" | "check" | "inspect", request: { channel: string; connectionRevision: number }): Promise<unknown> {
    const answer = method === "begin" ? await this.api.channel.begin(request)
      : method === "check" ? await this.api.channel.check(request)
      : await this.api.channel.inspect(request) as { channels: ChannelServiceStatus[] };
    return unwrap(answer);
  }

  private stale(request: number, revision: number, selected: string): boolean {
    return this.stopped || request !== this.request || revision !== this.connectionRevision || selected !== this.selected;
  }

  /** renderer/town-app.js `applyChannelResult`. */
  private applyResult(result: ChannelOutcomeState) {
    this.readError = "";
    this.status = typeof result.status === "string" && result.status ? result.status : "unknown";
    this.detail = (typeof result.detail === "string" && result.detail ? result.detail : "") || CHANNEL_STATUS[this.status] || "连接状态待确认";
    if (this.status === "pending") this.detail = `Being 已收到请求，实际连接状态仍待确认。${result.detail ? ` ${result.detail}` : ""}`;
    const qr = typeof result.qrCodeDataUrl === "string" ? result.qrCodeDataUrl : "";
    this.qr = QR_PATTERN.test(qr) && qr.length <= MAX_QR ? qr : "";
    if (NO_QR.includes(this.status)) this.qr = "";
    this.step = this.status === "connected" ? 2 : 1;
    this.remember();
  }

  private remember() {
    this.cards.set(this.selected, { status: this.status, detail: this.detail, qr: this.qr, readError: this.readError, wizard: this.wizard, step: this.step });
  }

  /** The main process's own channel state: the epoch, the binding, and — while a
   * request is in flight —「Being 正在处理」. A confirmed status for a card the
   * user is not looking at is never replaced from here; the outcome of a request
   * arrives as that request's own answer, through `operate`. */
  private receiveWorker(state: ChannelWorkerState) {
    if (this.stopped || !state) return;
    const revision = Number(state.connectionRevision);
    if (Number.isSafeInteger(revision) && revision !== this.connectionRevision) {
      // A new identity is a new set of channels: nothing confirmed under the
      // previous Being may be shown under this one (docs/channel-sessions.md
      //「切换 Being 后使用另一组会话」).
      this.connectionRevision = revision;
      this.cards.clear();
      Object.assign(this, EMPTY);
      this.request++;
      this.busy.clear();
    }
    this.connected = state.connected === true;
    if (state.status === "working" && state.channel === this.selected) {
      this.status = "working";
      this.detail = state.detail || "";
    }
    this.changed();
  }

  /** The main process asking the conversation to hold a draft. The conversation
   * model is the shell's, so this goes out through the same `post` the companion
   * panel uses and the same bridge answers it (app/hooks/use-conversation-bridge.ts). */
  private receiveDraft(push: ChannelDraftPush) {
    const reply = (ack: ChannelDraftAck) => { void this.api.channel.draftResult(push.id, ack).catch(() => { /* The main process times out on its own. */ }); };
    if (this.stopped || !push || typeof push.id !== "string" || typeof push.text !== "string") return;
    // A push that outlived its deadline must not land: the main process has given
    // up, and placing it now would overwrite whatever the user has since typed.
    if (Number.isFinite(push.expiresAt) && push.expiresAt <= Date.now()) { reply("unavailable"); return; }
    let answered = false;
    this.host.post({
      type: "beings:scene-draft",
      id: push.id,
      text: push.text,
      expiresAt: push.expiresAt,
      ack: (result: string) => { answered = true; reply(result === "placed" || result === "occupied" ? result : "unavailable"); },
    });
    // No bridge is mounted: `post` is the shell's no-op until the conversation
    // wires it, and silence would leave the main process waiting for its deadline.
    if (!answered) queueMicrotask(() => { if (!answered) reply("unavailable"); });
  }

  // ── The Town feature catalogue ───────────────────────────────────────────────

  async loadCatalog(): Promise<void> {
    if (this.catalogStatus === "loading") return;
    this.catalogStatus = "loading";
    this.catalogError = "";
    this.changed();
    try {
      const result = await this.api.channel.catalog();
      const features = result?.features;
      const valid = Array.isArray(features) && features.length === TOWN_FEATURE_IDS.length
        && new Set(features.map(feature => feature?.id)).size === TOWN_FEATURE_IDS.length
        && features.every(feature => Boolean(feature) && TOWN_FEATURE_IDS.includes(feature.id)
          && ["being", "web", "app"].includes(feature.mode)
          && (["name", "label", "description", "group"] as const).every(key => typeof feature[key] === "string" && feature[key].trim()));
      if (!valid) throw new Error("Town 功能目录不完整或格式不正确，请重新读取。");
      if (this.stopped) return;
      this.catalog = features;
      this.checkedAt = typeof result.checkedAt === "string" ? result.checkedAt : "";
      this.catalogStatus = "ready";
    } catch (error) {
      if (this.stopped) return;
      this.catalogStatus = "error";
      this.catalogError = errorText(error) || "无法读取 Town 功能目录，请重试。";
    } finally { this.changed(); }
  }

  /** True when this feature has a fixed conversation draft behind it. */
  hasDraft(id: string): boolean { return FEATURE_DRAFTS.includes(id); }

  /** renderer/app.js `activateTownFeature`, by mode. */
  activate(feature: ChannelTownFeature): void {
    if (this.drafting) return;
    if (feature.mode === "web") { void this.openPage(feature.id); return; }
    if (feature.mode === "app") { this.openFeature(feature.id); return; }
    void this.prepare({ kind: "feature", id: feature.id }, feature.id);
  }

  /** One of the six fixed Being-assistance drafts (src/town.cjs `ASSISTANCE`). */
  assist(operation: string): Promise<void> { return this.prepare({ kind: "assistance", id: operation }, operation); }

  /** The pairing-code request (src/main.cjs line 1262). */
  requestPairingCode(): Promise<void> { return this.prepare({ kind: "pairing" }, "pairing"); }

  /** A fireside message the user wrote, handed to the Being for confirmation. */
  handFireside(draft: string): Promise<void> {
    return this.prepare({ kind: "fireside", draft, connectionRevision: this.connectionRevision }, "fireside");
  }

  private async prepare(request: Parameters<DesktopAPI["channel"]["draft"]>[0], token: string): Promise<void> {
    if (this.drafting) return;
    this.drafting = token;
    this.draftError = "";
    this.draftReady = "";
    this.changed();
    try {
      const result = await this.api.channel.draft(request);
      if (this.stopped) return;
      if (result?.prepared !== true) throw new Error("未能准备对话草稿，请检查当前对话后重试。");
      // BeingDesktop switches to the conversation and says so (renderer/app.js
      // line 1010). The draft is filled in, never sent.
      this.draftReady = "已填入对话草稿，补充需求后发送";
      this.host.navigate("chat");
    } catch (error) {
      if (!this.stopped) this.draftError = errorText(error);
    } finally {
      if (!this.stopped) { this.drafting = ""; this.changed(); }
    }
  }

  private async openPage(id: string): Promise<void> {
    this.drafting = id;
    this.draftError = "";
    this.changed();
    try { await this.api.channel.openPage(id); }
    catch (error) { if (!this.stopped) this.draftError = errorText(error); }
    finally { if (!this.stopped) { this.drafting = ""; this.changed(); } }
  }

  /** An `app`-mode feature, and the destination of「打开功能页」on a feature task. */
  openFeature(feature: string): void {
    if (feature === "channel") { this.show(true, "channel"); return; }
    const view = TASK_VIEWS[feature];
    if (!view) { this.host.toast("该功能暂时没有可打开的页面。"); return; }
    this.host.navigate(view);
  }
}

declare module "../../app/models/registry" {
  interface AppFeatureModels { channel: ChannelModel }
}

/** The registry entry (app/models/registry.ts), beside the model so that file
 * never pulls a React component into the model graph. */
export const channelModelFactory: FeatureModelFactory = {
  key: "channel",
  create: (api: DesktopAPI, app: unknown) => new ChannelModel(api, app as ChannelHost),
};
