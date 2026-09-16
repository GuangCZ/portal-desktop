// Ported from BeingDesktop src/town-controller.cjs on 2026-09-16.
// Identity and permission rules follow docs/p1-town-identity-mentions-2026-09-15.md and
// docs/town-sdk-integration.md (配对与权限、Town 身份迁移兼容): fireside and Grove registration
// stay auth_required on Desktop, and sendAs is always 'being'.
//
// IPC surface registered by BeingDesktop main.cjs boot() (registration belongs to the
// integration stage, see docs/interfaces.md section 1):
//   getTownAppState()           -> state()
//   refreshTownApp()            -> refresh(), returns state()
//   deployPortal({confirmed, permissions:{files, exec, web}}) -> {status, detail}
//   createFireside/joinFireside -> requireTownIdentity(), always rejects
// State changes reach the renderer through the injected onChange callback.
//
// Electron is never imported. Filesystem, uuid, release table, config factory, workspace
// preparation and the Grove config extension all arrive through the constructor.
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { PORTAL_RELEASE, portalRelease as defaultPortalRelease, type PortalReleaseInfo } from './portal-release';
import { createPortalConfig, preparePortalWorkspace as defaultPrepareWorkspace, type PortalConfiguration } from './portal-config';
import type { PortalInstaller, PortalProcess, TownControllerContext } from './types';

const AUTH_MESSAGE = '连接 Being 后，可在「设置 → 连接」中一键连接 Town，或使用六位配对码。';
const DEPLOY_ERRORS = new Set([
  '连接或工作区已变化，Portal 已安装但未启动。', 'Portal 配置未能保存，程序未启动。',
  'Portal 下载跳转无效。', 'Portal 下载失败，请稍后重试。', 'Portal 下载失败，请检查网络后重试。',
  'Portal 下载文件大小不符。', 'Portal 下载文件超过大小限制。', 'Portal 下载不完整。',
  'Portal 文件校验失败，未安装。', 'Portal 安装目标不是实际文件。', 'Portal 安装失败，请检查本地目录和网络。',
]);

