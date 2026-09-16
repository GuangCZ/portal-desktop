// Ported line by line from BeingDesktop 0.8.26 src/feature-task-history.cjs on 2026-09-16.
// docs/interfaces.md §7: `feature-tasks/<sha256(identity)>.bin` holds the safeStorage
// ciphertext of `{version:1, identityKey, ledger:{version:1, identityKey, records:[TaskDto]},
// records:[TownSyncRecord]}` (≤128MB). docs/architecture.md §8.5「先落盘再通知」: every
// ledger change notifies the observer and then schedules the encrypted write; a changed
// identity or unavailable encryption blocks the file instead of overwriting another account.
// `normalizeTownSyncRecords` (BeingDesktop src/loom-town-sync.cjs) lives outside this unit
// and is injected as `normalizeRecords`.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { FeatureTasks } from './feature-tasks';
import type {
  FeatureTaskHistoryEvent,
  FeatureTaskHistoryOptions,
  FeatureTaskSecretStorage,
  NormalizeTownSyncRecords,
  TownSyncRecord,
} from './types';

const MAX_FILE_BYTES = 128 * 1024 * 1024;

interface StoredLedger { version?: unknown; identityKey?: unknown; records?: unknown }
interface StoredHistory { version?: unknown; identityKey?: unknown; ledger?: StoredLedger; records?: unknown }

export class FeatureTaskHistory {
  identityKey: string;
  directory: string;
  filePath: string;
  safeStorage: Partial<FeatureTaskSecretStorage> | undefined;
  onChange: (event: FeatureTaskHistoryEvent) => void;
  normalizeRecords: NormalizeTownSyncRecords;
  ledger: FeatureTasks;
  private _persistenceError: boolean;
  private _records: TownSyncRecord[];
  private _blocked: boolean;
  private _dirty: boolean;
  private _generation: number;
  private _restorePromise: Promise<void> | null;
  private _savePromise: Promise<boolean> | null;

  constructor({ identityKey, directory, safeStorage, onChange = () => {}, normalizeRecords }: FeatureTaskHistoryOptions) {
    if (typeof identityKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(identityKey)) throw new TypeError('Invalid task history identity');
    if (typeof directory !== 'string' || !directory || typeof onChange !== 'function' || typeof normalizeRecords !== 'function') throw new TypeError('Invalid task history configuration');
    this.identityKey = identityKey;
    this.directory = path.resolve(directory);
    this.filePath = path.join(this.directory, `${createHash('sha256').update(identityKey).digest('hex')}.bin`);
    this.safeStorage = safeStorage;
    this.onChange = onChange;
    this.normalizeRecords = normalizeRecords;
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

  private _encryptionAvailable(): boolean {
    try {
      return typeof this.safeStorage?.isEncryptionAvailable === 'function'
        && this.safeStorage.isEncryptionAvailable() === true
        && typeof this.safeStorage.encryptString === 'function'
        && typeof this.safeStorage.decryptString === 'function';
    } catch { return false; }
  }

  async restore(): Promise<this> {
    if (!this._restorePromise) this._restorePromise = this._restore();
    await this._restorePromise;
    return this;
  }

  private async _restore(): Promise<void> {
    if (!this._encryptionAvailable()) { this._blocked = true; this._persistenceError = true; this._notify(); return; }
    const storage = this.safeStorage as FeatureTaskSecretStorage;
    try {
      const stat = await fs.stat(this.filePath);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Invalid encrypted task history');
      const ciphertext = await fs.readFile(this.filePath);
      if (ciphertext.length > MAX_FILE_BYTES) throw new Error('Invalid encrypted task history');
      const payload = JSON.parse(storage.decryptString(ciphertext)) as StoredHistory | null;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || Object.keys(payload).length !== 4 || payload.version !== 1 || payload.identityKey !== this.identityKey
        || !payload.ledger || payload.ledger.version !== 1 || payload.ledger.identityKey !== this.identityKey
        || !Array.isArray(payload.ledger.records) || !Array.isArray(payload.records) || payload.records.length > 256) {
        throw new Error('Task history identity or schema mismatch');
      }
      // Preserve work submitted while the first disk read was still pending.
      const current = this.ledger.snapshot();
      const currentIds = new Set(current.records.map(task => task.id));
      const records = this._generation ? [...current.records, ...payload.ledger.records.filter((task: { id?: string } | null) => !currentIds.has(task?.id as string))] : payload.ledger.records;
      this.ledger = this._ledger({ ...payload.ledger, records });
      this._records = this.normalizeRecords([...payload.records, ...this._records]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') { this._blocked = true; this._persistenceError = true; }
    }
    this._notify();
  }

  register(record: unknown): boolean {
    const candidate = this.normalizeRecords([record]);
    if (candidate.length !== 1) return false;
    const next = this.normalizeRecords([...this._records, candidate[0]]);
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
        if (!this._encryptionAvailable()) { this._blocked = true; throw new Error('Task history encryption unavailable'); }
        if (this.ledger.identityKey !== this.identityKey) { this._blocked = true; throw new Error('Task history identity changed'); }
        const storage = this.safeStorage as FeatureTaskSecretStorage;
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
