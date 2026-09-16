// Ported line for line from BeingDesktop 0.8.26 src/chat-cache.cjs (101 lines);
// 2026-09-16. On-disk format: BeingDesktop docs/interfaces.md §7
// 「`chat-cache/<file per identity>`」— safeStorage ciphertext over
// `{version:1, identityKey, state}`, one file per Being identity. A 0.8.x profile
// must open here unchanged, and a file written here must stay readable by 0.8.x.
//
// Encrypted single-file store for one Being's conversation transcripts, in the BonfireCache shape.
// Validation belongs to ChatStore's snapshot: this file only guards the envelope and the disk.
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { snapshot } from './store';
import type { ChatSnapshot } from './store-types';
import type { SecretStorage } from '../app/settings';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const validKey = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);

export class ChatCache {
  readonly directory: string;
  readonly safeStorage?: SecretStorage;
  private _writes = new Map<string, Promise<boolean>>();
  private _failed = new Set<string>();

  constructor({ directory, safeStorage }: { directory?: string; safeStorage?: SecretStorage } = {}) {
    if (typeof directory !== 'string' || !directory) throw new TypeError('Invalid chat cache directory');
    this.directory = path.resolve(directory);
    this.safeStorage = safeStorage;
  }

  private _available(): boolean {
    try {
      return this.safeStorage?.isEncryptionAvailable() === true
        && typeof this.safeStorage.encryptString === 'function' && typeof this.safeStorage.decryptString === 'function';
    } catch { return false; }
  }

  private _file(identityKey: string): string {
    return path.join(this.directory, `${createHash('sha256').update(identityKey).digest('hex')}.bin`);
  }

  async load(identityKey: string): Promise<ChatSnapshot | null> {
    if (!validKey(identityKey) || !this._available()) return null;
    try {
      await this._writes.get(identityKey);
      const file = this._file(identityKey);
      const info = await stat(file);
      if (!info.isFile() || !info.size || info.size > MAX_FILE_BYTES) return null;
      const ciphertext = await readFile(file);
      if (!ciphertext.length || ciphertext.length > MAX_FILE_BYTES) return null;
      const decoded = this.safeStorage!.decryptString(ciphertext);
      if (typeof decoded !== 'string' || Buffer.byteLength(decoded, 'utf8') > MAX_FILE_BYTES) return null;
      const payload: unknown = JSON.parse(decoded);
      if (!plain(payload) || payload.version !== 1 || payload.identityKey !== identityKey) return null;
      return snapshot(payload.state);
    } catch { return null; }
  }

  async save(identityKey: string, value: ChatSnapshot): Promise<boolean> {
    if (!validKey(identityKey)) return false;
    let payload: string;
    try {
      const next = snapshot(value);
      if (!next) return false;
      payload = JSON.stringify({ version: 1, identityKey, state: next });
      if (Buffer.byteLength(payload, 'utf8') > MAX_FILE_BYTES) return false;
    } catch { return false; }
    const previous = this._writes.get(identityKey) || Promise.resolve(true);
    const pending: Promise<boolean> = previous.then(() => this._write(identityKey, payload)).finally(() => {
      if (this._writes.get(identityKey) === pending) this._writes.delete(identityKey);
    });
    this._writes.set(identityKey, pending);
    return pending;
  }

  private async _write(identityKey: string, payload: string): Promise<boolean> {
    let temporary: string | null = null;
    try {
      if (!this._available()) throw new Error('Chat cache encryption unavailable');
      const ciphertext = this.safeStorage!.encryptString(payload);
      if (!Buffer.isBuffer(ciphertext) || !ciphertext.length || ciphertext.length > MAX_FILE_BYTES) throw new Error('Invalid encrypted chat cache');
      await mkdir(this.directory, { recursive: true });
      const file = this._file(identityKey);
      temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, ciphertext, { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
      temporary = null;
      this._failed.delete(identityKey);
      return true;
    } catch {
      this._failed.add(identityKey);
      return false;
    } finally {
      if (temporary) { try { await unlink(temporary); } catch { /* Keep the previous cache after a failed write. */ } }
    }
  }

  async remove(identityKey: string): Promise<boolean> {
    if (!validKey(identityKey)) return false;
    try { await unlink(this._file(identityKey)); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
  }

  async flush(): Promise<boolean> {
    while (this._writes.size) await Promise.all(this._writes.values());
    return this._failed.size === 0;
  }
}
