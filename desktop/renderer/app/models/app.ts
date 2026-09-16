import type {
  DesktopAPI,
  Snapshot,
  PortalState,
  SaveSettings,
  ClientStartup,
  UpdateState,
} from "../../../shared/types";
import { Store, errorText } from "../../shared/models/store";
import { WorkspaceModel } from "./workspace";
import { TownModel } from "../../town/models/town";
import { ConversationModel } from "../../conversation/models/conversation";

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
    const cleanups = [
      cleanupWorkspace,
      this.town.start(),
      this.api.onPortal((state) => {
        if (this.snapshot) {
          this.snapshot = { ...this.snapshot, portal: state };
          this.changed();
        }
        void this.run(async () => {
          const next = await this.api.snapshot();
          if (active) this.applySnapshot(next);
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
