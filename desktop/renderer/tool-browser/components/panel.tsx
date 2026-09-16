// The tool browser panel; 2026-09-16.
//
// Layout mirrors renderer/browser/page.tsx, the shell browser's panel, because
// the mechanism is the same: the page is a native `WebContentsView` the main
// process attaches to the window, so this element is a placeholder whose
// rectangle has to be reported on every layout change — a resize, a scroll of the
// workspace, a dialog opening over it. What differs is everything behind it: a
// tab strip instead of one page, and a partition a Being may drive.
//
// Address entry is `normalizeBrowserUrl`'s (main/tools/browser/browser.ts):
// bare text is REFUSED rather than turned into `https://<text>`, which is what
// the shell browser's `browserURL` does. The two are not interchangeable — a
// Being must not be able to turn an arbitrary string into a navigation.
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useModel } from "../../shared/hooks/use-model";
import type { ToolBrowserModel } from "../models/tool-browser";

export function ToolBrowserPanel({ model }: { model: ToolBrowserModel }) {
  const browser = useModel(model);
  const panel = useRef<HTMLElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const sendBounds = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    const { x, y, width, height } = element.getBoundingClientRect();
    browser.setViewport({ x, y, width, height }, !panel.current?.hidden && !document.querySelector("dialog[open]"));
  }, [browser]);

  useLayoutEffect(sendBounds, [sendBounds, browser.state.activeTabId, browser.tabs.length]);
  useEffect(() => {
    let scheduled = 0;
    const layout = () => {
      if (scheduled) return;
      scheduled = requestAnimationFrame(() => { scheduled = 0; sendBounds(); });
    };
    const resize = new ResizeObserver(layout);
    if (viewport.current) resize.observe(viewport.current);
    // A dialog opening over the workspace must hide the native view; nothing in
    // the DOM tells us except the attribute itself.
    const mutation = new MutationObserver(layout);
    mutation.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "hidden"] });
    window.addEventListener("resize", layout);
    return () => {
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener("resize", layout);
      cancelAnimationFrame(scheduled);
    };
  }, [sendBounds]);

  const active = browser.active;
  return (
    <aside id="tool-browser-panel" className="tool-browser-panel" ref={panel} aria-label="Being 工具浏览器">
      <div className="tool-browser-tabs" role="tablist" aria-label="工具浏览器标签页">
        {browser.tabs.map(tab => (
          <div key={tab.id} className={`tool-browser-tab${tab.id === browser.state.activeTabId ? " active" : ""}`}>
            <button
              type="button"
              className="tool-browser-tab-select"
              role="tab"
              aria-selected={tab.id === browser.state.activeTabId}
              title={`${tab.title || "新标签页"}\n${tab.url}`}
              onClick={() => browser.activateTab(tab.id)}
            >
              {tab.isLoading && <span className="tool-browser-tab-loading" aria-hidden="true" />}
              <span className="tool-browser-tab-title">{tab.title || tab.url || "新标签页"}</span>
            </button>
            <button
              type="button"
              className="tool-browser-icon"
              aria-label="关闭标签页"
              onClick={() => browser.closeTab(tab.id)}
            >
              ×
            </button>
          </div>
        ))}
        <button type="button" className="tool-browser-icon" aria-label="新建标签页" onClick={() => browser.newTab()}>+</button>
        <span className="tool-browser-spacer" />
        <button type="button" className="tool-browser-icon" aria-label="收起浏览器" onClick={() => browser.hide()}>×</button>
      </div>
      <form
        className="tool-browser-address"
        onSubmit={event => { event.preventDefault(); input.current?.blur(); browser.submit(); }}
      >
        <button type="button" className="tool-browser-icon" aria-label="后退" disabled={!active?.canGoBack} onClick={() => browser.goBack()}>←</button>
        <button type="button" className="tool-browser-icon" aria-label="前进" disabled={!active?.canGoForward} onClick={() => browser.goForward()}>→</button>
        <button
          type="button"
          className="tool-browser-icon"
          aria-label={active?.isLoading ? "停止加载" : "刷新网页"}
          disabled={!active}
          onClick={() => (active?.isLoading ? browser.stop() : browser.reload())}
        >
          {active?.isLoading ? "×" : "↻"}
        </button>
        <input
          ref={input}
          aria-label="网页地址"
          placeholder="输入完整网址，例如 https://example.com"
          autoComplete="off"
          spellCheck={false}
          value={browser.address}
          onChange={event => browser.setAddress(event.target.value)}
          /* While the field has focus the model stops following the active tab, so
             a page that navigates underneath does not rewrite what is being typed
             — BeingDesktop's `document.activeElement!==$('browser-address')` test
             (renderer/desktop-tools.js). Focus also selects, as it does there, so
             typing over the current address is one keystroke. */
          onFocus={event => { browser.setEditing(true); event.currentTarget.select(); }}
          onBlur={() => browser.setEditing(false)}
        />
        <button type="submit" className="secondary">前往</button>
      </form>
      <div className="tool-browser-viewport" ref={viewport}>
        <p className="tool-browser-message" role="status">
          {active?.error || active?.notice || browser.unavailable
            || (active ? "" : "Being 可以读取和操作这个浏览器里的页面。它与上方的浏览器互不共享登录状态。")}
        </p>
      </div>
    </aside>
  );
}