function dataObject(value: unknown, keys: string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some((key) => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value'))) return null;
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

export function confirmedDeployment(value: unknown): boolean {
  try {
    const request = dataObject(value, ['confirmed', 'permissions']);
    const permissions = request && dataObject(request.permissions, ['files', 'exec', 'web']);
    return request?.confirmed === true && permissions?.files === true && permissions.exec === false && permissions.web === false;
  } catch { return false; }
}

export interface PortalInstallState {
  status: string;
  phase: string;
  version: string;
  verified: boolean;
  started: boolean;
  detail: string;
  [key: string]: unknown;
}

/** Injectable slice of node:fs/promises used by the deployment workflow. */
export interface ControllerFileSystem {
  lstat: typeof fsPromises.lstat;
  readFile: typeof fsPromises.readFile;
  writeFile: typeof fsPromises.writeFile;
  unlink: typeof fsPromises.unlink;
}

export interface TownControllerOptions {
  installer: PortalInstaller;
  portal: PortalProcess;
  getContext: () => TownControllerContext;
  saveDeployment: (value: { executable: string; configPath: string; version: string; workspace: string }) => Promise<unknown> | unknown;
  startPortal: () => Promise<{ status: string; detail?: string }>;
  defaultWorkspace?: string;
  onChange?: () => void;
  platform?: string;
  arch?: string;
  configFactory?: (options: { workspace: string; name: string; permissions?: unknown }) => Promise<PortalConfiguration>;
  inspectInstallation?: (value?: unknown) => Promise<any>;
  /** BeingDesktop imported these from portal-installer.cjs / portal-config.cjs / grove-portal.cjs. */
  portalRelease?: (platform: string, arch: string) => PortalReleaseInfo | null;
  defaultRelease?: PortalReleaseInfo;
  prepareWorkspace?: (options: { workspace?: string; defaultWorkspace?: string }) => Promise<string>;
  groveConfigText?: (text: string, kitsDir: string) => string;
  fs?: ControllerFileSystem;
  randomUUID?: () => string;
}

export class TownController {
  private installer: PortalInstaller;
  private portal: PortalProcess;
  private getContext: () => TownControllerContext;
  private saveDeployment: TownControllerOptions['saveDeployment'];
  private startPortal: TownControllerOptions['startPortal'];
  private defaultWorkspace: string;
  private onChange: () => void;
  private platform: string;
  private arch: string;
  private configFactory: NonNullable<TownControllerOptions['configFactory']>;
  private inspectInstallation: (value?: unknown) => Promise<any>;
  private portalRelease: NonNullable<TownControllerOptions['portalRelease']>;
  private prepareWorkspace: NonNullable<TownControllerOptions['prepareWorkspace']>;
  private groveConfigText?: (text: string, kitsDir: string) => string;
  private fs: ControllerFileSystem;
  private randomUUID: () => string;
  release: PortalReleaseInfo;
  installation: PortalInstallState;
  private _deploying: Promise<{ status: string; detail?: string }> | null = null;
  private _revision = 0;

  constructor({ installer, portal, getContext, saveDeployment, startPortal, defaultWorkspace = '', onChange = () => {}, platform = process.platform, arch = process.arch, configFactory = (options) => createPortalConfig(options), inspectInstallation, portalRelease = defaultPortalRelease, defaultRelease = PORTAL_RELEASE, prepareWorkspace = (options) => defaultPrepareWorkspace(options), groveConfigText, fs = fsPromises, randomUUID = nodeRandomUUID }: TownControllerOptions) {
    this.installer = installer;
    this.portal = portal;
    this.getContext = getContext;
    this.saveDeployment = saveDeployment;
    this.startPortal = startPortal;
    this.defaultWorkspace = defaultWorkspace;
    this.onChange = onChange;
    this.platform = platform;
    this.arch = arch;
    this.configFactory = configFactory;
    this.portalRelease = portalRelease;
    this.prepareWorkspace = prepareWorkspace;
    this.groveConfigText = groveConfigText;
    this.fs = fs;
    this.randomUUID = randomUUID;
    this.inspectInstallation = inspectInstallation || (() => installer.inspect());
    this.release = installer.release || portalRelease(platform, arch) || defaultRelease;
    this.installation = { status: 'unknown', phase: 'idle', version: this.release.version, verified: false, started: false, detail: '' };
  }

  state() {
    const context = this.getContext();
    const external = this.portal.state.status === 'external' || this.portal.state.management === 'external';
    const managed = context.managedPortal?.executable === context.portalExecutable && context.managedPortal?.configPath === context.portalConfig ? context.managedPortal : null;
    return {
      identity: { beingId: context.beingName || '', loomBeingId: context.beingName || '', townId: context.townId || '', displayName: context.displayName || context.beingName || 'Being', sendAs: 'being', connectionRevision: Number.isSafeInteger(context.connectionId) && (context.connectionId as number) >= 0 ? context.connectionId as number : null, identityRevision: Number.isSafeInteger(context.identityRevision) && (context.identityRevision as number) >= 0 ? context.identityRevision as number : null },
      access: { grove: 'ready', channel: context.connected ? 'ready' : 'disconnected', bonfire: context.connected ? 'ready' : 'disconnected', fireside: 'auth_required', groveRegistration: 'auth_required' },
      accessDetail: AUTH_MESSAGE,
      portalInstall: { ...this.installation },
      portalWorkspace: { path: external ? this.portal.state.deployment?.workspace || '' : managed?.workspace || context.portalWorkspace || this.defaultWorkspace, automatic: !external && !managed && !context.portalWorkspace, readOnly: external || Boolean(managed), source: external ? 'existing_portal' : managed ? 'managed_portal' : 'new_portal' },
      platformSupported: Boolean(this.portalRelease(this.platform, this.arch)),
      automaticKitInstallation: false,
    };
  }

  private _update(value: Record<string, unknown>) {
    this.installation = { ...this.installation, ...value } as PortalInstallState;
    try { this.onChange(); } catch { /* Observers cannot change the deployment result. */ }
  }

  async refresh() {
    const revision = this._revision;
    if (!this._deploying) {
      try {
        const installation = await this.installer.inspect();
        if (!this._deploying && revision === this._revision) this._update({ ...installation, detail: '' });
      }
      catch { if (!this._deploying && revision === this._revision) this._update({ status: 'error', detail: '无法检查本机 Portal 安装，请确认目录权限。' }); }
    }
    return this.state();
  }

  deploy(value: unknown): Promise<{ status: string; detail?: string }> {
    if (!confirmedDeployment(value)) return Promise.reject(new Error('请确认当前设备、工作区与部署权限。'));
    if (this._deploying) return this._deploying;
    this._revision++;
    this._deploying = this._deploy().finally(() => { this._deploying = null; });
    return this._deploying;
  }

  private _requireCurrent(context: TownControllerContext) {
    const current = this.getContext() as Record<string, unknown>;
    if (!current.configured || !current.connected || current.exiting
      || ['connectionId', 'identityRevision', 'beingName', 'portalWorkspace', 'portalExecutable', 'portalConfig'].some((key) => current[key] !== (context as Record<string, unknown>)[key])) {
      throw new Error('连接或工作区已变化，Portal 已安装但未启动。');
    }
  }

  private async _deploy(): Promise<{ status: string; detail?: string }> {
    if (!this.portalRelease(this.platform, this.arch)) throw new Error('当前平台没有已校验的 Portal 安装包。');
    const context = this.getContext();
    if (!context.configured || !context.connected || context.exiting) throw new Error('请先连接 Being 并等待会话加载完成。');
    await this.portal.inspect();
    this._requireCurrent(context);
    if (this.portal.state.status === 'external') {
      this._update({ status: 'external', phase: 'existing', detail: '已有 Portal 优先，沿用原工作区与配置，由原启动方式管理。' });
      return { status: 'external', detail: this.installation.detail };
    }
    if (this.portal.state.status === 'error') throw new Error(this.portal.state.detail || 'Portal 进程状态尚未确认。');
    if (this.portal.state.owned) {
      if (context.portalIdentityRevision !== undefined && context.portalIdentityRevision !== context.identityRevision) {
        this._update({ status: 'existing_connection', phase: 'existing', detail: '当前 Portal 仍使用之前的 Being 连接。请先停止 Portal，再一键配置当前连接。' });
        return { status: 'existing_connection', detail: this.installation.detail };
      }
      return { status: 'running', detail: '当前 Portal 已由桌面管理。' };
    }
    const managed = context.managedPortal;
    if (managed && managed.executable === context.portalExecutable && managed.configPath === context.portalConfig) {
      const configuration = await this.configFactory({ workspace: managed.workspace!, name: 'being-desktop', permissions: managed.permissions });
      if (managed.groveKitsDir) configuration.toml = this.groveConfigText!(configuration.toml, managed.groveKitsDir);
      if (managed.workspace !== configuration.capabilities.workspace) throw new Error('托管 Portal 的工作区已变化，请先在连接设置核对配置。');
      this._update({ status: 'installing', phase: 'checking', detail: '正在核对已部署的 Portal。', recovery: null });
      try {
        const installed = await this.inspectInstallation(managed);
        if (!installed.verified || installed.executable !== managed.executable) throw new Error('Portal 文件校验失败，未安装。');
        const configStat = await this.fs.lstat(managed.configPath!);
        if (!configStat.isFile() || configStat.isSymbolicLink() || await this.fs.readFile(managed.configPath!, 'utf8') !== configuration.toml) throw new Error('托管配置已改变，请在连接设置检查后启动。');
        this._requireCurrent(context);
        this._update({ status: 'installed', phase: 'starting', verified: true, detail: '正在启动已部署的 Portal。' });
        const started = await this.startPortal();
        this._update({ status: 'installed', phase: started.status === 'running' ? 'running' : 'not_started', started: started.status === 'running', detail: started.status === 'running' ? 'Portal 已运行，等待中继确认。' : started.detail || 'Portal 已部署，尚未启动。' });
        return { status: started.status, detail: this.installation.detail };
      } catch {
        const detail = '已部署的 Portal 未能启动，请检查程序、配置与连接后重试。';
        this._update({ status: 'error', phase: 'failed', detail });
        throw new Error(detail);
      }
    }
    if (context.portalExecutable || context.portalConfig) {
      this._update({ status: 'existing_configuration', phase: 'existing', detail: '已保留现有程序与配置，请在原有连接设置中启动。' });
      return { status: 'existing_configuration', detail: this.installation.detail };
    }
    const workspace = await this.prepareWorkspace({ workspace: context.portalWorkspace, defaultWorkspace: this.defaultWorkspace });
    const configuration = await this.configFactory({ workspace, name: 'being-desktop' });
    this._requireCurrent(context);
    let configPath: string | undefined, configOwned = false, installed: any;
    let saved = false;
    try {
      this._update({ status: 'installing', phase: 'checking', detail: '正在核对官方安装包。', recovery: null });
      installed = await this.installer.install({ onProgress: (progress) => {
        if (!['download', 'hash', 'install', 'not_started'].includes(progress.phase)) return;
        this._update({ status: 'installing', phase: progress.phase, receivedBytes: Number.isFinite(progress.receivedBytes) ? Math.min(this.release.size, Math.max(0, progress.receivedBytes as number)) : 0, totalBytes: this.release.size });
      } });
      this._requireCurrent(context);
      configPath = path.join(path.dirname(installed.executable), `desktop-${this.randomUUID()}.toml`);
      await this.fs.writeFile(configPath, configuration.toml, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      configOwned = true;
      this._requireCurrent(context);
      const deployment = { executable: installed.executable, configPath, version: this.release.version, workspace: configuration.capabilities.workspace };
      await this.saveDeployment(deployment);
      saved = true;
      this._requireCurrent({ ...context, portalWorkspace: deployment.workspace, portalExecutable: deployment.executable, portalConfig: deployment.configPath });
      this._update({ status: 'installed', version: this.release.version, verified: installed.verified === true, executable: installed.executable, phase: 'starting', capabilities: configuration.capabilities, detail: '程序与配置已保存，正在启动 Portal。' });
      const started = await this.startPortal();
      this._update({ status: 'installed', phase: started.status === 'running' ? 'running' : 'not_started', started: started.status === 'running', detail: started.status === 'running' ? 'Portal 已运行，等待中继确认。' : started.detail || 'Portal 已安装，尚未启动。' });
      return { status: started.status, detail: this.installation.detail };
    } catch (error: any) {
      let configuration = saved ? 'saved' : 'not_created';
      if (configOwned && configPath && !saved) {
        try { await this.fs.unlink(configPath); configuration = 'removed'; }
        catch (cleanupError: any) { configuration = cleanupError.code === 'ENOENT' ? 'removed' : 'cleanup_failed'; }
      }
      const detail = DEPLOY_ERRORS.has(error?.message) ? error.message : '部署未能完成，请检查网络、工作区及本机目录后重试。';
      const processStatus = ['running', 'stopped', 'external', 'error'].includes(this.portal.state.status) ? this.portal.state.status : 'unknown';
      this._update({ status: 'error', phase: 'failed', detail, recovery: { program: installed?.verified === true ? 'retained_verified' : 'not_confirmed', configuration, process: processStatus } });
      throw new Error(detail);
    }
  }
}

export function requireTownIdentity(): never { throw new Error('Desktop 暂不支持创建或加入围炉，请通过 Being 完成。'); }
