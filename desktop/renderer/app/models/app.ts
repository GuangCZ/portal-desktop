import type {
  DesktopAPI,
  Snapshot,
  PortalState,
  SaveSettings,
  ClientStartup,
  UpdateState,
} from "../../../shared/types";
import { Store, errorText } from "../../shared/models/store";
import { isQuittingRefusal } from "../../../shared/errors";
import { WorkspaceModel } from "./workspace";
import { TownModel } from "../../town/models/town";
import { ConversationModel } from "../../conversation/models/conversation";
import { FEATURE_MODELS, type AppFeatureModels, type FeatureModel } from "./registry";

export class AppModel extends Store {
  snapshot?: Snapshot;
  theme: "light" | "dark" = "light";
  startup: "loading" | "ready" | "error" = "loading";
  view = "chat";
  /** The identity of the conversation surface currently on screen: a fresh token
   * per connection, not a page to load. `use-conversation-bridge` reloads the
   * conversation whenever it changes. */
  chatSource = "";
  chatLoading = false;
  connection = "";
  toastMessage = "";
  settingsOpen = false;
  clientSettingsOpen = false;
  diagnosticsOpen = false;
  searchOpen = false;
  search = "";
  searchEntries: { id: string; text: string }[] = [];
  readingSize = 15;
  update?: UpdateState;
  portalAction: "start" | "stop" | null = null;
  portalError = "";
  logsLoading = false;
  private logsRequest = "";
  clientStartup?: ClientStartup;
  startupBusy = false;
  clientError = "";
  form?: SaveSettings;
  saving = false;
  formError = "";
  portalNameHelp = "";
  private nameEdited = false;
  private defaultsRevision = 0;
  private initializeRevision = 0;
  private defaultsTimer?: ReturnType<typeof setTimeout>;
  private toastTimer?: ReturnType<typeof setTimeout>;
  post: (data: unknown) => void = () => {};
  readonly workspace = new WorkspaceModel(
    (view) => this.navigate(view),
    (error) => this.toast(error),
    (data) => this.post(data),
    () => Boolean(this.chatSource),
  );
  readonly town: TownModel;
  /** The native conversation layer. It replaced the sandboxed Loom document on
   * 2026-09-16, and the `beings://chat` path it used to live behind was removed
   * with the rest of the iframe wiring. */
  readonly conversation: ConversationModel;
  /** Models registered by an integration unit (./registry.ts). A slot component
   * reads its own state from here; the shell itself never looks inside. Populated
   * at the end of the constructor, so the built-in models above are complete
   * before any factory runs. */
  readonly features = {} as AppFeatureModels;
  /** Set the first time a channel refuses because the client is on its way out.
   * From then on no push is chased with a read: everything but `QUIT_ALLOWED`
   * would be refused, and there is nothing left to show the answer to. */
  private quitting = false;
  constructor(readonly api: DesktopAPI) {
    super();
    this.conversation = new ConversationModel({
      chat: api?.chat,
      toast: this.toast,
      beingName: () => this.snapshot?.settings.being || "being",
    });
    this.town = new TownModel(
      api,
      this.toast,
      this.navigate,
      this.workspace.scenes,
      () => {
        this.navigate("chat");
        this.workspace.toggle(true);
      },
      (data) => this.post(data),
    );
    for (const feature of FEATURE_MODELS) {
      // A broken feature model must not stop the conversation opening, which is
      // the same rule the main-process registry follows.
      try {
        this.featureModels[feature.key as string] = feature.create(api, this);
      } catch (error) {
        this.toast(error);
      }
    }
  }
  /** The registered models as a plain record.
   *
   * `AppFeatureModels` is an interface each unit augments with its own key, so it
   * never carries an index signature, and a direct `as Record<string, …>` stops
   * compiling the moment the first unit lands one. Going through `unknown` is what
   * keeps this file — which no integration unit may edit — compiling as keys
   * arrive. */
  private get featureModels(): Record<string, FeatureModel> {
    return this.features as unknown as Record<string, FeatureModel>;
  }
  start() {
    let active = true;
    const cleanupWorkspace = this.workspace.start();
    if (!this.api) {
      this.startup = "error";
      this.toast("请通过 Being Desktop 桌面客户端打开此页面。");
      return () => {
        active = false;
        clearTimeout(this.toastTimer);
        cleanupWorkspace();
      };
    }
    try {
      const size = Number(localStorage.getItem("beings:reading-size"));
      if (Number.isInteger(size) && size >= 13 && size <= 21)
        this.readingSize = size;
    } catch {
      /* Optional preference. */
    }
    // A registered model publishes through the same Store contract the built-in
    // ones use, so the shell re-renders on its changes without knowing it exists —
    // and anything it has to open (an IPC subscription, a timer) it opens in
    // `start()`, whose cleanup joins this list exactly as `this.town.start()`
    // below does. Subscribing first, so a change made while starting still lands.
    const features = Object.values(this.featureModels);
    const cleanups = [
      cleanupWorkspace,
      ...features.map((model) => model.subscribe(() => this.changed())),
      ...features.flatMap((model) => this.startFeature(model)),
      this.town.start(),
      this.api.onPortal((state) => {
        if (this.snapshot) {
          this.snapshot = { ...this.snapshot, portal: state };
          this.changed();
        }
        // A push that arrives while the client is shutting down must not be
        // chased with a read (2026-09-17, integration unit IN). `before-quit`
        // sets the main process's quitting flag and THEN stops the Portal, so
        // the last transitions of a shutdown arrive at a page that is still
        // alive — and every one of them used to send `beings:snapshot` into a
        // guard that can only refuse it, leaving a line in the client's error
        // log and, worse,「客户端正在退出，请稍候。」in a toast on the way out
        // (docs/migration/im-integration.md openIssue 7). The refusal is the
        // only notice the renderer gets, so it is taken as one: the first is
        // swallowed and no read is attempted after it. `active` is checked
        // BEFORE the invoke as well as after, so a push racing teardown does not
        // start a call that nobody is left to apply.
        if (!active || this.quitting) return;
        void this.run(async () => {
          let next;
          try {
            next = await this.api.snapshot();
          } catch (error) {
            if (!isQuittingRefusal(error)) throw error;
            this.quitting = true;
            return;
          }
          if (active && !this.quitting) this.applySnapshot(next);
        });
      }),
      this.api.onUpdate((state) => {
        this.update = state;
        this.changed();
      }),
    ];
    void this.api
      .updateState()
      .then((state) => {
        if (active) {
          this.update = state;
          this.changed();
        }
      })
      .catch((error) => {
        if (active) this.toast(error);
      });
    void this.initialize();
    return () => {
      active = false;
      ++this.initializeRevision;
      ++this.defaultsRevision;
      clearTimeout(this.defaultsTimer);
      clearTimeout(this.toastTimer);
      this.logsRequest = "";
      this.logsLoading = false;
      cleanups.forEach((cleanup) => cleanup());
    };
  }
  /** Starts one registered model, answering with its cleanup or with nothing.
   *
   * Both halves are guarded, because a feature model is another unit's code and
   * the shell has to open and close either way: a failure to start is toasted, the
   * same rule the constructor follows, and a failure to stop is swallowed — by
   * then the toast timer has already been cleared and the shell is on its way
   * out. */
  private startFeature(model: FeatureModel): (() => void)[] {
    try {
      const stop = model.start?.();
      if (!stop) return [];
      return [() => {
        try {
          stop();
        } catch {
          /* Teardown must reach the rest of the list. */
        }
      }];
    } catch (error) {
      this.toast(error);
      return [];
    }
  }
  async initialize() {
    const revision = ++this.initializeRevision;
    this.startup = "loading";
    this.changed();
    try {
      const [theme, state] = await Promise.all([
        this.api.appearance(),
        this.api.snapshot(),
      ]);
      if (revision !== this.initializeRevision) return;
      this.theme = theme;
      this.applySnapshot(state);
      this.startup = "ready";
    } catch {
      if (revision === this.initializeRevision) this.startup = "error";
    }
    this.changed();
  }
  toast = (error: unknown) => {
    this.toastMessage = errorText(error);
    this.changed();
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastMessage = "";
      this.changed();
    }, 6000);
  };
  run = async (operation: () => Promise<unknown>) => {
    try {
      await operation();
    } catch (error) {
      this.toast(error);
    }
  };
  navigate = (view: string, id?: string) => {
    this.view = view;
    this.workspace.enter(view);
    this.workspace.toggle(false);
    this.town.show(view, id);
    this.changed();
  };
  applySnapshot(next: Snapshot, reload = false) {
    if (reload || !next.settings.hasToken || (this.snapshot && next.settings.endpoint !== this.snapshot.settings.endpoint)) {
      this.logsRequest = "";
      this.logsLoading = false;
    }
    reload ||= Boolean(this.snapshot && next.settings.endpoint !== this.snapshot.settings.endpoint);
    this.snapshot = next;
    this.workspace.snapshot(next);
    if (next.settings.hasToken && (!this.chatSource || reload)) {
      this.chatLoading = true;
      this.connection = "connecting";
      this.chatSource = crypto.randomUUID();
    }
    if (!next.settings.hasToken) {
      this.chatSource = "";
      this.chatLoading = false;
      this.connection = "";
      this.searchEntries = [];
    }
    this.changed();
  }
  /** A new conversation surface is on screen. It kept the name it had while the
   * surface was an iframe waiting for `load`; what it now marks is the shell
   * letting go of the previous connection's search index. */
  frameLoaded() {
    this.chatLoading = false;
    this.search = "";
    this.searchEntries = [];
    this.town.updateLive();
    this.changed();
  }
  async toggleTheme() {
    await this.run(async () => {
      this.theme = await this.api.appearance(
        this.theme === "light" ? "dark" : "light",
      );
      this.changed();
    });
  }
  setReadingSize(size: number) {
    this.readingSize = size;
    this.changed();
    try {
      localStorage.setItem("beings:reading-size", String(size));
    } catch {
      /* Optional preference. */
    }
  }
  openSearch() {
    if (!this.snapshot?.settings.hasToken) return;
    this.searchOpen = true;
    this.changed();
  }
  async sharePortalLogs() {
    if (this.logsLoading) return;
    if (!this.snapshot?.settings.hasToken || !this.chatSource) {
      this.toast("请先连接 Being，再一起看 Portal 日志。");
      return;
    }
    this.logsLoading = true;
    const request = this.logsRequest = crypto.randomUUID();
    this.changed();
    const endpoint = this.snapshot.settings.endpoint, source = this.chatSource;
    try {
      const logs = await this.api.portalLogReference();
      if (this.logsRequest !== request) return;
      if (logs.endpoint !== endpoint || this.snapshot?.settings.endpoint !== endpoint || this.chatSource !== source) {
        throw new Error("连接已切换，请重新选择 Portal 日志。");
      }
      this.workspace.enter("portal");
      this.workspace.scenes.select({ id: `portal-logs:${request}`, title: "Portal 日志",
        author: "本机 Portal", excerpt: logs.text, private: true });
      this.workspace.scenes.pin();
      this.navigate("chat");
      this.workspace.toggle(true);
    } catch (error) {
      if (this.logsRequest === request) this.toast(error);
    } finally {
      if (this.logsRequest === request) {
        this.logsRequest = "";
        this.logsLoading = false;
        this.changed();
      }
    }
  }
  async changePortal(operation: "start" | "stop") {
    if (this.portalAction || !this.snapshot) return;
    this.portalAction = operation;
    this.portalError = "";
    this.changed();
    try {
      const portal: PortalState = await (operation === "start"
        ? this.api.startPortal()
        : this.api.stopPortal());
      this.snapshot = { ...this.snapshot, portal };
      this.changed();
      this.applySnapshot(await this.api.snapshot());
    } catch (error) {
      this.portalError = errorText(error);
    } finally {
      this.portalAction = null;
      this.changed();
    }
  }
  async openClientSettings() {
    this.clientSettingsOpen = true;
    this.clientError = "";
    this.startupBusy = true;
    this.changed();
    try {
      this.clientStartup = await this.api.clientStartup();
    } catch (error) {
      this.clientError = errorText(error);
    } finally {
      this.startupBusy = false;
      this.changed();
    }
  }
  async changeClientStartup(enabled: boolean) {
    if (this.startupBusy) return;
    this.startupBusy = true;
    this.clientError = "";
    this.changed();
    try {
      this.clientStartup = await this.api.clientStartup(enabled);
    } catch (error) {
      this.clientError = errorText(error);
      try {
        this.clientStartup = await this.api.clientStartup();
      } catch {
        if (this.clientStartup)
          this.clientStartup = { ...this.clientStartup, supported: false };
      }
    } finally {
      this.startupBusy = false;
      this.changed();
    }
  }
  showSettings() {
    if (!this.snapshot) return;
    this.clientSettingsOpen = false;
    this.settingsOpen = true;
    const s = this.snapshot.settings;
    this.form = {
      connectionLink: "",
      workspace: s.workspace,
      portalBinary: s.portalBinary,
      portalName: s.portalName,
      autoStart: s.autoStart,
      backgroundEnabled: Boolean(s.backgroundEnabled),
      allowExec: s.allowExec,
      kitsEnabled: s.kitsEnabled,
      portalConfigPath: s.portalConfigPath,
      portalEnvironmentPath: s.portalEnvironmentPath,
    };
    this.nameEdited = false;
    this.formError = "";
    this.portalNameHelp = "已有本机 Portal 时默认沿用名称，也可以自行修改。";
    this.changed();
    void this.fillDefaults();
  }
  closeSettings() {
    this.settingsOpen = false;
    ++this.defaultsRevision;
    clearTimeout(this.defaultsTimer);
    if (this.form) this.form.connectionLink = "";
    this.changed();
  }
  editForm<K extends keyof SaveSettings>(key: K, value: SaveSettings[K]) {
    if (!this.form) return;
    this.form = { ...this.form, [key]: value };
    if (key === "portalName") this.nameEdited = true;
    if (key === "connectionLink") {
      ++this.defaultsRevision;
      clearTimeout(this.defaultsTimer);
      this.defaultsTimer = setTimeout(() => void this.fillDefaults(), 300);
    }
    this.changed();
  }
  async fillDefaults() {
    const revision = ++this.defaultsRevision,
      link = this.form?.connectionLink;
    if (!link && !this.snapshot?.settings.hasToken) return;
    try {
      const defaults = await this.api.connectionDefaults({
        connectionLink: link,
      });
      if (
        revision !== this.defaultsRevision ||
        !this.settingsOpen ||
        !this.form
      )
        return;
      if (!this.nameEdited)
        this.form = { ...this.form, portalName: defaults.portalName };
      this.portalNameHelp = defaults.source
        ? `检测到原 Portal 名称：${defaults.portalName}。${this.nameEdited ? "保留你填写的名称。" : "已默认沿用，可修改。"}`
        : "未发现同一 Being 的本机 Portal，可设置新名称。";
      this.changed();
    } catch {
      /* Incomplete links are validated when saving. */
    }
  }
  async saveSettings() {
    if (this.saving || !this.form) return;
    this.saving = true;
    this.formError = "";
    this.changed();
    try {
      if (!this.nameEdited) await this.fillDefaults();
      const next = await this.api.save({ ...this.form });
      this.applySnapshot(next, true);
      this.closeSettings();
      this.navigate("chat");
    } catch (error) {
      this.formError = errorText(error);
    } finally {
      this.saving = false;
      this.changed();
    }
  }
}
