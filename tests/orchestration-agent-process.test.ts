// Ported from BeingDesktop 0.8.26 test/agent-process.test.cjs on 2026-09-16.
// Four ported cases, names preserved. Two of them spawn a real child process through `launchAgent`,
// using a generated node script as the fake CLI exactly as BeingDesktop does.
// The fifth case is a regression guard added on 2026-09-16 for the win32 branch, which neither
// BeingDesktop nor this port covered: it pins the spawn shape to src/agent-process.cjs so the
// vendored WINDOWS_RUNNER default cannot silently disappear again.
// Contract: docs/orchestration.md "Environment" (allow-list, no code injection).

import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { spawn as spawnType } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { agentEnvironment, launchAgent, psValue } from "../desktop/main/orchestration/agent-process";
import { WINDOWS_RUNNER } from "../desktop/main/orchestration/vendored";

interface SpawnCall { file: string; args: readonly string[]; options: Record<string, unknown> }

function recordingSpawn() {
  const calls: SpawnCall[] = [];
  let written = "";
  const stream = () => Object.assign(new EventEmitter(), { setEncoding: () => {} });
  const spawnImpl = ((file: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ file, args, options });
    return Object.assign(new EventEmitter(), {
      stdin: Object.assign(new EventEmitter(), { end: (text: string) => { written += text; } }),
      stdout: stream(), stderr: stream(), exitCode: null, signalCode: null, pid: 4321,
    });
  }) as unknown as typeof spawnType;
  return { calls, spawnImpl, written: () => written };
}

const cleanups: (() => Promise<unknown>)[] = [];
afterAll(async () => { for (const cleanup of cleanups) await cleanup(); });

describe("agent process", () => {
  it("workers preserve local CLI authentication and proxy routing without Desktop credentials or code injection", () => {
    expect(agentEnvironment({ PATH: "fixture", HTTPS_PROXY: "http://127.0.0.1:7890", http_proxy: "http://127.0.0.1:7890", NO_PROXY: "localhost", ALL_PROXY: "socks5://127.0.0.1:7890", CODEX_HOME: "fixture-profile", OPENAI_API_KEY: "private", NODE_OPTIONS: "private", ELECTRON_RUN_AS_NODE: "1", https_proxy: "invalid\0value" }))
      .toEqual({ PATH: "fixture", HTTPS_PROXY: "http://127.0.0.1:7890", http_proxy: "http://127.0.0.1:7890", NO_PROXY: "localhost", ALL_PROXY: "socks5://127.0.0.1:7890", CODEX_HOME: "fixture-profile", OPENAI_API_KEY: "private" });
  });

  it("native worker transport preserves prompt text as data without shell evaluation", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "being-agent-transport-"));
    cleanups.push(async () => { expect(path.dirname(directory)).toBe(os.tmpdir()); await fs.rm(directory, { recursive: true, force: true }); });
    const file = path.join(directory, "echo-input.cjs");
    await fs.writeFile(file, "process.stdin.setEncoding('utf8');let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({text})));\n");
    const input = '中文需求\n"quoted" \'single\' `backtick`\n$(throw "must not run") & echo unsafe\n';
    let output = "", errors = "";
    const child = launchAgent({ file: process.execPath, args: [file], input, cwd: directory, onData: (stream, text) => { if (stream === "stdout") output += text; else errors += text; } });
    const result = await child.done; expect(result.code, errors).toBe(0);
    expect(JSON.parse(output.trim()).text.replaceAll("\r\n", "\n").trimEnd()).toBe(input.trimEnd());
  });

  it("each Desktop passes only its own CLI environment through the real child transport", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-local-environment-"));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const probe = path.join(dir, "probe.cjs");
    await fs.writeFile(probe, `process.stdout.write(JSON.stringify({key:process.env.OPENAI_API_KEY,url:process.env.OPENAI_BASE_URL,home:process.env.CODEX_HOME,proxy:process.env.HTTPS_PROXY,ca:process.env.NODE_EXTRA_CA_CERTS,being:process.env.BEING_LOOM_URL,node:process.env.NODE_OPTIONS}));`);
    for (const name of ["desktop-a", "desktop-b"]) {
      let output = "";
      const source: NodeJS.ProcessEnv = { ...process.env, OPENAI_API_KEY: "synthetic-" + name, OPENAI_BASE_URL: "http://127.0.0.1/" + name, CODEX_HOME: path.join(dir, name), HTTPS_PROXY: "http://127.0.0.1:1234", BEING_LOOM_URL: "synthetic-private", NODE_OPTIONS: "--this-must-not-reach-node" };
      delete source.NODE_EXTRA_CA_CERTS;
      const child = launchAgent({ file: process.execPath, args: [probe], cwd: dir, environment: source, onData: (stream, text) => { if (stream === "stdout") output += text; } });
      expect((await child.done).code).toBe(0);
      expect(JSON.parse(output)).toEqual({ key: "synthetic-" + name, url: "http://127.0.0.1/" + name, home: path.join(dir, name), proxy: source.HTTPS_PROXY });
    }
  });

  it("the Windows worker shell runs the owned-job runner and receives the command through stdin", () => {
    const fake = recordingSpawn();
    launchAgent({ file: "C:\\Program Files\\codex.exe", args: ["exec", "--json"], input: "中文需求", cwd: "C:\\work", platform: "win32", spawnImpl: fake.spawnImpl, environment: { SystemRoot: "D:\\Windows", PATH: "C:\\bin", OPENAI_API_KEY: "synthetic" } });
    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    expect(call.file).toBe("D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(call.args.slice(0, 6)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand"]);
    expect(Buffer.from(String(call.args[6]), "base64").toString("utf16le")).toBe(WINDOWS_RUNNER);
    expect(WINDOWS_RUNNER).toContain("[BeingConsoleJob]::Enter()");
    expect(call.options).toMatchObject({ cwd: "C:\\work", windowsHide: true, shell: false });
    expect(call.options.detached).toBe(undefined);
    expect((call.options.env as NodeJS.ProcessEnv).OPENAI_API_KEY).toBe("synthetic");
    expect(fake.written()).toBe(`$agentExecutable = ${psValue("C:\\Program Files\\codex.exe")}\n$agentArguments = @(${psValue("exec")},${psValue("--json")})\n${psValue("中文需求")} | & $agentExecutable @agentArguments`);
  });

  it("CLI configuration directories and trusted certificates survive without disabling TLS verification", () => {
    const actual = agentEnvironment({ XDG_CONFIG_HOME: "/config", XDG_DATA_HOME: "/data", OPENAI_BASE_URL: "http://127.0.0.1/v1", CURSOR_API_KEY: "synthetic-cursor", XAI_API_KEY: "synthetic-xai", NODE_EXTRA_CA_CERTS: "/ca.pem", SSL_CERT_FILE: "/trust.pem", NODE_TLS_REJECT_UNAUTHORIZED: "0", BEING_TOKEN: "synthetic-being", AWS_SECRET_ACCESS_KEY: "unrelated" });
    expect(actual).toEqual({ XDG_CONFIG_HOME: "/config", XDG_DATA_HOME: "/data", OPENAI_BASE_URL: "http://127.0.0.1/v1", CURSOR_API_KEY: "synthetic-cursor", XAI_API_KEY: "synthetic-xai", NODE_EXTRA_CA_CERTS: "/ca.pem", SSL_CERT_FILE: "/trust.pem" });
  });
});
