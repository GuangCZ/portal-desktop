import { BrowserWindow, WebContentsView, session, shell } from 'electron';
import { browserAddress, browserURL } from './url';
import { redact } from '../chat/connection';
import type { BrowserAction, BrowserBounds, BrowserState } from '../../shared/types';

export class ClientBrowser {
  state: BrowserState = { open: false, address: '', title: '浏览器', loading: false, canGoBack: false, canGoForward: false };
  private view?: WebContentsView;
  private contents?: Electron.WebContents;
  private url = '';
  private secrets = new Set<string>();
  private bounds?: BrowserBounds;
  constructor(private window: BrowserWindow, private publish: (state: BrowserState) => void) {
    window.once('closed', () => this.close());
    window.webContents.on('did-start-loading', () => { this.view?.setVisible(false); });
  }
  private update(patch: Partial<BrowserState> = {}) {
    if (this.view && !this.view.webContents.isDestroyed()) {
      const contents = this.view.webContents;
      const index = contents.navigationHistory.getActiveIndex(), entries = contents.navigationHistory.getAllEntries();
      this.state = { ...this.state, canGoBack: index > 0, canGoForward: index >= 0 && index < entries.length - 1 };
    }
    this.state = { ...this.state, ...patch };
    if (!this.window.isDestroyed()) this.publish(this.state);
  }
  private track(url: string) {
    this.url = url;
    const { address, secrets } = browserAddress(url);
    for (const value of secrets) this.secrets.add(value);
    this.update({ address });
  }
  private create() {
    if (this.view) return this.view;
    const browserSession = session.fromPartition('persist:beings-browser');
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    browserSession.setPermissionCheckHandler(() => false);
    const view = new WebContentsView({ webPreferences: { session: browserSession, sandbox: true,
      contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
      webSecurity: true, webviewTag: false, navigateOnDragDrop: false } });
    this.view = view;
    this.window.contentView.addChildView(view);
    view.setVisible(false);
    const contents = view.webContents; this.contents = contents;
    const current = () => this.view === view && !contents.isDestroyed();
    const guard = (event: Electron.Event, url: string) => {
      try { browserURL(url); }
      catch { event.preventDefault(); }
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.setWindowOpenHandler(({ url }) => {
      try { this.open(browserURL(url)); } catch { /* Unsupported schemes stay blocked. */ }
      return { action: 'deny' };
    });
    contents.on('did-finish-load', () => { setImmediate(() => { if (current()) this.update(); }); });
    contents.on('did-start-loading', () => { if (current()) this.update({ loading: true, error: undefined }); });
    contents.on('did-stop-loading', () => { if (current()) this.update({ loading: false }); });
    const navigated = (_event: Electron.Event, url: string) => {
      if (!current()) return;
      try { this.track(browserURL(url)); } catch { return; }
      this.update({ error: undefined }); this.layout();
    };
    contents.on('did-navigate', navigated);
    contents.on('did-navigate-in-page', (event, url, isMainFrame) => { if (isMainFrame) navigated(event, url); });
    contents.on('page-title-updated', (_event, title) => {
      if (current()) this.update({ title: redact(title, [...this.secrets]).slice(0, 160) || '浏览器' });
    });
    contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (current() && isMainFrame && code !== -3) this.failed();
    });
    contents.on('render-process-gone', () => { if (current()) this.failed(); });
    return view;
  }
  private failed() {
    this.update({ loading: false, error: '网页未能加载，请刷新重试或在系统浏览器打开。' });
    this.layout();
  }
  open(input?: string) {
    const target = input === undefined ? undefined : browserURL(input);
    this.update({ open: true });
    if (!target) { this.layout(); return; }
    const view = this.create();
    this.track(target);
    this.update({ title: '正在打开网页', loading: true, error: undefined });
    this.layout();
    void view.webContents.loadURL(target).catch(() => { /* did-fail-load reports a sanitized error. */ });
  }
  setBounds(bounds: BrowserBounds) {
    if (!bounds || typeof bounds.visible !== 'boolean' || !['x', 'y', 'width', 'height'].every(key =>
      typeof bounds[key as keyof BrowserBounds] === 'number' && Number.isFinite(bounds[key as keyof BrowserBounds]))) throw new Error('无效的浏览器布局。');
    this.bounds = bounds;
    this.layout();
  }
  private layout() {
    if (!this.view || this.window.isDestroyed()) return;
    const bounds = this.bounds;
    const visible = this.state.open && Boolean(bounds?.visible) && !this.state.error;
    if (!visible || !bounds) { this.view.setVisible(false); return; }
    const [width, height] = this.window.getContentSize();
    const zoom = this.window.webContents.getZoomFactor();
    const x = Math.max(0, Math.min(width, Math.round(bounds.x * zoom))), y = Math.max(0, Math.min(height, Math.round(bounds.y * zoom)));
    const w = Math.max(0, Math.min(width - x, Math.round(bounds.width * zoom))), h = Math.max(0, Math.min(height - y, Math.round(bounds.height * zoom)));
    this.view.setBounds({ x, y, width: w, height: h });
    this.view.setVisible(w > 0 && h > 0);
  }
  async action(action: BrowserAction) {
    if (!['back', 'forward', 'reload', 'stop', 'external', 'close'].includes(action)) throw new Error('不支持的浏览器操作。');
    if (action === 'close') { this.close(); return; }
    if (action === 'external') {
      if (!this.url) return;
      try { await shell.openExternal(this.url); } catch { throw new Error('无法打开系统浏览器，请检查系统设置。'); }
      return;
    }
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    const index = contents.navigationHistory.getActiveIndex(), entries = contents.navigationHistory.getAllEntries();
    if (action === 'back' && index > 0) contents.navigationHistory.goToIndex(index - 1);
    if (action === 'forward' && index >= 0 && index < entries.length - 1) contents.navigationHistory.goToIndex(index + 1);
    if (action === 'reload') { this.update({ error: undefined }); this.layout(); contents.reload(); }
    if (action === 'stop') contents.stop();
  }
  close() {
    const view = this.view, contents = this.contents; this.view = undefined; this.contents = undefined;
    if (view) {
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(view);
      if (contents && !contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
    }
    this.url = ''; this.secrets.clear();
    this.update({ open: false, address: '', title: '浏览器', loading: false, canGoBack: false, canGoForward: false, error: undefined });
  }
}
