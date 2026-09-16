// Ported line by line from BeingDesktop 0.8.26 test/worker-presentation.test.cjs on 2026-09-16.
// `normalizeUrl` stands in for normalizeBrowserUrl (src/desktop-browser.cjs, owned by the
// browser unit); the fixture reproduces its navigationUrl branch verbatim.
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { WorkerPresentation } from "../desktop/main/tools/worker-presentation";
import type { BrowserTab, PresentationBrowser } from "../desktop/main/tools/types";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const MAX_URL_LENGTH = 8192;
function navigationUrl(value: string) {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError("请输入有效的网页地址。");
  const input = value.trim();
  if (!/^https?:\/\//i.test(input)) throw new TypeError("浏览器仅支持 HTTP 和 HTTPS 网页。");
  let url;
  try { url = new URL(input); } catch { throw new TypeError("请输入有效的网页地址。"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) throw new TypeError("网页地址不能包含登录凭据。");
  return url.href;
}

async function fixture() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "being-presentation-"));
  await fs.mkdir(path.join(cwd, "game")); await fs.writeFile(path.join(cwd, "game", "index.html"), '<title>Game</title><script src="app.js"></script>');
  await fs.writeFile(path.join(cwd, "game", "app.js"), "window.game=true"); await fs.writeFile(path.join(cwd, "game", ".env"), "SECRET"); await fs.writeFile(path.join(cwd, "private.json"), "SECRET");
  const tabs: BrowserTab[] = []; let shown = 0;
  const browser: PresentationBrowser = { snapshot: () => ({ tabs, activeTabId: tabs.at(-1)?.id ?? null, visible: shown > 0 }), newTab: ({ url }) => { tabs.push({ id: "tab-" + tabs.length, url, title: "", isLoading: true, error: "" }); return { activeTabId: tabs.at(-1)!.id }; }, activateTab: () => {}, reload: () => {} };
  const presentation = new WorkerPresentation({ browser, showBrowser: () => { shown++; }, normalizeUrl: navigationUrl }), worker = { id: "worker", cwd };
  cleanups.push(async () => { await presentation.dispose(); await fs.rm(cwd, { recursive: true, force: true }); });
  return { presentation, worker, tabs, browser, shown: () => shown, cwd };
}
function request(url: string | URL, options: http.RequestOptions = {}): Promise<{ status?: number; body: string }> {
  return new Promise((resolve, reject) => { const req = http.get(url, options, (res) => { let body = ""; res.on("data", (data) => (body += data)); res.on("end", () => resolve({ status: res.statusCode, body })); }); req.on("error", reject); });
}

describe("worker presentation", () => {
  it("Desktop serves completed static output and opens its own browser without a CLI service", async () => {
    const f = await fixture(), value = (await f.presentation.open(f.worker, { artifactPath: "game/index.html" }))!;
    expect(f.shown()).toBe(1); expect(value.state).toBe("loading"); expect(f.tabs.length).toBe(1);
    expect(new URL(value.url).hostname).toBe("127.0.0.1"); expect((await request(value.url)).body).toMatch(/<title>Game<\/title>/);
    expect((await request(new URL("app.js", value.url))).body).toBe("window.game=true");
    f.tabs[0].isLoading = false; f.tabs[0].title = "Game"; expect(f.presentation.describe(value)!.state).toBe("loaded");
    const again = (await f.presentation.open({ ...f.worker, presentation: value }, { artifactPath: "game/index.html" }))!;
    expect(again.tabId).toBe(value.tabId); expect(again.url).toBe(value.url); expect(f.tabs.length).toBe(1);
    f.tabs[0].url = "https://example.invalid/"; expect(f.presentation.describe(value)!.state).toBe("navigated");
    f.tabs.length = 0; expect(f.presentation.describe(value)!.state).toBe("closed");
    await f.presentation.dispose(); await expect(request(value.url)).rejects.toThrow();
  });

  it("static preview rejects hidden files, traversal, cross-origin requests, methods and paths outside the artifact", async () => {
    const f = await fixture(), value = (await f.presentation.open(f.worker, { artifactPath: "game" }))!, origin = new URL(value.url).origin;
    for (const relative of ["/.env", "/%2e%2e%2fprivate.json", "/..%5cprivate.json"]) expect((await request(origin + relative)).status).toBe(403);
    expect((await request(origin + "/private.json")).status).toBe(404);
    expect((await request(value.url, { headers: { Origin: "https://unrelated.invalid" } })).status).toBe(403);
    expect((await request(value.url, { headers: { Host: "unrelated.invalid" } })).status).toBe(403);
    expect((await request(value.url, { method: "POST" })).status).toBe(405);
    await expect(f.presentation.open(f.worker, { artifactPath: "../outside.html" })).rejects.toThrow();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "being-presentation-outside-"));
    cleanups.push(() => fs.rm(outside, { recursive: true, force: true })); await fs.writeFile(path.join(outside, "index.html"), "OUTSIDE");
    await fs.symlink(outside, path.join(f.cwd, "game", "escape"), "junction");
    expect((await request(origin + "/escape/index.html")).status).toBe(403);
    await expect(f.presentation.open(f.worker, { artifactPath: "game/escape/index.html" })).rejects.toThrow(/工作区/);
  });

  it("presentation does not execute arbitrary URLs and reports browser failures honestly", async () => {
    const f = await fixture();
    for (const url of ["file:///C:/x.html", "javascript:alert(1)", "https://user:pass@example.invalid/"]) await expect(f.presentation.open(f.worker, { url })).rejects.toThrow();
    await expect(f.presentation.open(f.worker, { url: "https://example.invalid", artifactPath: "game" })).rejects.toThrow();
    expect(f.tabs.length).toBe(0);
    const value = (await f.presentation.open(f.worker, { url: "http://127.0.0.1:4178/" }))!;
    f.tabs[0].isLoading = false; f.tabs[0].error = "failed"; expect(f.presentation.describe(value)!.state).toBe("failed");
  });

  it("revoked task binding cannot open a browser or retain a newly acquired preview", async () => {
    const f = await fixture();
    await expect(f.presentation.open(f.worker, { artifactPath: "game" }, { current: () => false })).rejects.toThrow(/取消/);
    expect(f.tabs.length).toBe(0); expect(f.presentation.servers.size).toBe(0);
  });

  it("concurrent retries reuse one presentation and reject a conflicting target", async () => {
    const f = await fixture(); let finish!: () => void, started!: () => void;
    const showing = new Promise<void>((resolve) => { started = resolve; });
    f.presentation.showBrowser = () => { started(); return new Promise<void>((resolve) => { finish = resolve; }); };
    const first = f.presentation.open(f.worker, { artifactPath: "game" }); await showing;
    const retry = f.presentation.open(f.worker, { artifactPath: "game" });
    await expect(f.presentation.open(f.worker, { url: "http://localhost:9999" })).rejects.toThrow(/另一结果/);
    finish(); expect(await retry).toEqual(await first); expect(f.tabs.length).toBe(1); expect(f.presentation.servers.size).toBe(1);
  });

  it("preparing a result leaves the conversation visible until its preview is opened", async () => {
    const f = await fixture(), value = (await f.presentation.open(f.worker, { artifactPath: "game" }, { reveal: false }))!;
    expect(f.shown()).toBe(0); expect(value.visible).toBe(false);
    await f.presentation.open({ ...f.worker, presentation: value }, { artifactPath: "game" });
    expect(f.shown()).toBe(1); expect(f.tabs.length).toBe(1);
  });
});
