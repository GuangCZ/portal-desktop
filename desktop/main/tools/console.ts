// Ported line by line from BeingDesktop 0.8.26 src/desktop-console.cjs on 2026-09-16.
// Non-interactive local commands owned by Desktop: every job runs in a hidden
// shell that owns its process tree (a Windows job object, a detached POSIX
// process group) and inherits only `common/platform.ts`'s environment allow-list.
// See docs/architecture.md §5.4 and §7「安全模型与边界」.
// The environment allow-list, the shell resolution and the Windows job-object
// runner all live in `common/platform.ts`; this file carried its own copies of
// the last two until the I0 seam stage folded them into one.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { consoleEnvironment, desktopEnvironment, desktopPlatform, shellPath as defaultShellPath, WINDOWS_RUNNER } from '../common/platform';

function outputTail(text: string, bytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= bytes) return text;
  let start = buffer.length - bytes;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString('utf8');
}

export type ConsoleJobStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'completed' | 'failed';
export interface ConsoleOutputChunk { stream: 'stdout' | 'stderr'; text: string }
export interface ConsoleJob {
  id: string;
  command: string;
  cwd: string;
  status: ConsoleJobStatus;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  output: ConsoleOutputChunk[];
  outputBytes: number;
  truncated: boolean;
}
export type ConsoleJobView = Omit<ConsoleJob, 'outputBytes'> & { origin?: 'you' | 'being' };
export interface ConsoleSnapshot {
  shell: string;
  limits: { maxConcurrent: number; maxOutputBytes: number; maxJobs: number };
  jobs: ConsoleJobView[];
}
/** The child-process surface the console drives; `spawn` and the test double both satisfy it. */
export interface ConsoleChildProcess {
  stdout: any;
  stderr: any;
  stdin: any;
  exitCode: number | null;
  signalCode: any;
  pid?: number | undefined;
  kill(signal?: any): boolean;
  once(event: string, listener: (...args: any[]) => void): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
}
export type ConsoleSpawn = (command: string, args: readonly string[], options: any) => ConsoleChildProcess;
export interface DesktopConsoleOptions {
  getWorkspace?: () => string | Promise<string>;
  onChange?: (snapshot: ConsoleSnapshot) => void;
  shellPath?: string;
  maxOutputBytes?: number;
  maxJobs?: number;
  maxConcurrent?: number;
  spawnImpl?: ConsoleSpawn;
  environment?: Record<string, string | undefined>;
  platform?: NodeJS.Platform | string;
  killGroup?: (pid: number, signal: NodeJS.Signals | number) => void;
}
interface OwnedChild { child: ConsoleChildProcess; stopping: boolean; closed: Promise<void> }

export class DesktopConsole {
  getWorkspace: () => string | Promise<string>;
  onChange: (snapshot: ConsoleSnapshot) => void;
  platform: NodeJS.Platform | string;
  environment: Record<string, string>;
  killGroup: (pid: number, signal: NodeJS.Signals | number) => void;
  shell: string;
  shellPath: string;
  maxOutputBytes: number;
  maxJobs: number;
  maxConcurrent: number;
  spawnImpl: ConsoleSpawn;
  _jobs: ConsoleJob[];
  _children: Map<string, OwnedChild>;
  _pendingRuns: number;
  _disposed: boolean;
  _changeTimer: ReturnType<typeof setTimeout> | null;

  constructor({ getWorkspace = () => '', onChange = () => {}, shellPath,
    maxOutputBytes = 256 * 1024, maxJobs = 20, maxConcurrent = 3,
    spawnImpl = spawn as unknown as ConsoleSpawn, environment = process.env, platform = process.platform, killGroup = (pid, signal) => { process.kill(-pid, signal); } }: DesktopConsoleOptions = {}) {
    this.getWorkspace = getWorkspace;
    this.onChange = onChange;
    this.platform = platform;
    this.environment = consoleEnvironment(desktopEnvironment(environment, platform));
    this.killGroup = killGroup;
    this.shell = desktopPlatform(platform).shell;
    this.shellPath = shellPath || defaultShellPath(platform, environment);
    this.maxOutputBytes = Math.max(1024, Math.min(1024 * 1024, Number(maxOutputBytes) || 256 * 1024));
    this.maxJobs = Math.max(1, Math.min(50, Math.floor(Number(maxJobs) || 20)));
    this.maxConcurrent = Math.max(1, Math.min(this.maxJobs, 5, Math.floor(Number(maxConcurrent) || 3)));
    this.spawnImpl = spawnImpl;
    this._jobs = [];
    this._children = new Map();
    this._pendingRuns = 0;
    this._disposed = false;
    this._changeTimer = null;
  }

