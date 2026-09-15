// Ported line by line from BeingDesktop 0.8.26 src/bonfire-cache.cjs on 2026-09-16.
// On-disk format (docs/interfaces.md section 7, bonfire-cache/): one AES file per identity named
// sha256(identityKey).bin, whose plaintext is {"version":1,"identityKey":…,"snapshot":…}. The
// reader must stay byte-compatible with what 0.8.x wrote.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { BonfireCachedMessage, BonfireCachedSnapshot, SecretStorage } from './types';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const sequence = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const validKey = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);

const OPTIONAL_TEXT: readonly (readonly [keyof BonfireCachedMessage, number])[] = [['beingId', 100], ['beingName', 100], ['createdAt', 64], ['revisedAt', 64], ['via', 120]];

export function snapshot(value: unknown): BonfireCachedSnapshot | null {
  if (!plain(value) || !Array.isArray(value.messages) || value.messages.length > 500 || !sequence(value.latestSeq)
    || !sequence(value.capturedAt) || value.capturedAt > 8640000000000000 || typeof value.manual !== 'boolean'
    || typeof value.revision !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(value.revision)) return null;
  const latestSeq = value.latestSeq as number;
  const messages: BonfireCachedMessage[] = [];
  for (const entry of value.messages as unknown[]) {
    if (!plain(entry) || typeof entry.content !== 'string' || entry.content.length > 32000) return null;
    const id = typeof entry.id === 'string' && /^(0|[1-9]\d*)$/.test(entry.id) ? Number(entry.id) : entry.id;
    if (!sequence(id) || id > latestSeq) return null;
    const message: BonfireCachedMessage = {id: String(id), content: entry.content};
    for (const [field, limit] of OPTIONAL_TEXT) {
      const item = entry[field];
      if (item !== undefined && (typeof item !== 'string' || item.length > limit)) return null;
      if (item !== undefined) (message as unknown as Record<string, unknown>)[field] = item;
    }
    if (entry.mentions !== undefined) {
      if (!Array.isArray(entry.mentions) || entry.mentions.length > 20 || (entry.mentions as unknown[]).some(item => typeof item !== 'string' || item.length > 100)) return null;
      message.mentions = [...(entry.mentions as string[])];
    }
    if (entry.replyTo !== undefined) {
      const parent = entry.replyTo;
      if (!plain(parent) || typeof parent.id !== 'string' || !parent.id || parent.id.length > 200 || typeof parent.beingId !== 'string' || parent.beingId.length > 100 || typeof parent.preview !== 'string' || parent.preview.length > 200) return null;
      message.replyTo = {id: parent.id, beingId: parent.beingId, preview: parent.preview};
    }
    messages.push(message);
  }
  return {messages, latestSeq, capturedAt: value.capturedAt as number, revision: value.revision, manual: value.manual, ...(value.source === 'being_relay' ? {source: 'being_relay' as const} : {})};
}

export interface BonfireCacheOptions {
  directory?: string;
  safeStorage?: SecretStorage;
}

// This store contains only validated message snapshots. Connection revisions
// belong to the running session and are rebound by the refresh coordinator.
export class BonfireCache {
  directory: string;
  safeStorage: SecretStorage | undefined;
  _writes: Map<string, Promise<boolean>>;
  _failed: Set<string>;

  constructor({directory, safeStorage}: BonfireCacheOptions = {}) {
    if (typeof directory !== 'string' || !directory) throw new TypeError('Invalid Bonfire cache directory');
    this.directory = path.resolve(directory);
    this.safeStorage = safeStorage;
    this._writes = new Map();
    this._failed = new Set();
  }

  _available(): boolean {
    try {
      return this.safeStorage?.isEncryptionAvailable() === true
        && typeof this.safeStorage.encryptString === 'function' && typeof this.safeStorage.decryptString === 'function';
    } catch { return false; }
  }

  _file(identityKey: string): string { return path.join(this.directory, `${createHash('sha256').update(identityKey).digest('hex')}.bin`); }

  async load(identityKey: string): Promise<BonfireCachedSnapshot | null> {
    if (!validKey(identityKey) || !this._available()) return null;
    try {
      await this._writes.get(identityKey);
      const file = this._file(identityKey);
      const stat = await fs.stat(file);
      if (!stat.isFile() || !stat.size || stat.size > MAX_FILE_BYTES) return null;
      const ciphertext = await fs.readFile(file);
      if (!ciphertext.length || ciphertext.length > MAX_FILE_BYTES) return null;
      const decoded = (this.safeStorage as SecretStorage).decryptString(ciphertext);
      if (typeof decoded !== 'string' || Buffer.byteLength(decoded, 'utf8') > MAX_FILE_BYTES) return null;
      const payload = JSON.parse(decoded) as unknown;
      if (!plain(payload) || payload.version !== 1 || payload.identityKey !== identityKey) return null;
      return snapshot(payload.snapshot);
    } catch { return null; }
  }

  async save(identityKey: string, value: unknown): Promise<boolean> {
    if (!validKey(identityKey)) return false;
    let payload: string;
    try {
      const next = snapshot(value);
      if (!next) return false;
      payload = JSON.stringify({version: 1, identityKey, snapshot: next});
      if (Buffer.byteLength(payload, 'utf8') > MAX_FILE_BYTES) return false;
    } catch { return false; }
    const previous = this._writes.get(identityKey) || Promise.resolve(true);
    const pending: Promise<boolean> = previous.then(() => this._write(identityKey, payload)).finally(() => {
      if (this._writes.get(identityKey) === pending) this._writes.delete(identityKey);
    });
    this._writes.set(identityKey, pending);
    return pending;
  }

  async _write(identityKey: string, payload: string): Promise<boolean> {
    let temporary: string | null = null;
    try {
      if (!this._available()) throw new Error('Bonfire cache encryption unavailable');
      const ciphertext = (this.safeStorage as SecretStorage).encryptString(payload);
      if (!Buffer.isBuffer(ciphertext) || !ciphertext.length || ciphertext.length > MAX_FILE_BYTES) throw new Error('Invalid encrypted Bonfire cache');
      await fs.mkdir(this.directory, {recursive: true});
      const file = this._file(identityKey);
      temporary = `${file}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, ciphertext, {flag: 'wx', mode: 0o600});
      await fs.rename(temporary, file);
      temporary = null;
      this._failed.delete(identityKey);
      return true;
    } catch {
      this._failed.add(identityKey);
      return false;
    } finally {
      if (temporary) { try { await fs.unlink(temporary); } catch { /* Keep the previous cache after a failed write. */ } }
    }
  }

  async flush(): Promise<boolean> {
    while (this._writes.size) await Promise.all(this._writes.values());
    return this._failed.size === 0;
  }
}
