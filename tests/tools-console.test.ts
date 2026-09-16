// Ported line by line from BeingDesktop 0.8.26 test/desktop-console.test.cjs on 2026-09-16.
// `__dirname`/`__filename` become paths relative to the vitest project root: `tests`
// and this file, matching what the CommonJS fixture resolved to.
import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { DesktopConsole } from "../desktop/main/tools/console";
import { consoleEnvironment } from "../desktop/main/common/platform";
import type { ConsoleSpawn, DesktopConsoleOptions } from "../desktop/main/tools/console";

const dirname = path.resolve("tests");
const filename = path.join(dirname, "tools-console.test.ts");
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

type FixtureChild = EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; exitCode: number | null; signalCode: string | null; killCalls: number; kill(): boolean; complete(code?: number): void };
function fixture(options: Partial<DesktopConsoleOptions> = {}) {
  const calls: any[][] = [];
  const children: FixtureChild[] = [];
  const service = new DesktopConsole({
    platform: "win32", getWorkspace: () => path.resolve(dirname, ".."),
    spawnImpl: ((...args: any[]) => {
      calls.push(args);
      const child = new EventEmitter() as FixtureChild;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.exitCode = null;
      child.signalCode = null;
      child.killCalls = 0;
      child.kill = () => {
        child.killCalls++;
        child.signalCode = "SIGTERM";
        queueMicrotask(() => child.emit("close", null, "SIGTERM"));
        return true;
      };
      child.complete = (code = 0) => {
        child.exitCode = code;
        child.emit("close", code, null);
      };
      children.push(child);
      return child;
    }) as unknown as ConsoleSpawn,
    ...options,
  });
  return { service, calls, children };
}

