// Ported from BeingDesktop 0.8.26 src/main.cjs (`disk` defaults at line 148,
// `settingsPath()` / `persist()` / `restore()` / `storeConnection()` at lines
// 624-716) and BeingDesktop docs/interfaces.md §7「持久化格式」; 2026-09-16.
// settings.json is BeingDesktop's own flat plaintext file in the profile
// directory. This client reads and writes it in place so a 0.8.x profile opens
// without a migration step, and so a 0.8.x build can still open what this client
// wrote: every key it does not own is preserved verbatim, and the credential
// ciphertext is rewritten only when the user saves a different address.
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { parse } from 'smol-toml';
import { connectionCredential, parseConnection, type Connection } from '../chat/connection';
import type { Settings, SaveSettings } from '../../shared/types';

export interface SecretStorage { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }
type Disk = Record<string, unknown>;
/** Settings this client owns that BeingDesktop 0.8.x has no field for. They are
 * written as top-level keys under their own names: 0.8.x carries unknown keys
 * through its own `disk` spread untouched, and none of these collide with it. */
const CLIENT_FLAGS = ['autoStart', 'backgroundEnabled', 'allowExec', 'kitsEnabled'] as const;
const CLIENT_PATHS = ['portalConfigPath', 'portalEnvironmentPath'] as const;
const isRecord = (value: unknown): value is Disk => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string => typeof value === 'string' ? value : '';
/** The address to encrypt for a connection that reached this client as parts
 * rather than as a saved address (an imported client profile, a reused
 * portal.toml). BeingDesktop stores the address, not the parsed fields. */
const addressOf = (connection: Connection) => connection.relaySecret && connection.relaySecret !== connection.token
  ? `${connection.link}&relay_secret=${encodeURIComponent(connection.relaySecret)}` : connection.link;
const sameConnection = (a: Connection, b: Connection) =>
  a.endpoint === b.endpoint && a.being === b.being && a.token === b.token && a.relaySecret === b.relaySecret;

