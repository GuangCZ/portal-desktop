import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseConnection, type Connection } from './connection';
import type { Settings, SaveSettings } from './shared';

export interface SecretStorage { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }
interface Stored { version: 1; settings: Omit<Settings, 'hasToken'>; credential: string }
export class SettingsStore {
  connection: Connection | null = null;
  settings: Settings;
  constructor(private directory: string, private storage: SecretStorage, binary: string) {
    this.settings = { endpoint: '', being: '', hasToken: false, workspace: path.join(os.homedir(), 'portal-desktop Workspace'),
      portalBinary: binary, portalName: `portal-desktop-${os.hostname().replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 50)}`,
      autoStart: false, backgroundEnabled: true, allowExec: true, kitsEnabled: true };
  }
  async load() {
    let raw: string;
    try { raw = await readFile(path.join(this.directory, 'connection.json'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const saved = JSON.parse(raw) as Stored;
    if (saved.version !== 1) throw new Error('不支持的客户端配置版本。');
    const secrets = JSON.parse(this.storage.decryptString(Buffer.from(saved.credential, 'base64')));
    const connection = parseConnection(secrets.link);
    connection.relaySecret = secrets.relaySecret || connection.token;
    this.connection = connection;
    this.settings = { ...this.settings, ...saved.settings, endpoint: connection.endpoint, being: connection.being, hasToken: true };
  }
  async save(input: SaveSettings) {
    if (!input || typeof input !== 'object') throw new Error('无效的设置。');
    const connection = this.resolveConnection(input);
    if (!this.storage.isEncryptionAvailable()) throw new Error('系统密钥库不可用，无法安全保存连接。请启用系统密钥库后重试。');
    if (typeof input.workspace !== 'string' || !path.isAbsolute(input.workspace)) throw new Error('请选择绝对路径的工作目录。');
    if (typeof input.portalBinary !== 'string' || !path.isAbsolute(input.portalBinary)) throw new Error('请选择 Portal 可执行文件。');
    if (typeof input.portalName !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.portalName)) throw new Error('Portal 名称仅支持 1–80 个字母、数字、横线和下划线。');
    for (const key of ['autoStart', 'allowExec', 'kitsEnabled'] as const) if (typeof input[key] !== 'boolean') throw new Error('无效的开关设置。');
    if (input.backgroundEnabled !== undefined && typeof input.backgroundEnabled !== 'boolean') throw new Error('无效的后台运行设置。');
    if (input.portalConfigPath && (!path.isAbsolute(input.portalConfigPath) || !(await stat(input.portalConfigPath)).isFile())) throw new Error('现有 Portal 配置文件不存在。');
    if (input.portalEnvironmentPath !== undefined && (typeof input.portalEnvironmentPath !== 'string' || input.portalEnvironmentPath.includes('\0'))) throw new Error('无效的 Portal PATH。');
    await mkdir(input.workspace, { recursive: true });
    if (!(await stat(input.workspace)).isDirectory()) throw new Error('工作路径不是目录。');
    const next: Settings = { endpoint: connection.endpoint, being: connection.being, hasToken: true,
      workspace: input.workspace, portalBinary: input.portalBinary, portalName: input.portalName,
      autoStart: input.autoStart, allowExec: input.allowExec, kitsEnabled: input.kitsEnabled,
      backgroundEnabled: input.backgroundEnabled ?? this.settings.backgroundEnabled,
      portalConfigPath: input.portalConfigPath || undefined, portalEnvironmentPath: input.portalEnvironmentPath || undefined };
    const { hasToken: _, ...publicSettings } = next;
    const credential = this.storage.encryptString(JSON.stringify({ link: connection.link, relaySecret: connection.relaySecret })).toString('base64');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.directory, 'connection.json.tmp');
    await writeFile(temporary, JSON.stringify({ version: 1, settings: publicSettings, credential }), { mode: 0o600 });
    await rename(temporary, path.join(this.directory, 'connection.json'));
    this.connection = connection;
    this.settings = next;
  }
  resolveConnection(input: Pick<SaveSettings, 'connectionLink'>): Connection {
    const connection = input.connectionLink?.trim() ? parseConnection(input.connectionLink) : this.connection;
    if (!connection) throw new Error('请先输入 Being 链接。');
    return { ...connection };
  }
}