describe("desktop console", () => {
  it("console inherits only an explicit environment allowlist", () => {
    expect(consoleEnvironment({
      PATH: "tools", SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\fixture",
      BEING_LOOM_URL: "private", coworkToken: "private", OPENAI_API_KEY: "private",
      HTTP_PROXY: "private", HTTPS_PROXY: "private", NODE_OPTIONS: "private",
      ELECTRON_RUN_AS_NODE: "1", arbitraryAppSecret: "private",
    })).toEqual({ PATH: "tools", SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\fixture" });
  });

  it("invalid commands and working directories never launch a process", async () => {
    const { service, calls } = fixture();
    cleanups.push(() => service.dispose());
    for (const command of [undefined, "", "  ", "bad\0command", "x".repeat(65537)]) await expect(service.run({ command })).rejects.toThrow();
    for (const cwd of ["", "..", path.join(dirname, "missing-console-workspace"), filename]) await expect(service.run({ command: "echo ok", cwd })).rejects.toThrow();
    expect(calls.length).toBe(0);
  });

  it("commands use stdin and a hidden owned runner without interpolation", async () => {
    const { service, calls, children } = fixture();
    cleanups.push(() => service.dispose());
    const command = "Write-Output '中文 `$HOME; \"quoted\"'\nexit 4";
    const { jobId } = await service.run({ command });
    const [shell, args, options] = calls[0];
    expect(shell).toMatch(/powershell\.exe$/);
    expect(options.windowsHide).toBe(true);
    expect(options.shell).toBe(false);
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(args.some((value: string) => value.includes(command))).toBe(false);
    expect(children[0].stdin.read().toString("utf8")).toBe(command);
    const runner = Buffer.from(args.at(-1), "base64").toString("utf16le");
    expect(runner).toMatch(/CreateJobObject/);
    expect(runner).toMatch(/AssignProcessToJobObject/);
    expect(runner).toMatch(/0x2000/);
    children[0].emit("spawn");
    children[0].stdout.write(Buffer.from("中文输出\n"));
    children[0].stderr.write("error output\n");
    children[0].complete(4);
    const job = service.snapshot().jobs.find((item) => item.id === jobId)!;
    expect(job.status).toBe("failed");
    expect(job.exitCode).toBe(4);
    expect(job.output[0].text).toBe("中文输出\n");
    expect(job.output[1].stream).toBe("stderr");
    expect(job.endedAt).toBeTruthy();
  });

  it("output limits preserve valid Unicode and independent stdout/stderr streams", async () => {
    const { service, children } = fixture({ maxOutputBytes: 1024 });
    cleanups.push(() => service.dispose());
    await service.run({ command: "fixture output" });
    children[0].stdout.write("旧".repeat(1000));
    children[0].stderr.write("末尾🙂".repeat(120));
    const job = service.snapshot().jobs[0];
    expect(job.truncated).toBe(true);
    expect(job.output.reduce((size, item) => size + Buffer.byteLength(item.text), 0)).toBeLessThanOrEqual(1024);
    expect(job.output.every((item) => !item.text.includes("\ufffd"))).toBe(true);
    expect(job.output.at(-1)!.stream).toBe("stderr");
    expect(job.output.at(-1)!.text.endsWith("末尾🙂")).toBe(true);
  });

  it("pending asynchronous runs reserve concurrency and disposal cancels pending launch", async () => {
    let release!: (value: string) => void;
    const { service, calls, children } = fixture({ maxConcurrent: 1, getWorkspace: () => new Promise((resolve) => { release = resolve; }) });
    const first = service.run({ command: "first" });
    await expect(service.run({ command: "second" })).rejects.toThrow(/最多同时/);
    await service.dispose();
    release(path.resolve(dirname));
    await expect(first).rejects.toThrow(/已经关闭/);
    expect(calls.length).toBe(0);
    expect(children.length).toBe(0);
  });

  it("stop targets only its retained child, is idempotent, and leaves other jobs running", async () => {
    const { service, children } = fixture();
    cleanups.push(() => service.dispose());
    const first = await service.run({ command: "first" });
    const second = await service.run({ command: "second" });
    children.forEach((child) => child.emit("spawn"));
    const stopping = service.stop(first.jobId);
    const again = service.stop(first.jobId);
    expect(await stopping).toEqual({ stopped: true });
    expect(await again).toEqual({ stopped: true });
    expect(children[0].killCalls).toBe(1);
    expect(children[1].killCalls).toBe(0);
    expect(service.snapshot().jobs.find((job) => job.id === second.jobId)!.status).toBe("running");
    expect(await service.stop(first.jobId)).toEqual({ stopped: false });
    expect(await service.stop("unknown-job")).toEqual({ stopped: false });
  });

  it("clear and snapshot cannot rerun commands or mutate retained output", async () => {
    const { service, children, calls } = fixture();
    cleanups.push(() => service.dispose());
    const { jobId } = await service.run({ command: "one command" });
    children[0].stdout.write("before clear");
    const copy = service.snapshot();
    copy.jobs[0].output[0].text = "modified";
    expect(service.snapshot().jobs[0].output[0].text).toBe("before clear");
    expect(service.clear(jobId)).toEqual({ cleared: 1 });
    expect(service.snapshot().jobs[0].output.length).toBe(0);
    children[0].stdout.write("after clear");
    expect(service.snapshot().jobs[0].output[0].text).toBe("after clear");
    expect(calls.length).toBe(1);
  });

  it("history evicts completed jobs while retaining a running job", async () => {
    const { service, children } = fixture({ maxJobs: 2 });
    cleanups.push(() => service.dispose());
    const first = await service.run({ command: "long job" });
    await service.run({ command: "short job" });
    children[1].complete();
    const last = await service.run({ command: "last job" });
    expect(service.snapshot().jobs.map((job) => job.id)).toEqual([first.jobId, last.jobId]);
  });

  it("spawn failure is a reviewable failed job and cannot leak a concurrency slot", async () => {
    const { service } = fixture({ maxConcurrent: 1, spawnImpl: (() => { throw new Error("fixture failure"); }) as unknown as ConsoleSpawn });
    await service.run({ command: "first" });
    await service.run({ command: "second" });
    expect(service.snapshot().jobs.every((job) => job.status === "failed" && job.endedAt)).toBe(true);
    await service.dispose();
  });

  it("cancellation while a workspace resolves prevents any process launch", async () => {
    let release!: (value: string) => void;
    const { service, calls } = fixture({ getWorkspace: () => new Promise((resolve) => { release = resolve; }) });
    cleanups.push(() => service.dispose());
    const controller = new AbortController();
    const running = service.run({ command: "cancelled before launch", signal: controller.signal });
    controller.abort();
    release(path.resolve(dirname));
    await expect(running).rejects.toThrow(/取消/);
    expect(calls.length).toBe(0);
    await expect(service.run({ command: "already cancelled", signal: controller.signal })).rejects.toThrow(/取消/);
    expect(calls.length).toBe(0);
  });

  it("cancellation stops only a still-starting owned process and releases its listener after spawn", async () => {
    const { service, children } = fixture();
    cleanups.push(() => service.dispose());
    const startup = new AbortController();
    const { jobId } = await service.run({ command: "startup cancellation", signal: startup.signal });
    startup.abort();
    await service.stop(jobId);
    expect(children[0].killCalls).toBe(1);
    expect(service.snapshot().jobs[0].status).toBe("stopped");

    const established = new AbortController();
    await service.run({ command: "approved established command", signal: established.signal });
    children[1].emit("spawn");
    established.abort();
    expect(children[1].killCalls).toBe(0);
    expect(service.snapshot().jobs[1].status).toBe("running");
  });

  it("failed disposal restores command availability and allows a later clean shutdown", async () => {
    const { service, children } = fixture();
    await service.run({ command: "job whose first stop fails" });
    children[0].emit("spawn");
    const originalKill = children[0].kill;
    children[0].kill = () => false;
    await expect(service.dispose()).rejects.toThrow(/未能停止/);
    expect(service.snapshot().jobs[0].status).toBe("running");
    const next = await service.run({ command: "new command after failed shutdown" });
    expect(next.jobId).toBeTruthy();
    expect(children.length).toBe(2);
    children[0].kill = originalKill;
    await service.dispose();
    expect(service.snapshot().jobs.every((job) => job.status === "stopped")).toBe(true);
    await expect(service.run({ command: "after successful disposal" })).rejects.toThrow(/已经关闭/);
  });
});
