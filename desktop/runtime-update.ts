import { createHash, randomUUID } from 'node:crypto';
import { access, chmod, copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { BackgroundPortal, atomic, fingerprint, unixRunner, windowsRunner, type Service } from './background';
import type { Connection } from './connection';
import type { Settings } from './shared';
import { readPortalSample, readPortalReady } from './portal-status';
import { ExternalPortalObserver } from './external-portal';

export interface RuntimeBundle { schema: 1; id: string; clientVersion: string; portalVersion: string; sha256: string; platform: string; arch: string }
interface Journal { schema: 1; previous: Service; candidate: Service; enabled: boolean; previousPlist?: string; external?: Service[] }
export interface RuntimeUpdateResult { phase: 'current' | 'updated' | 'skipped' | 'error'; message: string; portalVersion?: string }
export const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export function compareVersions(left: string, right: string) {
  const parse = (value: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value);
    if (!match) throw new Error('无效的稳定版版本号。');
    return match.slice(1).map(Number);
  };
  const a = parse(left), b = parse(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
export async function loadRuntimeBundle(resources: string): Promise<{ bundle: RuntimeBundle; binary: string }> {
  const bundle = JSON.parse(await readFile(path.join(resources, 'runtime-bundle.json'), 'utf8')) as RuntimeBundle;
  if (bundle.schema !== 1 || bundle.platform !== process.platform || bundle.arch !== process.arch ||
      !/^[a-f0-9]{64}$/.test(bundle.sha256) || !/^[a-f0-9]{64}$/.test(bundle.id)) throw new Error('安装包中的 Portal 版本清单无效。');
  compareVersions(bundle.portalVersion, bundle.portalVersion);
  const binary = path.join(resources, process.platform === 'win32' ? 'heart-portal.exe' : 'heart-portal');
  if (digest(await readFile(binary)) !== bundle.sha256) throw new Error('安装包内 Portal 校验失败，旧服务未修改。');
  return { bundle, binary };
}

// An upgrade may use the OS supervisor to check the candidate, but it must not
// turn a foreground-only client's disabled login service into a permanent one.
export async function restoreRuntimeMode(background: BackgroundPortal, settings: Settings,
  startForeground: () => Promise<unknown>, start: boolean) {
  if (!settings.backgroundEnabled) {
    await background.disable();
    if (start || settings.autoStart) await startForeground();
  } else if (start && !background.state.enabled) {
    await background.load(background.installedService!);
  }
}

// Only invoked under the main process mutation queue and Electron's profile lock.
// Journal precedes any stop; recovery always restores the old registration first.
export class RuntimeUpdater {
  private journal: string;
  constructor(private directory: string, private background: BackgroundPortal,
    private platform = process.platform,
    private ready: (service: Service) => Promise<void> = service => this.waitReady(service),
    private discoverExternal = (connection: Connection, exclude?: string) => new ExternalPortalObserver(undefined, platform).forUpgrade(connection, background.label, exclude),
  ) { this.journal = path.join(directory, 'runtime-update.json'); }

  async recover() {
    let transaction: Journal;
    try { transaction = JSON.parse(await readFile(this.journal, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    if (transaction.schema !== 1 || !transaction.previous || !transaction.candidate) throw new Error('升级恢复记录损坏，请保留运行目录并检查日志。');
    const staging = this.background.runtimeDirectory;
    if (path.dirname(transaction.candidate.root) !== staging || transaction.candidate.root === transaction.previous.root ||
        transaction.candidate.existing || transaction.candidate.kind || !path.isAbsolute(transaction.previous.root) ||
        transaction.candidate.label !== transaction.previous.label ||
        (transaction.candidate.file !== transaction.previous.file && transaction.candidate.file !== path.join(transaction.candidate.root, 'launch.plist'))) {
      throw new Error('升级恢复记录路径无效，未修改服务。');
    }
    if (transaction.external?.some(s => s.kind !== 'portable' || !s.binary || !path.isAbsolute(s.root) || !path.isAbsolute(s.binary))) throw new Error('独立 Portal 恢复记录无效。');
    await this.restore(transaction);
    return true;
  }
  private async restore(t: Journal) {
    // Never start the old engine until the candidate's entire service is stopped.
    await this.background.unload(t.candidate);
    if (t.previous.kind === 'portable') {
      if (this.platform === 'darwin') await rm(t.candidate.file, { force: true });
    } else if (this.platform === 'darwin') {
      if (t.previousPlist === undefined) throw new Error('旧服务登记备份缺失。');
      await atomic(t.previous.file, t.previousPlist);
      if (t.candidate.file !== t.previous.file) await rm(t.candidate.file, { force: true });
    } else await this.background.installRegistration(t.previous);
    for (const service of t.external || []) await this.background.load(service);
    if (t.enabled) await this.background.load(t.previous);
    await this.background.setService(t.previous);
    await rm(this.journal);
    // Keep files until recovery is committed; never delete the original config.
    await rm(t.candidate.root, { recursive: true, force: true });
  }
  async sync(binary: string, bundle: RuntimeBundle, settings: Settings, connection: Connection): Promise<RuntimeUpdateResult> {
    const installed = this.background.installedService;
    const external = await this.discoverExternal(connection, installed?.kind === 'portable' ? undefined : installed?.root);
    const previous = installed?.kind === 'portable' ? external.find(s => s.root === installed.root) || installed : installed || external[0];
    if (!previous) return { phase: 'skipped', message: '尚未安装客户端管理的后台服务。' };
    if (digest(await readFile(binary)) !== bundle.sha256) throw new Error('Portal 文件校验失败，旧服务未修改。');
    const primary = external[0] || previous;
    const additional = external.filter(s => s.root !== previous.root);
    // A client release owns one tested engine/runner pair. Preserve the user's
    // configuration, but always activate the binary covered by this manifest.
    if (!additional.length && previous.kind !== 'portable' && previous.bundleId === bundle.id && digest(await readFile(path.join(previous.root, this.platform === 'win32' ? 'heart-portal.exe' : 'heart-portal'))) === bundle.sha256) return { phase: 'current', message: '客户端、Portal 与守护程序已同步。', portalVersion: bundle.portalVersion };
    const config = primary.configPath || settings.portalConfigPath || path.join(primary.root, 'portal.toml');
    await access(config);
    const wasEnabled = previous.kind === 'portable' || (await this.background.refresh()).enabled;
    const root = path.join(this.background.runtimeDirectory, randomUUID());
    const candidate: Service = { label: previous.label, file: previous.kind === 'portable' ? path.join(root, 'launch.plist') : previous.file, root, existing: false, login: previous.login,
      name: primary.name || settings.portalName, environment: primary.environment, bundleId: bundle.id, configPath: config, cwd: primary.cwd || (primary.existing ? primary.root : settings.workspace),
      fingerprint: fingerprint({ ...settings, portalBinary: path.join(root, this.platform === 'win32' ? 'heart-portal.exe' : 'heart-portal'), portalConfigPath: config, workspace: primary.cwd || settings.workspace, portalEnvironmentPath: primary.environment?.PATH || settings.portalEnvironmentPath, portalName: primary.name || settings.portalName }, connection) };
    await mkdir(root, { recursive: true, mode: 0o700 });
    try {
      const target = path.join(root, this.platform === 'win32' ? 'heart-portal.exe' : 'heart-portal');
      await copyFile(binary, target); await chmod(target, 0o700);
      if (digest(await readFile(target)) !== bundle.sha256) throw new Error('暂存 Portal 校验失败。');
      // Preserve stored credentials exactly for already-owned services.
      if (!primary.existing) await copyFile(path.join(primary.root, this.platform === 'win32' ? 'connection.dpapi' : 'connection.url'), path.join(root, this.platform === 'win32' ? 'connection.dpapi' : 'connection.url'));
      else if (this.platform === 'darwin') {
        await copyFile(path.join(primary.root, '.portal-connection.url'), path.join(root, 'connection.url')).catch(() => this.background.protectCredential(root, connection));
        await chmod(path.join(root, 'connection.url'), 0o600);
      } else await this.background.protectCredential(root, connection);
      const launchSettings = { ...settings, workspace: candidate.cwd!, portalEnvironmentPath: primary.environment?.PATH || settings.portalEnvironmentPath, portalName: candidate.name! };
      await atomic(path.join(root, this.platform === 'win32' ? 'run.ps1' : 'run.sh'), this.platform === 'win32'
        ? '\ufeff' + windowsRunner(root, config, launchSettings, primary.environment) : unixRunner(root, config, launchSettings, primary.environment));
      await atomic(path.join(root, 'runtime-bundle.json'), JSON.stringify(bundle));
      const transaction: Journal = { schema: 1, previous, candidate, enabled: wasEnabled, external: additional,
        ...(this.platform === 'darwin' && previous.kind !== 'portable' ? { previousPlist: await readFile(previous.file, 'utf8') } : {}) };
      await atomic(this.journal, JSON.stringify(transaction));
    } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
    try {
      await this.background.unload(previous);
      for (const service of additional) await this.background.unload(service);
      await this.background.installRegistration(candidate);
      await this.background.load(candidate);
      await this.background.setService(candidate);
      await this.ready(candidate);
      await rm(this.journal);
      return { phase: 'updated', message: '旧 Portal 和守护已停止，已按原配置启动当前引擎与新守护。', portalVersion: bundle.portalVersion };
    } catch (error) {
      try { await this.recover(); }
      catch (recovery) { throw new Error(`升级失败且恢复未完成；下次启动将重试恢复。${String(recovery)}`); }
      throw new Error(`Portal 更新失败，已恢复旧服务：${String(error)}`);
    }
  }
  async waitReady(service: Service) {
    const deadline = Date.now() + 25_000;
    let identity = '', since = 0;
    while (Date.now() < deadline) {
      const state = await this.background.refresh();
      const nonce = await readFile(path.join(service.root, '.portal-status-nonce'), 'utf8').catch(() => '');
      const sample = state.running && state.pid ? await readPortalSample(path.join(service.root, '.portal-connection-status.json'), state.pid, nonce.trim()) : null;
      // Cloud availability is not an installation health test.
      if (service.legacyProcessHealth && state.running && state.pid) {
        // OS-owned engine PID must stay alive across the supervisor's restart
        // interval. This proves local startup only, never relay connectivity.
        const current = String(state.pid);
        if (identity !== current) { identity = current; since = Date.now(); }
        if (Date.now() - since >= 6000) return;
      } else if (state.running && state.pid &&
          (!sample || !['starting', 'invalid'].includes(sample.state)) &&
          (sample && !sample.native || await readPortalReady(path.join(service.root, '.portal-ready.json'), state.pid, nonce.trim()))) {
        const current = `${state.pid}:${sample?.boot_id || nonce.trim()}`;
        if (identity !== current) { identity = current; since = Date.now(); }
        if (Date.now() - since >= 2000) return;
      } else { identity = ''; since = 0; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('新 Portal 未通过本地启动检查。');
  }
}
