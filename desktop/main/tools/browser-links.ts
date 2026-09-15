// Ported line by line from BeingDesktop 0.8.26 src/browser-links.cjs on 2026-09-16.
// External links and denied native popups become tabs of the built-in browser.
// `normalizeBrowserUrl` lives in src/desktop-browser.cjs, which another unit owns,
// so it is injected here. See docs/architecture.md §7「Loom 视图」外链转内置浏览器.
import type { BrowserTabOpener, NormalizeBrowserUrl } from './types';

export interface BrowserLinksOptions {
  getBrowser: () => BrowserTabOpener;
  showBrowser: () => void;
  isCurrent?: () => boolean;
  onError?: (error: Error) => void;
  normalizeUrl: NormalizeBrowserUrl;
}
export interface BrowserLinks {
  open(url: unknown): { opened: true; tabId: string | null };
  tryOpen(url: unknown): boolean;
  popup(details: { url: string }): { action: 'deny' };
}

export function createBrowserLinks({getBrowser, showBrowser, isCurrent = () => true, onError = () => {}, normalizeUrl}: BrowserLinksOptions): BrowserLinks {
  function open(url: unknown) {
    if (!isCurrent()) throw new Error('当前页面已关闭，无法打开网页。');
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('仅支持在内置浏览器中打开 HTTP 和 HTTPS 网页。');
    const target = normalizeUrl(url);
    const snapshot = getBrowser().newTab({url:target});
    showBrowser();
    return {opened:true as const,tabId:snapshot.activeTabId};
  }
  function tryOpen(url: unknown) {
    if (!isCurrent()) return false;
    try { open(url); return true; }
    catch (error) { onError(error as Error); return false; }
  }
  function popup(details: { url: string }) {
    // Create the tab after Electron finishes denying the separate native window.
    queueMicrotask(() => tryOpen(details.url));
    return {action:'deny' as const};
  }
  return {open,tryOpen,popup};
}
