import { app, clipboard, dialog, ipcMain, net, nativeTheme, protocol, safeStorage, shell, type BrowserWindow, type Tray } from 'electron';
import { clientStartup } from './app/startup';
import { clientUserData, profileOverride } from './app/profile';
import type { ClientBrowser } from './browser/browser';
import { createMainWindow } from './app/window';
import { configureLocalSession, registerLocalProtocol } from './app/protocol';
import { createApplicationTray, installApplicationMenu } from './app/tray';
import path from 'node:path';
import os from 'node:os';
import { access, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { SettingsStore } from './app/settings';
import { loadDesktopId } from './app/identity';
import { ClientErrorLog } from './app/error-log';
import { portalLogText } from './portal/diagnostics';
import { PortalSupervisor } from './portal/supervisor';
import { ExternalPortalObserver } from './portal/external';
import { PortalTakeover } from './portal/takeover';
import { RuntimeUpdater, loadRuntimeBundle, restoreRuntimeMode, type RuntimeUpdateResult } from './updates/runtime';
import { UpdateChecker } from './updates/checker';
import { ClientInstall } from './updates/client-install';
import { stageInstaller } from './updates/manual-installer';
import { installerEvent, installerTarget, handleInstallerEvent } from './updates/installer-events';
import { BackgroundPortal } from './portal/background';
import { KitInstaller } from './kits/install';
import { ChatProxy } from './chat/proxy';
import { loadDesktopScene } from './chat/scene';
import { verifyBeingConnection } from './chat/ready';
import { redact } from './chat/connection';
import type { ChatScene, SaveSettings } from '../shared/types';
import { TownLive } from './town/live';
import { TownClient, TownCredentials, TOWN_ORIGIN } from './town/client';
import { registerTownIpc } from './town/ipc';
import { registerKitsIpc } from './kits/ipc';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;
declare const PORTAL_DESKTOP_UPDATE_REPOSITORY: string;
declare const PORTAL_DESKTOP_BUILD: string;
const startedAt = new Date().toISOString();
// The display name, and — since Electron derives the profile directory and the
// encrypted-storage identity from it — the application name as well. The
// lower-case slug this client reports to Being, Town and GitHub is
// `being-desktop`, spelled at each of its three call sites (chat/scene.ts,
// town/pairing.ts, updates/checker.ts) as in BeingDesktop 0.8.26.
const CLIENT_NAME = 'Being Desktop';

protocol.registerSchemesAsPrivileged([{ scheme: 'beings', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
// Electron derives the encrypted-storage identity from the application name, so
// this has to run before any safeStorage call and has to match BeingDesktop
// 0.8.26 (src/main.cjs line 87) exactly: a different name leaves every
// credential already in the system keychain undecryptable.
let profileError: unknown;
let userData: string;
try {
  app.setName(CLIENT_NAME);
  app.setAboutPanelOptions({ applicationName: CLIENT_NAME });
  userData = clientUserData(() => app.getPath('appData'), profileOverride());
  app.setPath('userData', userData);
  app.setPath('sessionData', userData);
} catch (error) {
  profileError = error;
  // This directory only receives startup diagnostics; never start a fresh
  // client profile when the real profile cannot be resolved.
  userData = path.join(os.tmpdir(), 'being-desktop-startup');
}
let window: BrowserWindow | null = null;
let windowReady = false;
let browser: ClientBrowser | undefined;
let portal: PortalSupervisor;
let proxy: ChatProxy;
let store: SettingsStore;
let background: BackgroundPortal;
let kitInstaller: KitInstaller;
let townLive: TownLive;
let cancelTownPairing: (() => void) | undefined;
let updatePoll: ReturnType<typeof setInterval> | undefined;
let backgroundPoll: ReturnType<typeof setInterval> | undefined;
let quitting = false;
let quitCleanupDone = false;
let sessionEnding = false;
let tray: Tray | undefined;
let desktopId = '';
let lifecycleError = '';
const errorLog = new ClientErrorLog(userData, () => [store?.connection?.token || '', store?.connection?.relaySecret || '']);
let mutation = Promise.resolve();
let prepareInstallerShutdown: ((target: string) => void) | undefined;
let pendingInstallerTarget: string | undefined;
const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
  const next = mutation.then(operation);
  mutation = next.then(() => {}, () => {});
  return next;
};
const shellURL = () => new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL || 'beings://desktop/').href;

async function openExternal(url: string) {
  try {
    const parsed = new URL(url);
    if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password) browser?.open(url);
  } catch { /* Unsupported links stay inside the sandbox. */ }
}
function showWindow() {
  // A second launch can arrive while credentials/background discovery await IO.
  // Do not load beings:// before the protocol and trusted IPC are registered.
  if (quitting || !windowReady) return;
  if (!window) { createWindow(); return; }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
function createWindow() {
  if (!windowReady || quitting || (window && !window.isDestroyed())) return;
  const created = createMainWindow({
    shellURL,
    isQuitting: () => quitting,
    isSessionEnding: () => sessionEnding,
    markSessionEnding: () => { sessionEnding = true; },
    openExternal: url => { void openExternal(url); },
    onBrowser: value => { browser = value; },
    onClosed: value => { if (window === value) window = null; },
  });
  window = created.window;
  browser = created.browser;
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
  catch (error) { startupNotice = errorLog.report('settings-load', error, '连接配置读取失败，请检查密钥库或连接设置。'); }
  // The Desktop ID is this profile's persistent identity towards the Being
  // (BeingDesktop src/desktop-identity.cjs, loaded from restore() right after
  // the profile directory). A profile that cannot mint one still opens; the
  // identity stays absent rather than being invented again on every launch.
  try { desktopId = await loadDesktopId(directory); }
  catch (error) { startupNotice = errorLog.report('desktop-identity', error, 'Desktop 身份读取失败，请检查客户端配置目录后重试。'); }
  let configCandidates: string[] = [];
  const reusePreviousConfig = async () => {
    await store.reusePortalConfig(configCandidates);
    if (store.connection && store.settings.portalConfigPath) await store.save(store.settings);
  };
  try {
    const savedService = JSON.parse(await readFile(path.join(directory, 'portal-service.json'), 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'null';
      throw error;
    }));
    if (savedService && (savedService.existing || savedService.kind || savedService.label !== new BackgroundPortal(directory).label)) {
      configCandidates.push(savedService.configPath || path.join(savedService.root, 'portal.toml'));
    }
    // An explicitly selected profile is independent (including test profiles).
    // Its own saved service can still migrate, but it must not import the user's
    // global Being connection or workspace just because it is initially empty.
    if (!store.connection && !profileOverride()) configCandidates.push(path.join(os.homedir(), '.heart-portal/portal.toml'), path.join(os.homedir(), '.heart-portal/runtime/portal.toml'));
    await reusePreviousConfig();
  } catch (error) { startupNotice = errorLog.report('portal-config-import', error, '已有 Portal 配置读取失败，请检查后重试。'); }
  const townCredentials = new TownCredentials(directory, secretStorage);
  let townWarning: string | undefined;
  try { await townCredentials.load(); } catch (error) { townWarning = errorLog.report('town-credentials', error, 'Town 凭据读取失败，请重新连接。'); }
  townLive = new TownLive(() => townCredentials.token, () => townCredentials.beingId, state => { if (window && !window.webContents.isDestroyed()) window.webContents.send('beings:town-live', state); }, net.fetch.bind(net) as typeof fetch, TOWN_ORIGIN, () => townCredentials.display);
  const town = new TownClient(() => townCredentials.token, net.fetch.bind(net) as typeof fetch, TOWN_ORIGIN, () => townLive.state.beingId || '');
  townLive.restart();
  kitInstaller = new KitInstaller(directory, net.fetch.bind(net) as typeof fetch);
  portal = new PortalSupervisor(directory);
  background = new BackgroundPortal(directory);
  try { await background.discover(store.settings, store.connection); }
  catch (error) {
    startupNotice = errorLog.report('background-discovery', error, '后台 Portal 状态读取失败，请稍后重试。');
    portal.state = { phase: 'error', message: startupNotice, logs: [] };
  }
  if (!background.state.supported) store.settings.backgroundEnabled = false;
  let chatScene: ChatScene | undefined;
  let chatSceneNotice: string | undefined;
  try { chatScene = await loadDesktopScene(directory, app.getVersion(), os.hostname()); }
  catch { chatSceneNotice = '桌面场景标识未能读取或保存，暂时无法发送消息。请检查客户端配置目录后重启。'; }
  proxy = new ChatProxy(() => store.connection, net.fetch.bind(net) as typeof fetch, chatScene);
  const assets = app.isPackaged ? path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`) : path.resolve('desktop/generated');
  registerLocalProtocol(assets, proxy);
  configureLocalSession();
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
        type: 'error', title: '无法开始安装', message: errorLog.report('installer-start', error, '安装准备失败，请查看日志后重试。'),
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
    ipcMain.handle(channel, async (event, ...args) => {
      const frame = event.senderFrame;
      if (!window || event.sender !== window.webContents || frame !== window.webContents.mainFrame || frame.url !== shellURL()) throw new Error('Untrusted IPC sender');
      if (quitting && !['beings:browser-bounds', 'beings:diagnostics'].includes(channel)) throw new Error('客户端正在退出，请稍候。');
      if (recoveryBlocked && ['beings:save', 'beings:portal-start', 'beings:portal-stop'].includes(channel)) throw new Error('Portal 升级恢复尚未完成，请重新启动客户端完成恢复。');
      try { return await callback(...args); }
      catch (error) { throw new Error(errorLog.report(channel, error)); }
    });
  };
  handle('beings:client-startup', (enabled?: boolean) => clientStartup(app, process.platform, process.execPath, enabled));
  handle('beings:quit', () => { setImmediate(() => app.quit()); });
  handle('beings:browser-state', () => browser?.state);
  handle('beings:browser-open', (url?: string) => browser?.open(url));
  handle('beings:clipboard-copy', (text: string) => {
    if (typeof text !== 'string' || text.length > 200000) throw new Error('复制内容过长。');
    clipboard.writeText(text);
  });
  handle('beings:browser-action', (action: import('../shared/types').BrowserAction) => browser?.action(action));
  handle('beings:browser-bounds', (bounds: import('../shared/types').BrowserBounds) => browser?.setBounds(bounds));
  const diagnose = async (): Promise<import('../shared/types').DiagnosticReport> => {
    const connection = store.connection;
    const checks: import('../shared/types').DiagnosticReport['checks'] = [];
    checks.push({ name: '客户端', status: 'ok', detail: `主进程 ${process.pid} · 关闭窗口保留运行，退出客户端结束进程` });
    if (lifecycleError) checks.push({ name: '上次退出', status: 'error', detail: lifecycleError });
    checks.push({ name: '凭据保护', status: secretStorage.isEncryptionAvailable() ? 'ok' : 'error', detail: secretStorage.isEncryptionAvailable() ? '系统密钥库可用' : '系统密钥库不可用' });
    try { await access(store.settings.workspace); checks.push({ name: '工作目录', status: 'ok', detail: '目录可访问' }); }
    catch { checks.push({ name: '工作目录', status: 'warning', detail: '目录尚未创建或不可访问' }); }
    try { await verifyBeingConnection(connection, net.fetch.bind(net) as typeof fetch); checks.push({ name: 'Being', status: 'ok', detail: '现有状态接口可访问；未发送消息或调用工具' }); }
    catch (error) { checks.push({ name: 'Being', status: 'warning', detail: errorLog.report('being-diagnostics', error, 'Being 连接检查失败，请稍后重试。') }); }
    if (connection !== store.connection) throw new Error('连接已切换，请重新检查。');
    checks.push({ name: 'Portal', status: portal.state.phase === 'connected' ? 'ok' : portal.state.phase === 'error' ? 'error' : 'warning', detail: portal.state.message });
    checks.push({ name: 'Town', status: townLive.state.phase === 'connected' ? 'ok' : 'warning', detail: townLive.state.message });
    return { version: app.getVersion(), build: PORTAL_DESKTOP_BUILD, platform: `${process.platform}/${process.arch}`, pid: process.pid, startedAt, checkedAt: new Date().toISOString(), checks,
      logs: portal.state.logs.slice(-60).map(line => redact(line, [connection?.token || '', connection?.relaySecret || '']).replaceAll(os.homedir(), '~')) };
  };
  handle('beings:diagnostics', diagnose);
  const capturePortalLogs = async () => {
    const state = { ...portal.state, logs: [...portal.state.logs] };
    await errorLog.exportSnapshot(state.logs, { version: app.getVersion(), platform: `${process.platform}/${process.arch}`,
      capturedAt: new Date().toISOString(), workspace: store.settings.workspace,
      portal: { ...state, logs: undefined }, background: background.state,
      runtimeDirectory: background.installedService?.root || directory });
    return { state, errors: await errorLog.recentText() };
  };
  handle('beings:portal-log-reference', async () => {
    const connection = store.connection;
    if (!connection) throw new Error('请先连接 Being。');
    const { state, errors } = await capturePortalLogs();
    if (connection !== store.connection) throw new Error('连接已切换，请重新选择 Portal 日志。');
    return { endpoint: connection.endpoint, text: portalLogText({ version: app.getVersion(),
      platform: `${process.platform}/${process.arch}`, portal: state, errors, home: os.homedir(),
      secrets: [connection.token, connection.relaySecret] }) };
  });
  handle('beings:logs', async () => {
    await capturePortalLogs();
    const error = await shell.openPath(errorLog.directory);
    if (error) throw new Error(error);
  });
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
  let updateDownload: AbortController | undefined;
  const showUpdates = async () => {
    if (showingUpdates || !window) return;
    showingUpdates = true;
    try {
      const state = await updates.check();
      const answer = await dialog.showMessageBox(window, { type: state.phase === 'available' ? 'info' : 'none', title: '客户端更新',
        message: state.phase === 'available' ? `发现 ${CLIENT_NAME} ${state.latestVersion}` : state.message,
        detail: `当前客户端：${app.getVersion()}${runtimeUpdate.portalVersion ? ` · Portal：${runtimeUpdate.portalVersion}` : ''}\n${runtimeUpdate.message}\n\n下载并校验安装包后，先停止客户端 Portal 和对应守护，再安装客户端。安装完成自动打开新版，沿用原配置启动最新 Portal。请先完成本机任务并保存草稿。`,
        buttons: state.phase === 'available' && app.isPackaged ? ['稍后', '下载并升级', '打开发布页'] : ['关闭', '打开发布页'], defaultId: 0, cancelId: 0 });
      if (state.phase === 'available' && app.isPackaged && answer.response === 1) {
        const controller = new AbortController();
        updateDownload = controller;
        updates.setActivity({ phase: 'metadata', version: state.latestVersion! });
        window?.setProgressBar(2);
        let handoff: Awaited<ReturnType<typeof stageInstaller>>;
        let lastProgress = 0;
        try {
          handoff = await stageInstaller(directory, state.latestVersion!, PORTAL_DESKTOP_UPDATE_REPOSITORY, process.execPath, net.fetch.bind(net) as typeof fetch, {
            signal: controller.signal,
            onProgress: progress => {
              const now = Date.now();
              if (progress.phase === 'downloading' && progress.received && progress.received !== progress.total && now - lastProgress < 200) return;
              lastProgress = now;
              updates.setActivity({ ...progress, version: state.latestVersion! });
              window?.setProgressBar(progress.phase === 'downloading' && progress.total ? Math.min(1, (progress.received || 0) / progress.total) : 2);
            },
          });
        } catch (error) {
          if (controller.signal.aborted) return;
          throw error;
        } finally { updateDownload = undefined; window?.setProgressBar(-1); }
        if (!window || quitting) { await handoff.discard(); return; }
        updates.setActivity({ phase: 'ready', version: state.latestVersion! });
        const confirmed = await dialog.showMessageBox(window, { type: 'info', title: '安装包已就绪', message: `安装 ${CLIENT_NAME} ${state.latestVersion}`, detail: '已完成下载和校验。继续将停止 Portal 及守护、关闭客户端，安装成功后自动打开新版并恢复运行。执行中的本机任务会中断，请先保存草稿。', buttons: ['稍后', '停止 Portal 并安装'], defaultId: 0, cancelId: 0 });
        if (confirmed.response !== 1) { await handoff.discard(); return; }
        updates.setActivity({ phase: 'installing', version: state.latestVersion! });
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
      updates.setActivity();
      const message = errorLog.report('client-update', error, '客户端升级未完成，请稍后重试。');
      if (window && !quitting) await dialog.showMessageBox(window, { type: 'error', title: '客户端升级未完成', message, detail: '原配置和恢复记录已保留。可重新打开客户端恢复，或稍后重试。', buttons: ['知道了'] });
    } finally { showingUpdates = false; updates.setActivity(); }
  };
  handle('beings:check-updates', showUpdates);
  handle('beings:cancel-update', () => { updateDownload?.abort(); });
  handle('beings:update-state', () => updates.state);
  const snapshot = () => ({ settings: store.settings, desktopId, portal: portal.state, background: background.state, chatScene, notice: [startupNotice && errorLog.report('startup-notice', startupNotice), chatSceneNotice].filter(Boolean).join('\n') || undefined });
  const verifyConnection = async () => {
    await reusePreviousConfig();
    await verifyBeingConnection(store.connection, net.fetch.bind(net) as typeof fetch);
    startupNotice = undefined;
  };
  const externalPortal = new ExternalPortalObserver();
  const ownedRoot = () => background.installedService?.label === background.label && !background.installedService.existing ? background.installedService.root : undefined;
  const publishBackground = async () => {
    const state = await background.portalState();
    if (takeover.holdMessage) {
      startupNotice = errorLog.report('portal-takeover', takeover.holdMessage, 'Portal 切换未完成，请检查日志后重试。');
      portal.state = { ...state, phase: 'error', managed: false, message: startupNotice };
      portal.emit('state', portal.state); return;
    }
    portal.state = state;
    portal.emit('state', portal.state);
  };
  const takeover = new PortalTakeover(directory, {
    discover: connection => externalPortal.conflicts(connection, ownedRoot()),
    preflight: async targets => {
      await verifyConnection();
      await store.reusePortalConfig(targets.map(item => item.service?.configPath || path.join(item.root, 'portal.toml')));
      await store.save(store.settings);
      if (app.isPackaged) await loadRuntimeBundle(process.resourcesPath);
      else await access(binary);
    },
    stop: async target => { await background.unload(target.service!); },
  });
  const startClientPortal = async (replacing = false, restart = false) => {
    if (!store.connection) throw new Error('请先连接 Being。');
    if (restart) {
      await portal.stop();
      if (!store.settings.backgroundEnabled && background.state.enabled) await background.disable();
    }
    if (app.isPackaged) await loadRuntimeBundle(process.resourcesPath);
    if (replacing) await portal.stop();
    await store.save(store.settings);
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
    } else {
      if (background.state.enabled) await background.disable();
      await portal.start(store.settings, store.connection);
      if (replacing) await portal.waitReady();
    }
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
  cancelTownPairing = registerTownIpc({
    handle, exclusive, town, townLive, townCredentials, store, secretStorage,
    fetcher: net.fetch.bind(net) as typeof fetch,
    getWarning: () => townWarning,
    clearWarning: () => { townWarning = undefined; },
    open: url => browser?.open(url),
  });
  registerKitsIpc({ handle, exclusive, window: () => window, store, kitInstaller });
  handle('beings:save', (input: SaveSettings) => exclusive(async () => {
    cancelTownPairing?.();
    const previous = { ...store.settings }; const previousConnection = store.connection;
    // Restore the saved address itself on rollback: a link reassembled from the
    // parsed parts would drop the parameters this client does not model (`api=`).
    const previousAddress = store.connectionAddress;
    await store.save(input);
    try {
      await verifyConnection();
      await takeover.run(store.connection!, 'manual', async replacing => {
        // Discovery may import an old configuration during takeover. The switches
        // explicitly saved in this operation must take precedence over that file.
        store.settings = { ...store.settings, allowExec: input.allowExec, kitsEnabled: input.kitsEnabled };
        await startClientPortal(replacing, true);
      });
      await publishCurrentPortal();
    } catch (error) {
      if (previousConnection) await store.save({ ...previous, connectionLink: previousAddress || previousConnection.link + '&relay_secret=' + encodeURIComponent(previousConnection.relaySecret) });
      throw error;
    }
    townLive?.dispose();
    proxy.abortAll(); return snapshot();
  }));
  handle('beings:choose', async (kind: string) => {
    if (kind !== 'workspace') throw new Error('Invalid dialog');
    const result = await dialog.showOpenDialog(window!, { title: '选择 Being 工作目录', properties: ['openDirectory', 'createDirectory'] });
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
    if (state.phase === 'error' || state.phase === 'external') {
      if (state.logs.length) errorLog.report('portal-runtime', state.logs.slice(-60).join('\n'));
      state = { ...state, message: errorLog.report('portal-state', state.message, 'Portal 启动未完成，请查看日志后重试。') };
      portal.state = state;
    }
    if (window && !window.isDestroyed()) window.webContents.send('beings:portal-state', state);
    // A competing service can start between discovery and launch. Resolve that
    // race once through the same stop/start path, never from a retry timer.
    if (state.conflict && !handlingConflict && !takeover.holdMessage && !quitting) {
      handlingConflict = true;
      void exclusive(async () => {
        if (background.state.enabled && !background.state.running) await background.disable();
        if (store.connection) await takeover.run(store.connection, 'automatic', startClientPortal, true);
        await publishBackground();
      }).catch(error => {
        portal.state = { phase: 'error', managed: false, message: errorLog.report('portal-conflict', error, 'Portal 切换未完成，请检查日志后重试。'), logs: [] };
        portal.emit('state', portal.state);
      }).finally(() => { handlingConflict = false; });
    }
  });
  installApplicationMenu(showWindow, () => { void showUpdates(); });
  tray = createApplicationTray(showWindow, app.isPackaged);
  async function restoreStartup(intent: 'manual' | 'automatic' = 'automatic') {
    if (!store.connection) {
      if (installIntent) {
        await clientInstall.finish();
        runtimeUpdate = { phase: 'current', message: '客户端已安装；连接配置完成后使用客户端 Portal。' };
      }
      return;
    }
    try { await verifyConnection(); startupDeferred = false; }
    catch (error) {
      startupDeferred = true;
      startupNotice = errorLog.report('startup-connection', error, '连接检查失败，请检查设置后重试。');
      runtimeUpdate = { phase: 'skipped', message: startupNotice };
      portal.state = { phase: 'stopped', message: startupNotice, logs: [] };
      // Keep pending upgrade records: reconnect/restart can finish safely.
      return;
    }
    try {
      const connection = store.connection;
      await takeover.run(connection, intent, async replacing => {
        if (replacing) { await startClientPortal(true); if (installIntent) await clientInstall.finish(); return; }
        const updater = new RuntimeUpdater(directory, background);
        const recovered = await updater.recover();
        if (recovered && background.installedService) {
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
              await store.save({ ...store.settings, portalConfigPath: service.generatedConfig ? undefined : service.configPath, workspace: service.cwd || store.settings.workspace });
              await restoreRuntimeMode(background, store.settings, async () => {
                await portal.start(store.settings, connection);
                await portal.waitReady();
              },
                runtimeUpdate.phase === 'updated' || Boolean(installIntent));
              if (installIntent) await clientInstall.finish();
            }
            await publishCurrentPortal();
            // The replacement follows the existing background/foreground preference.
            return;
          }
          await store.save({ ...store.settings, portalBinary: bundledBinary });
          runtimeUpdate = { phase: 'current', message: '已选择随客户端附带的 Portal，下次启动按原配置运行。', portalVersion: bundle.portalVersion };
        }
        if (installIntent || store.settings.backgroundEnabled || store.settings.autoStart) {
          if (store.settings.backgroundEnabled) {
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
      const message = errorLog.report('portal-startup', error, 'Portal 启动未完成，请查看日志后重试。');
      runtimeUpdate = { phase: 'error', message };
      portal.state = { phase: 'error', message, logs: [] };
      portal.emit('state', portal.state);
      if (!quitting && window) void dialog.showMessageBox(window, { type: 'warning', title: 'Portal 更新未完成', message: runtimeUpdate.message, buttons: ['知道了'] });
    }
  }
  windowReady = true;
  createWindow();
  await exclusive(() => restoreStartup());
  if (app.isPackaged && !profileOverride()) {
    void updates.check();
    updatePoll = setInterval(() => { void updates.check(); }, 6 * 60 * 60 * 1000);
    updatePoll.unref();
  }
  let pollingBackground = false;
  backgroundPoll = setInterval(() => {
    if (quitting || pollingBackground || portal.managing || !store.connection) return;
    pollingBackground = true;
    void exclusive(publishBackground).catch(error => {
      errorLog.report('background-poll', error);
      portal.state = { phase: 'error', message: '无法读取后台服务状态，请在本机设置中重新启用。', logs: [] };
      portal.emit('state', portal.state);
    }).finally(() => { pollingBackground = false; });
  }, 3000);
  backgroundPoll.unref();
}
const squirrelEvent = process.platform === 'win32' ? installerEvent(process.argv) : undefined;
if (profileError) {
  const message = errorLog.report('profile-initialization', profileError, '客户端配置目录不可用，请检查系统用户目录后重试。');
  void app.whenReady().then(async () => {
    dialog.showErrorBox(`${CLIENT_NAME} 启动失败`, message);
    await errorLog.flush(); app.quit();
  });
} else if (squirrelEvent) { void handleInstallerEvent(squirrelEvent, process.execPath).catch(error => { errorLog.report('installer-event', error); process.exitCode = 1; }).finally(() => app.quit()); }
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
  app.whenReady().then(ready).catch(async error => {
    dialog.showErrorBox(`${CLIENT_NAME} 启动失败`, errorLog.report('client-startup', error, '客户端启动失败，请查看日志后重试。'));
    await errorLog.flush(); app.quit();
  });
  app.on('activate', showWindow);
  app.on('window-all-closed', () => { /* Explicit quit owns process cleanup. */ });
  app.on('before-quit', event => {
    if (quitCleanupDone || sessionEnding || !portal) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    cancelTownPairing?.();
    lifecycleError = '';
    void exclusive(async () => { await kitInstaller?.dispose(); await portal.stop(); browser?.close(); await errorLog.flush(); }).then(() => {
      clearInterval(backgroundPoll); clearInterval(updatePoll);
      townLive?.dispose(); proxy.abortAll();
      quitCleanupDone = true; tray?.destroy(); app.quit();
    }).catch(error => {
      errorLog.report('client-quit', error);
      quitting = false;
      lifecycleError = '退出未完成，当前客户端保持打开。请在 Portal 设置中检查运行状态，停止后再退出。';
      showWindow();
      if (window && !window.isDestroyed()) void dialog.showMessageBox(window, { type: 'error', title: '退出未完成', message: lifecycleError, buttons: ['知道了'] }).catch(() => {});
    });
  });
}
