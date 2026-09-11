import { app, BrowserWindow, dialog, ipcMain, net, nativeTheme, nativeImage, protocol, safeStorage, session, shell, Menu, Tray } from 'electron';
import { clientStartup } from './client-startup';
import { clientUserData } from './client-profile';
import { ClientBrowser } from './browser';
import path from 'node:path';
import os from 'node:os';
import { access, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { SettingsStore } from './settings';
import { PortalSupervisor } from './portal';
import { ExternalPortalObserver } from './external-portal';
import { PortalTakeover } from './portal-takeover';
import { RuntimeUpdater, loadRuntimeBundle, restoreRuntimeMode, type RuntimeUpdateResult } from './runtime-update';
import { UpdateChecker } from './updates';
import { ClientInstall } from './client-install';
import { stageInstaller } from './manual-installer';
import { installerEvent, installerTarget, handleInstallerEvent } from './installer-events';
import { BackgroundPortal } from './background';
import { KitInstaller } from './kit-install';
import { ChatProxy } from './proxy';
import { verifyBeingConnection } from './being-ready';
import { redact } from './connection';
import type { SaveSettings, TownPost, TownQuery, KitInstallInput } from './shared';
import { TownLive } from './town-live';
import { TownClient, TownCredentials, TOWN_ORIGIN } from './town';
import { localKits, kitLocation, readKit, importLocalKit } from './kits';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;
declare const PORTAL_DESKTOP_UPDATE_REPOSITORY: string;
declare const PORTAL_DESKTOP_BUILD: string;
const startedAt = new Date().toISOString();
const CLIENT_NAME = 'Portal Desktop';
const CLIENT_ID = 'portal-desktop';

protocol.registerSchemesAsPrivileged([{ scheme: 'beings', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
// Electron uses its internal name for encrypted storage. Keep that identity
// stable while the bundle, windows, menus and dialogs use the display name.
app.setName(CLIENT_ID);
app.setAboutPanelOptions({ applicationName: CLIENT_NAME });
const userData = clientUserData(app.getPath('appData'), process.env.PORTAL_DESKTOP_USER_DATA);
app.setPath('userData', userData);
app.setPath('sessionData', userData);
let window: BrowserWindow | null = null;
let browser: ClientBrowser | undefined;
let portal: PortalSupervisor;
let proxy: ChatProxy;
let store: SettingsStore;
let background: BackgroundPortal;
let kitInstaller: KitInstaller;
let townLive: TownLive;
let updatePoll: ReturnType<typeof setInterval> | undefined;
let backgroundPoll: ReturnType<typeof setInterval> | undefined;
let quitting = false;
let quitCleanupDone = false;
let sessionEnding = false;
let tray: Tray | undefined;
let lifecycleError = '';
let mutation = Promise.resolve();
let prepareInstallerShutdown: ((target: string) => void) | undefined;
let pendingInstallerTarget: string | undefined;
const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
  const next = mutation.then(operation);
  mutation = next.then(() => {}, () => {});
  return next;
};
const shellURL = () => new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL || 'beings://desktop/').href;
const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const chatCSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src https: data: blob:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-src 'none'";

async function openExternal(url: string) {
  try {
    const parsed = new URL(url);
    if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password) browser?.open(url);
  } catch { /* Unsupported links stay inside the sandbox. */ }
}
function showWindow() {
  if (quitting) return;
  if (!window) { if (store) createWindow(); return; }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
function createWindow() {
  const acrylic = process.platform === 'win32' && Number(os.release().split('.')[2]) >= 22621;
  window = new BrowserWindow({
    width: 1280, height: 860, minWidth: 920, minHeight: 640, title: CLIENT_NAME,
    icon: path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), app.isPackaged ? 'branding/app.png' : 'resources/branding/app.png'),
    backgroundColor: process.platform === 'darwin' || acrylic ? '#00000000' : nativeTheme.shouldUseDarkColors ? '#212121' : '#ffffff',
    ...(process.platform === 'darwin' ? { vibrancy: 'sidebar' as const, visualEffectState: 'active' as const } : {}),
    ...(acrylic ? { backgroundMaterial: 'acrylic' as const } : {}),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: process.platform === 'win32',
    trafficLightPosition: { x: 18, y: 20 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true,
      nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true },
  });
  if (process.platform === 'win32') window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(({ url }) => { void openExternal(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-frame-navigate', event => {
    const url = event.url;
    const parsed = new URL(url);
    const chatDocument = parsed.protocol === 'beings:' && parsed.hostname === 'chat' && parsed.pathname === '/';
    if (!chatDocument && url !== shellURL()) { event.preventDefault(); void openExternal(url); }
  });
  const created = window;
  browser = new ClientBrowser(created, state => { if (!created.isDestroyed() && !created.webContents.isDestroyed()) created.webContents.send('beings:browser-state', state); });
  created.on('close', event => {
    if (quitting || sessionEnding) return;
    event.preventDefault();
    created.hide();
  });
  // Let Windows logoff/shutdown close the app rather than hide the window.
  created.on('query-session-end', () => { sessionEnding = true; });
  created.on('closed', () => { if (window === created) window = null; });
  void window.loadURL(shellURL());
}

async function ready() {
  let appearance: 'light' | 'dark' = 'light';
  try { const saved = JSON.parse(await readFile(path.join(app.getPath('userData'), 'appearance.json'), 'utf8')); if (saved.theme === 'dark') appearance = 'dark'; } catch { /* First launch uses the light workspace. */ }
  nativeTheme.themeSource = appearance;
  const directory = app.getPath('userData');
  const binary = app.isPackaged
    ? path.join(process.resourcesPath, process.platform === 'win32' ? 'heart-portal.exe' : 'heart-portal')
    : path.resolve('resources', process.platform === 'win32' ? 'heart-portal.exe' : 'heart-portal');
  const secretStorage = {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encryptString: (value: string) => safeStorage.encryptString(value), decryptString: (value: Buffer) => safeStorage.decryptString(value),
  };
  store = new SettingsStore(directory, secretStorage, binary);
  let startupNotice: string | undefined;
  try { await store.load(); }
  catch { startupNotice = '原连接配置未能读取，Portal 未启动。配置文件已保留，请检查系统密钥库或连接设置。'; }
  const townCredentials = new TownCredentials(directory, secretStorage);
  let townWarning: string | undefined;
  try { await townCredentials.load(); } catch (error) { townWarning = (error as Error).message; }
  townLive = new TownLive(() => townCredentials.token, () => townCredentials.beingId, state => { if (window && !window.webContents.isDestroyed()) window.webContents.send('beings:town-live', state); }, net.fetch.bind(net) as typeof fetch);
  const town = new TownClient(() => townCredentials.token, net.fetch.bind(net) as typeof fetch, TOWN_ORIGIN, () => townLive.state.beingId || '');
  townLive.restart();
  kitInstaller = new KitInstaller(directory, net.fetch.bind(net) as typeof fetch);
  portal = new PortalSupervisor(directory);
  background = new BackgroundPortal(directory);
  await background.discover(store.settings, store.connection);
  if (!background.state.supported) store.settings.backgroundEnabled = false;
  proxy = new ChatProxy(() => store.connection, net.fetch.bind(net) as typeof fetch);
  const assets = app.isPackaged ? path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`) : path.resolve('desktop/generated');
  protocol.handle('beings', async request => {
    const url = new URL(request.url);
    if (url.hostname === 'chat' && (url.pathname.startsWith('/api/') || url.pathname === '/health')) return proxy.handle(request);
    if (!['desktop', 'chat'].includes(url.hostname) || request.method !== 'GET') return new Response('Not found', { status: 404 });
    const relative = url.hostname === 'chat'
      ? (url.pathname === '/' ? 'loom.html' : url.pathname.slice(1))
      : (url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    if (url.hostname === 'chat' && !['loom.html', 'vendor.js', 'highlight.css', 'chat.css', 'chat-index.js', 'chat-activity.js', 'chat-scene.js'].includes(relative)) return new Response('Not found', { status: 404 });
    const file = path.resolve(assets, relative);
    if (!file.startsWith(assets + path.sep)) return new Response('Forbidden', { status: 403 });
    try {
      const headers: Record<string, string> = { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' };
      if (url.hostname === 'chat') headers['Content-Security-Policy'] = chatCSP;
      return new Response(await readFile(file), { headers });
    } catch { return new Response('Not found', { status: 404 }); }
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  let recoveryBlocked = false;
  const clientInstall = new ClientInstall(directory, background);
  const installIntent = await clientInstall.read();
  prepareInstallerShutdown = target => {
    void exclusive(async () => {
      if (quitting) return;
      const intent = await clientInstall.prepare(app.getVersion(), target, store.connection, portal.managing);
      try {
        recoveryBlocked = true;
        await portal.stop();
        app.quit();
      } catch (error) {
        await clientInstall.resume(intent);
        recoveryBlocked = false;
        throw error;
      }
    }).catch(error => {
      if (window && !window.isDestroyed()) void dialog.showMessageBox(window, {
        type: 'error', title: '无法开始安装', message: String((error as Error).message || error),
        detail: '旧客户端和 Portal 保持运行。请处理后重新启动安装包。', buttons: ['知道了'],
      });
    });
  };
  if (pendingInstallerTarget) {
    const target = pendingInstallerTarget;
    pendingInstallerTarget = undefined;
    prepareInstallerShutdown(target);
  }
  let startupDeferred = false;
  // Only the trusted top-level local shell can control local capabilities.
  const handle = (channel: string, callback: (...args: any[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args) => {
      const frame = event.senderFrame;
      if (!window || event.sender !== window.webContents || frame !== window.webContents.mainFrame || frame.url !== shellURL()) throw new Error('Untrusted IPC sender');
      if (quitting && !['beings:browser-bounds', 'beings:diagnostics'].includes(channel)) throw new Error('客户端正在退出，请稍候。');
      if (recoveryBlocked && ['beings:save', 'beings:portal-start', 'beings:portal-stop'].includes(channel)) throw new Error('Portal 升级恢复尚未完成，请重新启动客户端完成恢复。');
      return callback(...args);
    });
  };
  handle('beings:client-startup', (enabled?: boolean) => clientStartup(app, process.platform, process.execPath, enabled));
  handle('beings:quit', () => { setImmediate(() => app.quit()); });
  handle('beings:browser-state', () => browser?.state);
  handle('beings:browser-open', (url?: string) => browser?.open(url));
  handle('beings:browser-action', (action: import('./shared').BrowserAction) => browser?.action(action));
  handle('beings:browser-bounds', (bounds: import('./shared').BrowserBounds) => browser?.setBounds(bounds));
  const diagnose = async (): Promise<import('./shared').DiagnosticReport> => {
    const connection = store.connection;
    const checks: import('./shared').DiagnosticReport['checks'] = [];
    checks.push({ name: '客户端', status: 'ok', detail: `主进程 ${process.pid} · 关闭窗口保留运行，退出客户端结束进程` });
    if (lifecycleError) checks.push({ name: '上次退出', status: 'error', detail: lifecycleError });
    checks.push({ name: '凭据保护', status: secretStorage.isEncryptionAvailable() ? 'ok' : 'error', detail: secretStorage.isEncryptionAvailable() ? '系统密钥库可用' : '系统密钥库不可用' });
    try { await access(store.settings.workspace); checks.push({ name: '工作目录', status: 'ok', detail: '目录可访问' }); }
    catch { checks.push({ name: '工作目录', status: 'warning', detail: '目录尚未创建或不可访问' }); }
    try { await verifyBeingConnection(connection, net.fetch.bind(net) as typeof fetch); checks.push({ name: 'Being', status: 'ok', detail: '现有状态接口可访问；未发送消息或调用工具' }); }
    catch (error) { checks.push({ name: 'Being', status: 'warning', detail: String((error as Error).message).replace(/，Portal 未启动。/g, '。') }); }
    if (connection !== store.connection) throw new Error('连接已切换，请重新检查。');
    checks.push({ name: 'Portal', status: portal.state.phase === 'connected' ? 'ok' : portal.state.phase === 'error' ? 'error' : 'warning', detail: portal.state.message });
    checks.push({ name: 'Town', status: townLive.state.phase === 'connected' ? 'ok' : 'warning', detail: townLive.state.message });
    return { version: app.getVersion(), build: PORTAL_DESKTOP_BUILD, platform: `${process.platform}/${process.arch}`, pid: process.pid, startedAt, checkedAt: new Date().toISOString(), checks,
      logs: portal.state.logs.slice(-60).map(line => redact(line, [connection?.token || '', connection?.relaySecret || '']).replaceAll(os.homedir(), '~')) };
  };
  handle('beings:diagnostics', diagnose);
  handle('beings:diagnostics-export', async () => {
    const report = await diagnose();
    const result = await dialog.showSaveDialog(window!, { title: '导出诊断', defaultPath: `${CLIENT_NAME}-diagnostics-${new Date().toISOString().slice(0,10)}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return false;
    // Export status only: engine output can contain user task data even when credentials are redacted.
    await writeFile(result.filePath, JSON.stringify({ ...report, logs: undefined }, null, 2), { mode: 0o600 });
    return true;
  });
  let runtimeUpdate: RuntimeUpdateResult = { phase: 'current', message: 'Portal 升级状态将在启动检查后显示。' };
  const updates = new UpdateChecker(app.getVersion(), PORTAL_DESKTOP_UPDATE_REPOSITORY, net.fetch.bind(net) as typeof fetch,
    state => { if (window && !window.isDestroyed()) window.webContents.send('beings:update-state', state); });
  let showingUpdates = false;
  const showUpdates = async () => {
    if (showingUpdates || !window) return;
    showingUpdates = true;
    try {
      const state = await updates.check();
      const answer = await dialog.showMessageBox(window, { type: state.phase === 'available' ? 'info' : 'none', title: '客户端更新',
        message: state.phase === 'available' ? `发现 ${CLIENT_NAME} ${state.latestVersion}` : state.message,
        detail: `当前客户端：${app.getVersion()}${runtimeUpdate.portalVersion ? ` · Portal：${runtimeUpdate.portalVersion}` : ''}\n${runtimeUpdate.message}\n\n下载并校验安装包后，先停止旧 Portal 和对应守护，再安装客户端。安装完成自动打开新版，沿用原配置启动最新 Portal。请先完成本机任务并保存草稿。`,
        buttons: state.phase === 'available' && app.isPackaged ? ['稍后', '下载并升级', '打开发布页'] : ['关闭', '打开发布页'], defaultId: 0, cancelId: 0 });
      if (state.phase === 'available' && app.isPackaged && answer.response === 1) {
        window?.setProgressBar(2);
        let handoff: Awaited<ReturnType<typeof stageInstaller>>;
        try { handoff = await stageInstaller(directory, state.latestVersion!, PORTAL_DESKTOP_UPDATE_REPOSITORY, process.execPath, net.fetch.bind(net) as typeof fetch); }
        finally { window?.setProgressBar(-1); }
        if (!window || quitting) { await handoff.discard(); return; }
        const confirmed = await dialog.showMessageBox(window, { type: 'info', title: '安装包已就绪', message: `安装 ${CLIENT_NAME} ${state.latestVersion}`, detail: '已完成下载和校验。继续将停止 Portal 及守护、关闭客户端，安装成功后自动打开新版并恢复运行。执行中的本机任务会中断，请先保存草稿。', buttons: ['稍后', '停止 Portal 并安装'], defaultId: 0, cancelId: 0 });
        if (confirmed.response !== 1) { await handoff.discard(); return; }
        await exclusive(async () => {
          if (recoveryBlocked) throw new Error('请先完成上次升级恢复。');
          const intent = await clientInstall.prepare(app.getVersion(), state.latestVersion!, store.connection, portal.managing);
          try {
            recoveryBlocked = true;
            await portal.stop();
            await handoff();
            app.quit();
          } catch (error) {
            await clientInstall.resume(intent);
            if (intent.foreground && store.connection) await portal.start(store.settings, store.connection);
            recoveryBlocked = false;
            throw error;
          }
        });
      } else if (answer.response > 0) await shell.openExternal(state.releaseUrl);
    } catch (error) {
      if (window && !quitting) await dialog.showMessageBox(window, { type: 'error', title: '客户端升级未完成', message: String(error), detail: '原配置和恢复记录已保留。可重新打开客户端恢复，或稍后重试。', buttons: ['知道了'] });
    } finally { showingUpdates = false; }
  };
  handle('beings:check-updates', showUpdates);
  handle('beings:update-state', () => updates.state);
  const snapshot = () => ({ settings: store.settings, portal: portal.state, background: background.state, notice: startupNotice });
  const verifyConnection = async () => {
    await verifyBeingConnection(store.connection, net.fetch.bind(net) as typeof fetch);
    startupNotice = undefined;
  };
  const externalPortal = new ExternalPortalObserver();
  const ownedRoot = () => background.installedService?.label === background.label && !background.installedService.existing ? background.installedService.root : undefined;
  const observeExternal = async () => {
    const state = await externalPortal.read(store.connection, background.installedService?.root);
    if (!state) return false;
    portal.state = state; portal.emit('state', state); return true;
  };
  const publishBackground = async () => {
    const state = await background.portalState();
    if (takeover.holdMessage) {
      startupNotice = takeover.holdMessage;
      portal.state = { ...state, phase: 'error', managed: false, message: takeover.holdMessage };
      portal.emit('state', portal.state); return;
    }
    if (!background.state.running && await observeExternal()) return;
    portal.state = state;
    portal.emit('state', portal.state);
  };
  const takeover = new PortalTakeover(directory, {
    discover: connection => externalPortal.conflicts(connection, ownedRoot()),
    preflight: async () => {
      await verifyConnection();
      if (app.isPackaged) await loadRuntimeBundle(process.resourcesPath);
      else await access(binary);
    },
    confirm: async targets => {
      if (!window || quitting) return false;
      const review = await dialog.showMessageBox(window, { type: 'question', title: '切换到客户端 Portal',
        message: `检测到 ${store.settings.being} 的旧 Portal，是否关闭并使用客户端版本？`,
        detail: targets.map(item => `${item.label}${item.pid ? ` · PID ${item.pid}` : ''}\n${item.root}`).join('\n\n') +
          `\n\n确认后会先停用以上旧服务的自启和守护，确认进程退出，再用当前客户端附带的 Portal 和本机设置启动。旧配置和工作文件保留，正在执行的工具任务会被中断。\n工作目录：${store.settings.workspace}\n取消或切换失败时暂停，不会反复弹窗或自动切回旧服务。`,
        buttons: ['取消', '关闭旧服务并启动客户端 Portal'], defaultId: 1, cancelId: 0, noLink: true });
      return review.response === 1;
    },
    stop: async target => { await background.unload(target.service!); },
  });
  const startClientPortal = async (replacing = false, restart = false) => {
    if (!store.connection) throw new Error('请先连接 Being。');
    if (restart) {
      await portal.stop();
      if (!store.settings.backgroundEnabled && background.state.enabled) await background.disable();
    }
    if (replacing) {
      const selected = app.isPackaged ? (await loadRuntimeBundle(process.resourcesPath)).binary : binary;
      await portal.stop();
      if (background.installedService && (!ownedRoot())) await background.forget();
      await store.save({ ...store.settings, portalBinary: selected });
    }
    if (store.settings.backgroundEnabled) {
      await portal.stop();
      try {
        await background.enable(store.settings, store.connection);
        if (replacing) await new RuntimeUpdater(directory, background).waitReady(background.installedService!);
      } catch (error) {
        // A failed takeover stays stopped; never resurrect the old supervisor.
        if (replacing) await background.disable();
        throw error;
      }
      await publishBackground();
    } else await portal.start(store.settings, store.connection, background.installedService?.environment);
  };
  const publishCurrentPortal = async () => { if (takeover.holdMessage || !portal.managing) await publishBackground(); };
  handle('beings:connection-defaults', async (input: Pick<SaveSettings, 'connectionLink'>) => {
    const connection = store.resolveConnection(input);
    if (connection.endpoint === store.connection?.endpoint && background.installedService) {
      return { portalName: store.settings.portalName, source: '当前本机配置' };
    }
    const targets = await externalPortal.conflicts(connection, ownedRoot());
    const previous = targets.find(item => item.service?.name);
    return { portalName: previous?.service?.name || store.settings.portalName, source: previous?.root };
  });
  // Initial reads wait for configuration validation and upgrade recovery.
  handle('beings:snapshot', () => exclusive(async () => snapshot()));
  handle('beings:appearance', (theme?: 'light' | 'dark') => exclusive(async () => {
    if (theme === undefined) return appearance;
    if (theme !== 'light' && theme !== 'dark') throw new Error('无效的配色。');
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, 'appearance.json');
    await writeFile(file + '.tmp', JSON.stringify({ theme })); await rename(file + '.tmp', file);
    nativeTheme.themeSource = theme; appearance = theme;
    if (process.platform !== 'darwin' && !(process.platform === 'win32' && Number(os.release().split('.')[2]) >= 22621)) window?.setBackgroundColor(theme === 'dark' ? '#212121' : '#ffffff');
    return appearance;
  }));
  handle('beings:town', async (query: TownQuery) => {
    const generation = townLive.state.generation;
    const result = await town.query(query);
    if (generation !== townLive.state.generation) return { ok: false, code: 'auth', message: 'Town 身份已变更，请刷新。' };
    if (result.ok) townLive.remember(query, result.data);
    else if (result.code === 'auth' && townCredentials.token && query.kind !== 'my-scrolls') townLive.rejectAuth();
    return result;
  });
  handle('beings:town-live', () => townLive.state);
  handle('beings:town-reconnect', () => townLive.restart());
  handle('beings:town-send', (input: TownPost) => {
    const generation = townLive.state.generation;
    return exclusive(async () => {
      if (generation !== townLive.state.generation || townLive.state.phase !== 'connected' || !townLive.state.beingId) return { ok: false, code: 'auth', message: 'Town 身份尚未确认或已变更，请重新打开发送窗口。' };
      const result = await town.send(input);
      if (!result.ok && result.code === 'auth') townLive.rejectAuth();
      return result;
    });
  });
  handle('beings:town-auth', () => ({ configured: Boolean(townCredentials.token), beingId: townLive.state.beingId, suggestedBeingId: store.settings.being, warning: townWarning }));
  handle('beings:town-pair', (input: { beingId: string; code: string }) => exclusive(async () => {
    if (!secretStorage.isEncryptionAvailable()) throw new Error('系统密钥库不可用，无法安全保存配对凭据。');
    const paired = await town.pair(input);
    await townCredentials.save(paired.token, paired.beingId);
    townWarning = undefined; townLive.restart();
  }));
  handle('beings:town-token', (token: string) => exclusive(async () => { await townCredentials.save(token); townWarning = undefined; townLive.restart(); }));
  handle('beings:town-open', async (route: string) => {
    if (typeof route !== 'string' || !/^\/(?:api\/(?:[a-z]+\/help|grove\/[a-zA-Z0-9_-]+\/download)|embers)?$/.test(route)) throw new Error('不支持的 Town 链接。');
    browser?.open(TOWN_ORIGIN + route);
  });
  handle('beings:kits', () => localKits(store.settings));
  handle('beings:kit-prepare', (id: string) => exclusive(async () => {
    if (!store.connection) throw new Error('请先连接 Being，再安装本机 Kit。');
    return kitInstaller.prepare(id, store.settings);
  }));
  handle('beings:kit-install', (input: KitInstallInput) => exclusive(() => kitInstaller.install(input, store.settings)));
  handle('beings:kit-discard', (ticket: string) => exclusive(() => kitInstaller.discard(ticket)));
  handle('beings:kits-open', async () => {
    const { directory } = await kitLocation(store.settings); await mkdir(directory, { recursive: true });
    const error = await shell.openPath(directory); if (error) throw new Error(error);
  });
  handle('beings:kit-import', () => exclusive(async () => {
    const choice = await dialog.showOpenDialog(window!, { title: '选择包含 manifest.json 的 Kit 目录', properties: ['openDirectory'] });
    if (choice.canceled) return { installed: false };
    const kit = await readKit(choice.filePaths[0]);
    const { directory } = await kitLocation(store.settings);
    if (!kit.compatible) throw new Error('这个 Kit 不支持当前系统。');
    const review = await dialog.showMessageBox(window!, { type: 'question', title: '导入 Kit',
      message: `将 ${kit.name} ${kit.version} 导入本机 Portal？`,
      detail: `${kit.description}\n\n${kit.tools.length} 个工具 · 启动命令：${kit.command.join(' ')}\n目标：${directory}\n\n导入会复制文件；依赖和密钥需要自行配置。Portal 会自动刷新清单。${kit.eager ? '此 Kit 会在 Portal 启动时预热。' : 'Being 调用工具时将以当前用户身份运行此 Kit。'}`,
      buttons: ['取消', '导入'], defaultId: 0, cancelId: 0 });
    if (review.response !== 1) return { installed: false };
    const installed = await importLocalKit(choice.filePaths[0], directory);
    return { installed: true, name: installed.name };
  }));
  handle('beings:save', (input: SaveSettings) => exclusive(async () => {
    const previous = { ...store.settings }; const previousConnection = store.connection;
    await store.save(input);
    try {
      await verifyConnection();
      await takeover.run(store.connection!, 'manual', replacing => startClientPortal(replacing, true));
      await publishCurrentPortal();
    } catch (error) {
      if (previousConnection) await store.save({ ...previous, connectionLink: previousConnection.link + '&relay_secret=' + encodeURIComponent(previousConnection.relaySecret) });
      throw error;
    }
    townLive?.dispose();
    proxy.abortAll(); return snapshot();
  }));
  handle('beings:choose', async (kind: string) => {
    if (!['workspace', 'binary'].includes(kind)) throw new Error('Invalid dialog');
    const result = await dialog.showOpenDialog(window!, { title: kind === 'workspace' ? '选择 Being 工作目录' : '选择 heart-portal 可执行文件',
      properties: kind === 'workspace' ? ['openDirectory', 'createDirectory'] : ['openFile'] });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('beings:portal-start', () => exclusive(async () => {
    if (startupDeferred) {
      await restoreStartup('manual');
      if (startupDeferred) throw new Error(startupNotice);
      return portal.state;
    }
    if (!store.connection) throw new Error('请先连接 Being。');
    await verifyConnection();
    await takeover.run(store.connection, 'manual', startClientPortal);
    await publishCurrentPortal(); return portal.state;
  }));
  handle('beings:portal-stop', () => exclusive(async () => {
    if (portal.state.managed === false) throw new Error('当前 Portal 由外部管理，请使用原管理方式停止。');
    if (background.state.enabled) {
      await background.disable();
      await store.save({ ...store.settings, backgroundEnabled: false });
      await publishBackground(); return portal.state;
    }
    return portal.stop();
  }));
  handle('beings:workspace', async () => {
    if (!store.connection) throw new Error('请先保存工作目录。');
    const error = await shell.openPath(store.settings.workspace); if (error) throw new Error(error);
  });
  handle('beings:open-loom', () => exclusive(async () => {
    if (!store.connection) throw new Error('请先配置 Being 链接，再打开原版 Loom。');
    browser?.open(store.connection.link);
  }));
  let handlingConflict = false;
  portal.on('state', state => {
    if (window && !window.isDestroyed()) window.webContents.send('beings:portal-state', state);
    // A competing service can start between discovery and launch. Resolve that
    // race once through the same confirmation path, never from a retry timer.
    if (state.conflict && !handlingConflict && !takeover.holdMessage && !quitting) {
      handlingConflict = true;
      void exclusive(async () => {
        if (background.state.enabled && !background.state.running) await background.disable();
        if (store.connection) await takeover.run(store.connection, 'automatic', startClientPortal, true);
        await publishBackground();
      }).catch(error => {
        portal.state = { phase: 'error', managed: false, message: takeover.holdMessage || String(error), logs: [] };
        portal.emit('state', portal.state);
      }).finally(() => { handlingConflict = false; });
    }
  });
  const applicationMenu = Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: CLIENT_NAME, submenu: [
      { role: 'about' as const, label: `关于 ${CLIENT_NAME}` },
      { type: 'separator' as const }, { role: 'services' as const, label: '服务' },
      { type: 'separator' as const },
      { role: 'hide' as const, label: `隐藏 ${CLIENT_NAME}` },
      { role: 'hideOthers' as const, label: '隐藏其他应用' },
      { role: 'unhide' as const, label: '显示全部' },
      { type: 'separator' as const }, { role: 'quit' as const, label: `退出 ${CLIENT_NAME}` },
    ] }] : []),
    { label: '客户端', submenu: [{ label: '显示主窗口', click: showWindow }, { label: '退出客户端', click: () => app.quit() }] },
    { role: 'editMenu' }, { label: '视图', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' }, { label: '帮助', submenu: [{ label: '检查更新…', click: () => { void showUpdates(); } }] },
  ]);
  // Windows keeps every command in the in-app options or tray. Removing the
  // native application menu avoids a second, visually unrelated top bar.
  Menu.setApplicationMenu(process.platform === 'win32' ? null : applicationMenu);
  const trayIcon = nativeImage.createFromPath(path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(),
    app.isPackaged ? 'branding/app.png' : 'resources/branding/app.png'));
  tray = new Tray(trayIcon.resize({ width: process.platform === 'darwin' ? 18 : 24, height: process.platform === 'darwin' ? 18 : 24 }));
  tray.setToolTip(CLIENT_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: showWindow },
    { type: 'separator' },
    { label: '退出客户端', click: () => app.quit() },
  ]));
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  async function restoreStartup(intent: 'manual' | 'automatic' = 'automatic') {
    if (!store.connection) {
      if (installIntent) {
        await clientInstall.resume(installIntent);
        runtimeUpdate = { phase: 'current', message: installIntent.from === installIntent.target ? '客户端已重新安装；原 Portal 运行方式已恢复。' : '客户端已更新；连接配置完成后可启动 Portal。' };
      }
      return;
    }
    try { await verifyConnection(); startupDeferred = false; }
    catch (error) {
      startupDeferred = true;
      startupNotice = (error as Error).message;
      runtimeUpdate = { phase: 'skipped', message: startupNotice };
      portal.state = { phase: 'stopped', message: startupNotice, logs: [] };
      // Keep pending upgrade records: reconnect/restart can finish safely.
      return;
    }
    try {
      const connection = store.connection;
      await takeover.run(connection, intent, async replacing => {
        if (replacing) { await startClientPortal(true); return; }
        if (installIntent && app.getVersion() === installIntent.from) {
          await clientInstall.resume(installIntent);
          if (installIntent.foreground) await portal.start(store.settings, connection);
          else await publishBackground();
          runtimeUpdate = installIntent.from === installIntent.target
            ? { phase: 'current', message: '客户端已重新安装，已恢复原 Portal。' }
            : { phase: 'error', message: '客户端安装未完成，已恢复安装前的 Portal。' };
          return;
        }
        const updater = new RuntimeUpdater(directory, background, process.platform, undefined,
          async () => {
            const saved = installIntent?.services.map(s => s.service).filter(s => s.kind === 'portable') || [];
            // New external services must go through the confirmation above.
            // Saved install targets were already reviewed before installation.
            return saved;
          });
        const recovered = await updater.recover();
        if (recovered) {
          runtimeUpdate = { phase: 'error', message: '已恢复上次未完成升级前的 Portal；本次启动不再自动重试升级。' };
          await publishBackground();
          return;
        }
        if (app.isPackaged) {
          const { bundle, binary: bundledBinary } = await loadRuntimeBundle(process.resourcesPath);
          runtimeUpdate = await updater.sync(bundledBinary, bundle, store.settings, connection);
          if (runtimeUpdate.phase !== 'skipped') {
            if (runtimeUpdate.phase === 'current' || runtimeUpdate.phase === 'updated') {
              const service = background.installedService!;
              await store.save({ ...store.settings, portalBinary: path.join(service.root, process.platform === 'win32' ? 'heart-portal.exe' : 'heart-portal'), portalConfigPath: service.configPath, workspace: service.cwd || store.settings.workspace, portalEnvironmentPath: service.environment?.PATH || store.settings.portalEnvironmentPath, portalName: service.name || store.settings.portalName });
              await restoreRuntimeMode(background, store.settings, async () => {
                await portal.start(store.settings, connection, service.environment);
                await portal.waitReady();
              },
                runtimeUpdate.phase === 'updated' || Boolean(installIntent));
              if (installIntent) await clientInstall.finish();
            }
            await publishCurrentPortal();
            // The replacement follows the existing background/foreground preference.
            return;
          }
          if (await observeExternal()) {
            runtimeUpdate = { phase: 'skipped', message: '发现未能确认管理方式的独立 Portal，未改动其进程和文件。请先迁入客户端管理。' };
            return;
          }
          await store.save({ ...store.settings, portalBinary: bundledBinary });
          runtimeUpdate = { phase: 'current', message: '已选择随客户端附带的 Portal，下次启动按原配置运行。', portalVersion: bundle.portalVersion };
        }
        if (installIntent || store.settings.backgroundEnabled || store.settings.autoStart) {
          if (await observeExternal()) { /* Only identity-verified supervision is migrated. */ }
          else if (store.settings.backgroundEnabled) {
            await background.enable(store.settings, connection); await publishBackground();
          } else {
            await portal.start(store.settings, connection);
            if (installIntent) await portal.waitReady();
          }
        }
        if (installIntent) await clientInstall.finish();
      });
      await publishCurrentPortal();
    } catch (error) {
      recoveryBlocked = await access(path.join(directory, 'runtime-update.json')).then(() => true, () => false);
      runtimeUpdate = { phase: 'error', message: String(error) };
      portal.state = { phase: 'error', message: `Portal 更新或启动未完成：${(error as Error).message}`, logs: [] };
      portal.emit('state', portal.state);
      if (!quitting && window) void dialog.showMessageBox(window, { type: 'warning', title: 'Portal 更新未完成', message: runtimeUpdate.message, buttons: ['知道了'] });
    }
  }
  createWindow();
  await exclusive(() => restoreStartup());
  if (app.isPackaged && !process.env.PORTAL_DESKTOP_USER_DATA) {
    void updates.check();
    updatePoll = setInterval(() => { void updates.check(); }, 6 * 60 * 60 * 1000);
    updatePoll.unref();
  }
  let pollingBackground = false;
  backgroundPoll = setInterval(() => {
    if (quitting || pollingBackground || portal.managing || !store.connection) return;
    pollingBackground = true;
    void exclusive(publishBackground).catch(() => {
      portal.state = { phase: 'error', message: '无法读取后台服务状态，请在本机设置中重新启用。', logs: [] };
      portal.emit('state', portal.state);
    }).finally(() => { pollingBackground = false; });
  }, 3000);
  backgroundPoll.unref();
}
const squirrelEvent = process.platform === 'win32' ? installerEvent(process.argv) : undefined;
if (squirrelEvent) { void handleInstallerEvent(squirrelEvent, process.execPath).catch(() => { process.exitCode = 1; }).finally(() => app.quit()); }
else if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, argv) => {
    const args = argv ?? [];
    const target = installerTarget(args);
    if (target) {
      if (prepareInstallerShutdown) prepareInstallerShutdown(target);
      else pendingInstallerTarget = target;
      return;
    }
    if (args.includes('--quit-for-update')) { app.quit(); return; }
    showWindow();
  });
  app.whenReady().then(ready).catch(error => { dialog.showErrorBox(`${CLIENT_NAME} 启动失败`, String(error)); app.quit(); });
  app.on('activate', showWindow);
  app.on('window-all-closed', () => { /* Explicit quit owns process cleanup. */ });
  app.on('before-quit', event => {
    if (quitCleanupDone || sessionEnding || !portal) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    lifecycleError = '';
    void exclusive(async () => { await kitInstaller?.dispose(); await portal.stop(); browser?.close(); }).then(() => {
      clearInterval(backgroundPoll); clearInterval(updatePoll);
      townLive?.dispose(); proxy.abortAll();
      quitCleanupDone = true; tray?.destroy(); app.quit();
    }).catch(() => {
      quitting = false;
      lifecycleError = '退出未完成，当前客户端保持打开。请在 Portal 设置中检查运行状态，停止后再退出。';
      showWindow();
      if (window && !window.isDestroyed()) void dialog.showMessageBox(window, { type: 'error', title: '退出未完成', message: lifecycleError, buttons: ['知道了'] }).catch(() => {});
    });
  });
}
