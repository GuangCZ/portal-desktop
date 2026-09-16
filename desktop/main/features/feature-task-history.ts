// Ported line by line from BeingDesktop 0.8.26 src/feature-task-history.cjs on 2026-09-16.
// Persistence follows the measured records in BeingDesktop docs/architecture.md §6.2
// (`feature-tasks/<sha256(identity)>.bin`, protected by safeStorage) and §8.5 (flush before notify),
// and docs/interfaces.md §7 (plaintext `{version: 1, identityKey, ledger, records}`, ≤128MB).
// The on-disk format must stay readable by and for BeingDesktop 0.8.x — do not change the schema.
//
// `normalizeTownSyncRecords` lives in the Town/Loom migration unit (BeingDesktop
// src/loom-town-sync.cjs) and is injected so this module stays testable on its own.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { FeatureTasks } from './feature-tasks';
import type {
  FeatureTaskSnapshot,
  FeatureTasksEvent,
  NormalizeTownSyncRecords,
  SafeStorageApi,
  SafeStorageLike,
  TownSyncRecord,
} from './types';

const MAX_FILE_BYTES = 128 * 1024 * 1024;

export interface FeatureTaskHistoryOptions {
  identityKey: string;
  directory: string;
  safeStorage?: SafeStorageLike;
  onChange?: (event: FeatureTasksEvent) => void;
  /** BeingDesktop src/loom-town-sync.cjs `normalizeTownSyncRecords`; injected, not imported. */
  normalizeTownSyncRecords: NormalizeTownSyncRecords;
}

export class FeatureTaskHistory {
  identityKey: string;
  directory: string;
  filePath: string;
  safeStorage?: SafeStorageLike;
  onChange: (event: FeatureTasksEvent) => void;
  ledger: FeatureTasks;
  private _normalize: NormalizeTownSyncRecords;
  private _persistenceError: boolean;
  private _records: TownSyncRecord[];
  private _blocked: boolean;
  private _dirty: boolean;
  private _generation: number;
  private _restorePromise: Promise<void> | null;
  private _savePromise: Promise<boolean> | null;

  constructor({ identityKey, directory, safeStorage, onChange = () => {}, normalizeTownSyncRecords }: FeatureTaskHistoryOptions = {} as FeatureTaskHistoryOptions) {
    if (typeof identityKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(identityKey)) throw new TypeError('Invalid task history identity');
    if (typeof directory !== 'string' || !directory || typeof onChange !== 'function') throw new TypeError('Invalid task history configuration');
    if (typeof normalizeTownSyncRecords !== 'function') throw new TypeError('Invalid task history configuration');
    this.identityKey = identityKey;
    this.directory = path.resolve(directory);
    this.filePath = path.join(this.directory, `${createHash('sha256').update(identityKey).digest('hex')}.bin`);
    this.safeStorage = safeStorage;
    this.onChange = onChange;
    this._normalize = normalizeTownSyncRecords;
    this._persistenceError = false;
    this._records = [];
    this._blocked = false;
    this._dirty = false;
    this._generation = 0;
    this._restorePromise = null;
    this._savePromise = null;
    this.ledger = this._ledger();
  }

  get records(): TownSyncRecord[] { return structuredClone(this._records); }
  get persistenceError(): boolean { return this._persistenceError; }

  private _ledger(initialSnapshot?: unknown): FeatureTasks {
    return new FeatureTasks({ identityKey: this.identityKey, initialSnapshot, onChange: () => {
      this._generation++;
      this._notify();
      void this.save();
    } });
  }

  private _notify(): void {
    try { this.onChange({ tasks: this.ledger.list(), persistenceError: this.persistenceError }); } catch {}
  }

  /**
   * Faithful to `_encryptionAvailable()` in the source: it probes exactly the same members in the
   * same order and swallows any throw, but returns the narrowed handle so strict TypeScript can use it.
   */
  private _encryption(): SafeStorageApi | null {
    try {
      const storage = this.safeStorage;
      return typeof storage?.isEncryptionAvailable === 'function'
        && storage.isEncryptionAvailable() === true
        && typeof storage.encryptString === 'function'
        && typeof storage.decryptString === 'function'
        ? storage as SafeStorageApi
        : null;
    } catch { return null; }
  }

