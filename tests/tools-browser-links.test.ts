// Ported line by line from BeingDesktop 0.8.26 test/browser-links.test.cjs on 2026-09-16.
// `normalizeUrl` stands in for normalizeBrowserUrl (src/desktop-browser.cjs, owned by the
// browser unit); the fixture copies that function and navigationUrl verbatim.
import { describe, expect, it } from "vitest";
import { createBrowserLinks } from "../desktop/main/tools/browser-links";
import type { BrowserTabOpener } from "../desktop/main/tools/types";

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
function normalizeBrowserUrl(value: string) {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError("请输入有效的网页地址。");
  const input = value.trim();
  if (/^https?:\/\//i.test(input)) return navigationUrl(input);
  // Only hostname-like address input receives a scheme; arbitrary text is not executed or searched.
  if (/^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?(?:[/?#]|$)/i.test(input)) return navigationUrl(`http://${input}`);
  if (/^(?:[a-z0-9\u0080-\uffff](?:[a-z0-9\u0080-\uffff-]*[a-z0-9\u0080-\uffff])?\.)+[a-z0-9\u0080-\uffff-]+(?::\d{1,5})?(?:[/?#]|$)/i.test(input)) return navigationUrl(`https://${input}`);
  throw new TypeError("请输入 HTTP 或 HTTPS 地址，例如 localhost:3000。");
}

function fixture() {
  const opened: { url?: string }[] = [], errors: Error[] = [];
  let current = true, shown = 0, failure: Error | undefined;
  const links = createBrowserLinks({
    getBrowser: () => ({ newTab(options) {
      if (failure) throw failure;
      opened.push(options);
      return { activeTabId: `tab-${opened.length}` };
    } } as BrowserTabOpener),
    showBrowser: () => { shown++; },
    isCurrent: () => current,
    onError: (error) => errors.push(error),
    normalizeUrl: normalizeBrowserUrl,
  });
  return { links, opened, errors, shown: () => shown, close: () => { current = false; }, fail: (error: Error) => { failure = error; } };
}

describe("external link handling", () => {
  it("web entries create an internal tab and bring the browser into view", () => {
    const item = fixture();
    expect(item.links.open("https://example.com/docs")).toEqual({ opened: true, tabId: "tab-1" });
    expect(item.opened).toEqual([{ url: "https://example.com/docs" }]);
    expect(item.shown()).toBe(1);
    expect(item.links.tryOpen("http://127.0.0.1:3000/preview")).toBe(true);
    expect(item.opened[1].url).toBe("http://127.0.0.1:3000/preview");
  });

  it("links cannot execute non-web protocols or inject URL credentials", () => {
    const item = fixture();
    for (const url of ["javascript:alert(1)", "file:///C:/private", "being://app/index.html", "mailto:person@example.com", "about:blank", "example.com", "https://user:secret@example.com", "https://example.com/\n", null]) {
      expect(() => item.links.open(url)).toThrow();
    }
    expect(item.opened.length).toBe(0);
    expect(item.shown()).toBe(0);
  });

  it("popups are denied as native windows and opened without a referrer in a browser tab", async () => {
    const item = fixture();
    expect(item.links.popup({ url: "https://example.com/story", referrer: { url: "https://loom.example/being?token=secret" } } as { url: string })).toEqual({ action: "deny" });
    expect(item.opened.length).toBe(0);
    await Promise.resolve();
    expect(item.opened).toEqual([{ url: "https://example.com/story" }]);
  });

  it("a connection change cancels a queued popup before it creates a tab", async () => {
    const item = fixture();
    item.links.popup({ url: "https://example.com" });
    item.close();
    await Promise.resolve();
    expect(item.opened.length).toBe(0);
    expect(item.links.tryOpen("https://example.com")).toBe(false);
    expect(item.errors.length).toBe(0);
  });

  it("tab creation failures are reported without switching to an empty browser", () => {
    const item = fixture();
    item.fail(new Error("Tab limit reached"));
    expect(item.links.tryOpen("https://example.com")).toBe(false);
    expect(item.errors[0].message).toBe("Tab limit reached");
    expect(item.shown()).toBe(0);
  });
});