export class SettingsStore {
  connection: Connection | null = null;
  settings: Settings;
  private disk: Disk = {};
  /** The credential exactly as it sits on disk, together with the address it
   * decrypts to. An unchanged address is written back as the same ciphertext so
   * a 0.8.x build keeps reading the file it wrote. */
  private credential = '';
  private address = '';
  constructor(private directory: string, private storage: SecretStorage, private binary: string) {
    this.settings = { endpoint: '', being: '', hasToken: false, workspace: path.join(os.homedir(), 'Being Desktop Workspace'),
      portalBinary: binary, portalName: `being-desktop-${os.hostname().replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 50)}`,
      autoStart: false, backgroundEnabled: true, allowExec: true, kitsEnabled: true };
  }
  private get file() { return path.join(this.directory, 'settings.json'); }
  /** The saved connection address, exactly as it decrypts from disk. It carries
   * the parameters `Connection` does not model (`api=`, `relay_secret=`), so a
   * rollback must restore this rather than reassemble a link from its parts. */
  get connectionAddress() { return this.address; }
  async load() {
    let raw: string;
    try { raw = await readFile(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return await this.importClientProfile();
    }
    const saved: unknown = JSON.parse(raw);
    if (!isRecord(saved)) throw new Error('不支持的客户端配置版本。');
    this.disk = saved;
    // Read the plaintext settings before unlocking the credential: a locked
    // keychain must not cost the user the rest of a profile on the next save.
    const portalWorkspace = portalWorkspaceOf(saved);
    this.settings = { ...this.settings, ...clientSettingsOf(saved), portalBinary: this.binary,
      ...(portalWorkspace ? { workspace: portalWorkspace } : {}),
      ...(text(saved.workspace) ? { projectWorkspace: text(saved.workspace) } : {}) };
    await this.validatePortalConfig();
    if (!text(saved.credential)) return;
    const address = this.storage.decryptString(Buffer.from(text(saved.credential), 'base64'));
    this.connection = parseConnection(address);
    this.credential = text(saved.credential);
    this.address = address;
    this.settings = { ...this.settings, endpoint: this.connection.endpoint, being: this.connection.being, hasToken: true };
  }
  /** A profile written by this client before it adopted BeingDesktop's format.
   * Read once and republished as settings.json; connection.json is left alone
   * so an older build of this client can still open the same profile. */
  private async importClientProfile() {
    let raw: string;
    try { raw = await readFile(path.join(this.directory, 'connection.json'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const saved = JSON.parse(raw) as { version: number; settings: Omit<Settings, 'hasToken'>; credential?: string };
    if (saved.version !== 1) throw new Error('不支持的客户端配置版本。');
    if (saved.credential) {
      const secrets = JSON.parse(this.storage.decryptString(Buffer.from(saved.credential, 'base64')));
      const connection = parseConnection(secrets.link);
      connection.relaySecret = secrets.relaySecret || connection.token;
      this.connection = connection;
    }
    this.settings = { ...this.settings, ...saved.settings, portalBinary: this.binary,
      ...(this.connection ? { endpoint: this.connection.endpoint, being: this.connection.being, hasToken: true } : {}) };
    await this.validatePortalConfig();
    await this.publish(this.settings, this.connection ? addressOf(this.connection) : '');
  }
  // A path persisted by an older client is only a hint. If it was removed or
  // is no longer valid TOML, fall back to the configuration generated from
  // the current client settings instead of failing Portal startup.
  private async validatePortalConfig() {
    if (!this.settings.portalConfigPath) return;
    try {
      const source = await readFile(this.settings.portalConfigPath, 'utf8');
      parse(source.replace(/^\uFEFF/, ''));
    } catch {
      this.settings.portalConfigPath = undefined;
    }
  }
  async reusePortalConfig(candidates: string[]) {
    if (this.settings.portalConfigPath) return;
    for (const file of candidates) {
      let raw: string;
      try { raw = await readFile(file, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const config = parse(raw.replace(/^\uFEFF/, ''));
      const security = config.security as Record<string, unknown> | undefined;
      const tools = config.tools as Record<string, unknown> | undefined;
      const workspace = config.workspace ?? security?.workspace_root;
      const expand = (value: string) => value === '~' ? os.homedir() : /^[~][\\/]/.test(value) ? path.join(os.homedir(), value.slice(2)) : value;
      const connection = !this.connection && typeof config.connect === 'string' && config.connect.trim() ? parseConnection(config.connect) : null;
      this.settings = { ...this.settings, portalConfigPath: file,
        ...(!this.settings.hasToken && typeof config.name === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(config.name) ? { portalName: config.name } : {}),
        ...(typeof workspace === 'string' && workspace ? { workspace: path.resolve(path.dirname(file), expand(workspace)) } : {}),
        ...(typeof tools?.exec === 'boolean' ? { allowExec: tools.exec } : {}),
        ...(typeof config.kits_enabled === 'boolean' ? { kitsEnabled: config.kits_enabled } : {}),
        ...(connection ? { endpoint: connection.endpoint, being: connection.being, hasToken: true } : {}) };
      if (connection) this.connection = connection;
      return;
    }
  }
  async save(input: SaveSettings) {
    if (!input || typeof input !== 'object') throw new Error('无效的设置。');
    const connection = this.resolveConnection(input);
    if (!this.storage.isEncryptionAvailable()) throw new Error('系统密钥库不可用，无法安全保存连接。请启用系统密钥库后重试。');
    if (typeof input.workspace !== 'string' || !path.isAbsolute(input.workspace)) throw new Error('请选择绝对路径的工作目录。');
    if (typeof input.portalName !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.portalName)) throw new Error('Portal 名称仅支持 1–80 个字母、数字、横线和下划线。');
    for (const key of ['autoStart', 'allowExec', 'kitsEnabled'] as const) if (typeof input[key] !== 'boolean') throw new Error('无效的开关设置。');
    if (input.backgroundEnabled !== undefined && typeof input.backgroundEnabled !== 'boolean') throw new Error('无效的后台运行设置。');
    if (input.portalConfigPath && (!path.isAbsolute(input.portalConfigPath) || !(await stat(input.portalConfigPath)).isFile())) throw new Error('现有 Portal 配置文件不存在。');
    if (input.portalEnvironmentPath !== undefined && (typeof input.portalEnvironmentPath !== 'string' || input.portalEnvironmentPath.includes('\0'))) throw new Error('无效的 Portal PATH。');
    await mkdir(input.workspace, { recursive: true });
    if (!(await stat(input.workspace)).isDirectory()) throw new Error('工作路径不是目录。');
    const next: Settings = { endpoint: connection.endpoint, being: connection.being, hasToken: true,
      workspace: input.workspace, portalBinary: this.binary, portalName: input.portalName,
      autoStart: input.autoStart, allowExec: input.allowExec, kitsEnabled: input.kitsEnabled,
      backgroundEnabled: input.backgroundEnabled ?? this.settings.backgroundEnabled,
      projectWorkspace: this.settings.projectWorkspace,
      portalConfigPath: input.portalConfigPath || undefined, portalEnvironmentPath: input.portalEnvironmentPath || undefined };
    await this.publish(next, this.addressFor(input, connection));
    this.connection = connection;
    this.settings = next;
  }
  /** Keep the stored address whenever the connection did not actually change,
   * including the parameters this client does not model (`api=`) and a rollback
   * that reassembles the link from its parts. Only a genuinely different
   * connection is re-encrypted, as a new address string. */
  private addressFor(input: SaveSettings, connection: Connection) {
    if (this.address && sameConnection(parseConnection(this.address), connection)) return this.address;
    return input.connectionLink?.trim() ? connectionCredential(input.connectionLink) : addressOf(connection);
  }
  private async publish(settings: Settings, address: string) {
    // Re-encrypting an unchanged address would churn the ciphertext for nothing.
    const credential = address && (address !== this.address || !this.credential)
      ? this.storage.encryptString(address).toString('base64') : this.credential;
    await this.write(this.merge(settings, credential));
    this.address = address;
  }
  /** Keep every BeingDesktop key this client does not own, including the ones it
   * only reads (managedPortal, adoptedPortal, workspace) and the ones it never
   * touches (typography, colors, chatBackground, glassStrength, onboarding,
   * sidebar, orchestration, desktopAutoUpdate, chatMode, portalExecutable,
   * portalConfig, portalUpdateNotifiedVersion …). */
  private merge(settings: Settings, credential: string): Disk {
    const disk: Disk = { ...this.disk };
    if (credential) disk.credential = credential;
    disk.portalWorkspace = settings.workspace;
    // BeingDesktop writes portalWorkspace and managedPortal from one deployment
    // (src/main.cjs line 338) and reads managedPortal first, so the workspace
    // this client just saved has to appear in both or the next load loses it.
    if (isRecord(disk.managedPortal)) disk.managedPortal = { ...disk.managedPortal, workspace: settings.workspace };
    disk.portalName = settings.portalName;
    for (const key of CLIENT_FLAGS) disk[key] = settings[key];
    for (const key of CLIENT_PATHS) {
      if (settings[key]) disk[key] = settings[key];
      else delete disk[key];
    }
    return disk;
  }
  private async write(disk: Disk) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(disk, null, 2), { mode: 0o600 });
    await rename(temporary, this.file);
    this.disk = disk;
    this.credential = text(disk.credential);
  }
  resolveConnection(input: Pick<SaveSettings, 'connectionLink'>): Connection {
    const connection = input.connectionLink?.trim() ? parseConnection(input.connectionLink) : this.connection;
    if (!connection) throw new Error('请先输入 Being 链接。');
    return { ...connection };
  }
}

function clientSettingsOf(disk: Disk): Partial<Settings> {
  const settings: Partial<Settings> = {};
  if (/^[a-zA-Z0-9_-]{1,80}$/.test(text(disk.portalName))) settings.portalName = text(disk.portalName);
  for (const key of CLIENT_FLAGS) if (typeof disk[key] === 'boolean') settings[key] = disk[key];
  for (const key of CLIENT_PATHS) if (text(disk[key])) settings[key] = text(disk[key]);
  return settings;
}
/** Settings.workspace is the Portal working directory in this client.
 * BeingDesktop keeps that in managedPortal.workspace, falling back to
 * portalWorkspace; its own top-level `workspace` is the Desktop project
 * directory and is carried here as Settings.projectWorkspace. */
function portalWorkspaceOf(disk: Disk): string {
  const managed = disk.managedPortal;
  if (isRecord(managed) && text(managed.workspace)) return text(managed.workspace);
  return text(disk.portalWorkspace);
}