  async restore(): Promise<this> {
    if (!this._restorePromise) this._restorePromise = this._restore();
    await this._restorePromise;
    return this;
  }

  private async _restore(): Promise<void> {
    const storage = this._encryption();
    if (!storage) { this._blocked = true; this._persistenceError = true; this._notify(); return; }
    try {
      const stat = await fs.stat(this.filePath);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Invalid encrypted task history');
      const ciphertext = await fs.readFile(this.filePath);
      if (ciphertext.length > MAX_FILE_BYTES) throw new Error('Invalid encrypted task history');
      const payload = JSON.parse(storage.decryptString(ciphertext)) as Record<string, unknown> | null;
      const ledgerPayload = payload?.ledger as Partial<FeatureTaskSnapshot> | undefined;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || Object.keys(payload).length !== 4 || payload.version !== 1 || payload.identityKey !== this.identityKey
        || !ledgerPayload || ledgerPayload.version !== 1 || ledgerPayload.identityKey !== this.identityKey
        || !Array.isArray(ledgerPayload.records) || !Array.isArray(payload.records) || payload.records.length > 256) {
        throw new Error('Task history identity or schema mismatch');
      }
      // Preserve work submitted while the first disk read was still pending.
      const current = this.ledger.snapshot();
      const currentIds = new Set(current.records.map(task => task.id));
      const records = this._generation ? [...current.records, ...ledgerPayload.records.filter(task => !currentIds.has(task?.id))] : ledgerPayload.records;
      this.ledger = this._ledger({ ...ledgerPayload, records });
      this._records = this._normalize([...payload.records, ...this._records]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') { this._blocked = true; this._persistenceError = true; }
    }
    this._notify();
  }

  register(record: unknown): boolean {
    const candidate = this._normalize([record]);
    if (candidate.length !== 1) return false;
    const next = this._normalize([...this._records, candidate[0]]);
    const accepted = next.some(item => item.requestId === candidate[0].requestId);
    if (JSON.stringify(next) !== JSON.stringify(this._records)) {
      this._records = next;
      this._generation++;
      this._notify();
      void this.save();
    }
    return accepted;
  }

  save(): Promise<boolean> {
    this._dirty = true;
    if (!this._savePromise) this._savePromise = this._drain().finally(() => {
      this._savePromise = null;
      if (this._dirty && !this._blocked) void this.save();
    });
    return this._savePromise;
  }

  private async _drain(): Promise<boolean> {
    await this.restore();
    while (this._dirty && !this._blocked) {
      this._dirty = false;
      let temporary: string | null = null;
      try {
        const storage = this._encryption();
        if (!storage) { this._blocked = true; throw new Error('Task history encryption unavailable'); }
        if (this.ledger.identityKey !== this.identityKey) { this._blocked = true; throw new Error('Task history identity changed'); }
        const payload = JSON.stringify({ version: 1, identityKey: this.identityKey, ledger: this.ledger.snapshot(), records: this._records });
        let ciphertext: Buffer;
        try { ciphertext = storage.encryptString(payload); }
        catch { this._blocked = true; throw new Error('Task history encryption failed'); }
        if (!Buffer.isBuffer(ciphertext) || !ciphertext.length || ciphertext.length > MAX_FILE_BYTES) {
          this._blocked = true;
          throw new Error('Invalid encrypted task history');
        }
        await fs.mkdir(this.directory, { recursive: true });
        temporary = `${this.filePath}.${randomUUID()}.tmp`;
        await fs.writeFile(temporary, ciphertext, { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, this.filePath);
        temporary = null;
        if (this.persistenceError) { this._persistenceError = false; this._notify(); }
      } catch {
        this._persistenceError = true;
        this._dirty = false;
        this._notify();
      } finally {
        if (temporary) { try { await fs.unlink(temporary); } catch {} }
      }
    }
    return !this.persistenceError;
  }

  async flush(): Promise<boolean> {
    while (this._savePromise) await this._savePromise;
    return !this.persistenceError;
  }
}