  snapshot(): ConsoleSnapshot {
    return {
      shell: this.shell,
      limits: { maxConcurrent: this.maxConcurrent, maxOutputBytes: this.maxOutputBytes, maxJobs: this.maxJobs },
      jobs: this._jobs.map(({ outputBytes, ...job }) => ({ ...job, output: job.output.map(item => ({ ...item })) })),
    };
  }

  _notify(immediate = false): void {
    if (immediate && this._changeTimer) {
      clearTimeout(this._changeTimer);
      this._changeTimer = null;
    }
    const emit = () => {
      this._changeTimer = null;
      try { this.onChange(this.snapshot()); } catch { /* Observers cannot interrupt command ownership. */ }
    };
    if (immediate) emit();
    else if (!this._changeTimer) this._changeTimer = setTimeout(emit, 50);
  }

  _append(job: ConsoleJob, stream: 'stdout' | 'stderr', text: unknown): void {
    if (!text) return;
    const clean = String(text).replace(/\0/g, '');
    if (!clean) return;
    job.output.push({ stream, text: clean });
    job.outputBytes += Buffer.byteLength(clean, 'utf8');
    while (job.output.length > 1000) {
      job.outputBytes -= Buffer.byteLength(job.output.shift()!.text, 'utf8');
      job.truncated = true;
    }
    while (job.outputBytes > this.maxOutputBytes && job.output.length) {
      const first = job.output[0];
      const size = Buffer.byteLength(first.text, 'utf8');
      const excess = job.outputBytes - this.maxOutputBytes;
      if (size <= excess) {
        job.output.shift();
        job.outputBytes -= size;
      } else {
        first.text = outputTail(first.text, size - excess);
        job.outputBytes -= size - Buffer.byteLength(first.text, 'utf8');
      }
      job.truncated = true;
    }
    this._notify();
  }

