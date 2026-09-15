// Ported line by line from BeingDesktop 0.8.26 src/town-client-store.cjs on 2026-09-16.
// On-disk format: <directory>/<sha256(key)>.json holding {"version":1,"encrypted":"<base64>"},
// whose plaintext is {key, beingId, token, townId?, display?}. Byte-compatible with 0.8.x.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { TownClientCredential, TownCodedError, TownSecretStorage } from './types';

export interface TownClientStoreOptions {
  directory: string;
  safeStorage: TownSecretStorage;
}

// Client tokens never enter settings, diagnostics, IPC, or renderer storage.
export class TownClientStore {
  directory!: string;
  safeStorage!: TownSecretStorage;
  _tail: Promise<unknown>;

  constructor({directory, safeStorage}: TownClientStoreOptions) { Object.assign(this, {directory, safeStorage}); this._tail = Promise.resolve(); }
  _file(key: string): string { return path.join(this.directory, `${createHash('sha256').update(key).digest('hex')}.json`); }
  _secure(): void {
    if (!this.safeStorage.isEncryptionAvailable() || this.safeStorage.getSelectedStorageBackend?.() === 'basic_text')
      throw Object.assign(new Error('系统安全存储不可用，Town 配对凭据未保存。'), {code: 'AUTH_REQUIRED', reason: 'SECURE_STORAGE_UNAVAILABLE'}) as TownCodedError;
  }
  assertAvailable(): void { this._secure(); }
  async loadCredential(key: string, beingId: string): Promise<TownClientCredential | null> {
    this._secure();
    try {
      const stat = await fs.stat(this._file(key));
      if (!stat.isFile() || stat.size > 8192) return null;
      const raw = await fs.readFile(this._file(key), 'utf8');
      if (raw.length > 8192) return null;
      const data = JSON.parse(this.safeStorage.decryptString(Buffer.from((JSON.parse(raw) as {encrypted: string}).encrypted, 'base64'))) as Record<string, unknown>;
      if (data.key !== key || data.beingId !== beingId || !/^[a-f0-9]{64}$/.test(data.token as string)) return null;
      if (data.townId !== undefined && (typeof data.townId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(data.townId))) throw new Error('Invalid Town binding');
      return {token: data.token as string, townId: (data.townId as string) || '', ...(typeof data.display === 'string' ? {display: data.display.slice(0, 100)} : {})};
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw Object.assign(new Error('Town 凭据无法读取，请重新配对。'), {code: 'AUTH_REQUIRED', reason: 'CREDENTIAL_UNREADABLE'}) as TownCodedError; }
  }
  async load(key: string, beingId: string): Promise<string | null> { return (await this.loadCredential(key, beingId))?.token || null; }
  _mutate<T>(action: () => Promise<T>): Promise<T> { const pending = this._tail.then(action); this._tail = pending.catch(() => {}); return pending; }
  save(key: string, beingId: string, token: string, townId = '', display = '', isCurrent: () => boolean = () => true): Promise<void> { return this._mutate(() => this._save(key, beingId, token, townId, display, isCurrent)); }
  async _save(key: string, beingId: string, token: string, townId = '', display = '', isCurrent: () => boolean = () => true): Promise<void> {
    this._secure();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid client token');
    if (townId && (typeof townId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(townId))) throw new Error('Invalid Town binding');
    await fs.mkdir(this.directory, {recursive: true, mode: 0o700});
    const file = this._file(key), temp = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify({version: 1, encrypted: this.safeStorage.encryptString(JSON.stringify({key, beingId, token, ...(townId ? {townId} : {}), ...(typeof display === 'string' && display ? {display: display.slice(0, 100)} : {})})).toString('base64')}), {mode: 0o600, flag: 'wx'});
      if (!isCurrent()) throw Object.assign(new Error('Being 连接已变化，配对未保存。'), {code: 'SESSION_CHANGED'}) as TownCodedError;
      await fs.rename(temp, file);
    } finally { await fs.rm(temp, {force: true}).catch(() => {}); }
  }
  bindTownId(key: string, beingId: string, token: string, townId: string, isCurrent: () => boolean = () => true): Promise<void> {
    return this._mutate(async () => {
      if (typeof townId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(townId)) throw Object.assign(new Error('Town 身份编号无效。'), {code: 'INVALID_RESPONSE'}) as TownCodedError;
      const saved = await this.loadCredential(key, beingId);
      if (!isCurrent() || !saved || saved.token !== token) throw Object.assign(new Error('Town 配对已变化，身份绑定未保存。'), {code: 'SESSION_CHANGED'}) as TownCodedError;
      if (saved.townId && saved.townId !== townId) throw Object.assign(new Error('Town 返回的身份与已保存配对不一致。'), {code: 'IDENTITY_MISMATCH'}) as TownCodedError;
      if (!saved.townId) await this._save(key, beingId, token, townId, saved.display || '', isCurrent);
    });
  }
  remove(key: string): Promise<void> { return this._mutate(() => fs.rm(this._file(key), {force: true})); }
}