  async run({ command, cwd, signal }: { command?: unknown; cwd?: string; signal?: AbortSignal } = {}): Promise<{ jobId: string }> {
    if (this._disposed) throw new Error('控制台已经关闭。');
    if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw new Error('命令取消信号无效。');
    const checkCancelled = () => { if (signal?.aborted) throw new Error('命令调用已取消，尚未启动。'); };
    checkCancelled();
    if (!desktopPlatform(this.platform).terminalSupported) throw new Error('当前平台不支持本机控制台。');
    if (typeof command !== 'string' || !command.trim() || command.includes('\0') || command.length > 65536) throw new Error('请输入有效命令，长度不能超过 65536 个字符。');
    if (this._children.size + this._pendingRuns >= this.maxConcurrent) throw new Error(`最多同时运行 ${this.maxConcurrent} 个命令，请先停止或等待现有命令。`);
    this._pendingRuns++;
    try {
      const requested = cwd === undefined ? await this.getWorkspace() : cwd;
      checkCancelled();
      if (typeof requested !== 'string' || !path.isAbsolute(requested) || requested.includes('\0')) throw new Error('请先选择有效的本地工作区。');
      let directory: string;
      try {
        directory = await fs.realpath(requested);
        checkCancelled();
        const stat = await fs.stat(directory);
        checkCancelled();
        if (!stat.isDirectory()) throw new Error('not a directory');
      } catch { checkCancelled(); throw new Error('命令工作目录不存在或无法访问，请重新选择工作区。'); }
      if (this._disposed) throw new Error('控制台已经关闭。');
      checkCancelled();
      while (this._jobs.length >= this.maxJobs) {
        const oldest = this._jobs.findIndex(job => !this._children.has(job.id));
        if (oldest < 0) throw new Error('请先等待现有命令结束。');
        this._jobs.splice(oldest, 1);
      }
      const job: ConsoleJob = {
        id: randomUUID(), command, cwd: directory, status: 'starting',
        startedAt: new Date().toISOString(), endedAt: null,
        exitCode: null, signal: null, output: [], outputBytes: 0, truncated: false,
      };
      this._jobs.push(job);
      let child: ConsoleChildProcess;
      try {
        child = this.spawnImpl(this.shellPath,
          this.platform === 'darwin' ? ['-f', '-s'] : ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(WINDOWS_RUNNER, 'utf16le').toString('base64')],
          { cwd: directory, env: { ...this.environment }, detached: this.platform === 'darwin', windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch {
        job.status = 'failed';
        job.endedAt = new Date().toISOString();
        this._append(job, 'stderr', `无法启动 ${this.shell}，请检查系统安装。\n`);
        this._notify(true);
        return { jobId: job.id };
      }
      let resolveClosed!: () => void;
      const owned: OwnedChild = { child, stopping: false, closed: new Promise<void>(resolve => { resolveClosed = resolve; }) };
      this._children.set(job.id, owned);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (text: unknown) => this._append(job, 'stdout', text));
      child.stderr.on('data', (text: unknown) => this._append(job, 'stderr', text));
      const removeAbort = () => signal?.removeEventListener('abort', abortStartup);
      const abortStartup = () => {
        removeAbort();
        void this.stop(job.id).catch(() => this._append(job, 'stderr', '启动已取消，但进程未能停止，请在控制台重试停止。\n'));
      };
      child.once('spawn', () => {
        removeAbort();
        if (!owned.stopping) job.status = 'running';
        this._notify(true);
      });
      child.once('error', () => {
        job.status = 'failed';
        this._append(job, 'stderr', '命令进程启动或运行失败。\n');
        this._notify(true);
      });
      child.stdin.on('error', () => { /* A failed or stopped shell can close input before it is written. */ });
      if (this.platform === 'darwin') child.once('exit', () => {
        // Clean up ordinary descendants of this freshly exited, detached shell.
        // Never look up processes by name or signal a saved PID after close.
        if (!owned.stopping && Number.isInteger(child.pid) && child.pid! > 1) {
          try { this.killGroup(child.pid!, 'SIGKILL'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { job.status = 'failed'; this._append(job, 'stderr', '命令子进程清理未完成。\n'); } }
        }
      });
      child.once('close', (code: number | null, signal: string | null) => {
        removeAbort();
        job.exitCode = Number.isInteger(code) ? code : null;
        job.signal = signal || null;
        job.status = owned.stopping ? 'stopped' : (job.status === 'failed' || code !== 0 ? 'failed' : 'completed');
        job.endedAt = new Date().toISOString();
        this._children.delete(job.id);
        this._notify(true);
        resolveClosed();
      });
      signal?.addEventListener('abort', abortStartup, { once: true });
      if (signal?.aborted) {
        removeAbort();
        await this.stop(job.id);
        checkCancelled();
      }
      child.stdin.end(command, 'utf8');
      this._notify(true);
      return { jobId: job.id };
    } finally { this._pendingRuns--; }
  }

  async stop(jobId: unknown): Promise<{ stopped: boolean }> {
    if (typeof jobId !== 'string') throw new Error('请选择有效的命令。');
    const owned = this._children.get(jobId);
    if (!owned) return { stopped: false };
    if (owned.stopping) {
      await owned.closed;
      return { stopped: true };
    }
    // ChildProcess.kill uses its retained Windows process handle, not a new PID
    // lookup. The job object's handle closes with this exact shell instance.
    if (owned.child.exitCode !== null || owned.child.signalCode !== null) {
      await owned.closed;
      return { stopped: false };
    }
    owned.stopping = true;
    const job = this._jobs.find(item => item.id === jobId);
    if (job) job.status = 'stopping';
    this._notify(true);
    let killed = false;
    try {
      if (this.platform === 'darwin') {
        if (!Number.isInteger(owned.child.pid) || owned.child.pid! <= 1) throw new Error('Invalid owned PID');
        this.killGroup(owned.child.pid!, 'SIGKILL');
        killed = true;
      } else killed = owned.child.kill();
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') killed = true; }
    if (!killed) {
      owned.stopping = false;
      if (job) job.status = 'running';
      this._notify(true);
      throw new Error('未能停止该命令，请重试。');
    }
    await owned.closed;
    return { stopped: true };
  }

  clear(jobId?: unknown): { cleared: number } {
    if (jobId !== undefined && typeof jobId !== 'string') throw new Error('请选择有效的命令。');
    const jobs = this._jobs.filter(job => jobId === undefined || job.id === jobId);
    for (const job of jobs) {
      job.output = [];
      job.outputBytes = 0;
      job.truncated = false;
    }
    this._notify(true);
    return { cleared: jobs.length };
  }

  async dispose(): Promise<void> {
    this._disposed = true;
    const results = await Promise.allSettled([...this._children.keys()].map(id => this.stop(id)));
    if (this._changeTimer) clearTimeout(this._changeTimer);
    this._changeTimer = null;
    const failure = results.find(result => result.status === 'rejected');
    if (failure) {
      this._disposed = false;
      throw (failure as PromiseRejectedResult).reason;
    }
  }
}
