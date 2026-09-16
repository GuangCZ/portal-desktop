// The tool browser's chrome, ported from BeingDesktop 0.8.26
// renderer/desktop-tools.js `renderBrowser()` and `layout()` on 2026-09-16.
//
// The page itself is NOT here. `DesktopBrowser` renders into a native
// `WebContentsView` the main process attaches over this panel, so what this
// component draws is the frame around a hole: tabs, the address row, and an empty
// state that shows through the hole while no page is loaded. `#tools-browser-host`
// is the hole, and its rectangle is what `browserView` sends.
//
// The DOM ids are all `tools-` prefixed. The shell's own single-tab browser
// (desktop/renderer/browser/page.tsx) already owns `browser-address`,
// `browser-back`, `browser-forward`, `browser-reload` and `browser-panel`, and
// two elements with one id is a bug that only shows up in whichever test queries
// first — see docs/migration/i2-tools.md「决定与偏差」.
import { useEffect, useLayoutEffect, useRef } from "react";
import type { ToolsModel } from "../models/tools";

export function ToolsBrowserBar({ model }: { model: ToolsModel }) {
  const host = useRef<HTMLDivElement>(null);
  const address = useRef<HTMLInputElement>(null);
  const active = model.activeTab;

  const send = () => {
    const element = host.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    // Anything the shell puts on top of the panel has to hide the native view as
    // well, or it floats above the dialog. A `dialog[open]` covers the settings
    // sheets, the Town composer and the search box; `document.hidden` covers the
    // window being minimised or on another desktop.
    model.browserView(rect, document.hidden || Boolean(document.querySelector("dialog[open]")));
  };

  // Sent after every layout that could have moved it: the panel opening, the
  // mode changing, the divider dragging, a tab becoming active. The model drops a
  // rectangle identical to the last one, so a render that changed nothing costs
  // one measurement and no IPC.
  useLayoutEffect(send);

  // Deliberately keyed on the model alone. `send` closes over two stable refs and
  // the model, and reads everything else off it at call time, so the observers
  // are installed once — re-creating a subtree MutationObserver on document.body
  // every render would be a real cost.
  useEffect(() => {
    let scheduled = 0;
    const layout = () => {
      if (!scheduled)
        scheduled = requestAnimationFrame(() => {
          scheduled = 0;
          send();
        });
    };
    const resize = new ResizeObserver(layout);
    if (host.current) resize.observe(host.current);
    // A dialog opening or closing changes nothing this component renders, so
    // only the DOM itself can report it.
    const mutation = new MutationObserver(layout);
    mutation.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "hidden"] });
    window.addEventListener("resize", layout);
    document.addEventListener("visibilitychange", layout);
    return () => {
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener("resize", layout);
      document.removeEventListener("visibilitychange", layout);
      cancelAnimationFrame(scheduled);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  return (
    <section className="tools-pane" id="tools-browser-pane" role="tabpanel" aria-labelledby="tools-browser-mode" hidden={model.mode !== "browser"}>
      <div className="browser-tab-strip">
        <div className="browser-tabs" id="tools-browser-tabs" role="tablist" aria-label="网页标签">
          {model.state.browser.tabs.map((tab) => (
            <div className={`browser-tab${tab.id === model.state.browser.activeTabId ? " active" : ""}`} key={tab.id}>
              <button
                type="button"
                role="tab"
                aria-selected={tab.id === model.state.browser.activeTabId}
                title={tab.title || "新标签页"}
                data-tab-action={`select:${tab.id}`}
                onClick={() => void model.act({ action: "browser.activate", value: tab.id })}
              >
                {tab.isLoading ? "◦ " : ""}
                {tab.title || "新标签页"}
              </button>
              <button
                type="button"
                className="browser-tab-close"
                aria-label={`关闭 ${tab.title || "新标签页"}`}
                data-tab-action={`close:${tab.id}`}
                onClick={() => void model.act({ action: "browser.close", value: tab.id })}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <button type="button" className="icon-button compact" id="tools-browser-new" aria-label="新建标签页" onClick={() => void model.act({ action: "browser.new" })}>
          ＋
        </button>
      </div>
      <form
        className="browser-address-row"
        id="tools-browser-address-form"
        onSubmit={(event) => {
          event.preventDefault();
          address.current?.blur();
          void model.submitAddress();
        }}
      >
        <button type="button" className="icon-button compact" id="tools-browser-back" aria-label="后退" disabled={!active?.canGoBack} onClick={() => void model.act({ action: "browser.back" })}>
          ←
        </button>
        <button type="button" className="icon-button compact" id="tools-browser-forward" aria-label="前进" disabled={!active?.canGoForward} onClick={() => void model.act({ action: "browser.forward" })}>
          →
        </button>
        <button
          type="button"
          className="icon-button compact"
          id="tools-browser-reload"
          aria-label={active?.isLoading ? "停止加载" : "刷新网页"}
          disabled={!active?.url}
          onClick={() => void model.act({ action: active?.isLoading ? "browser.stop" : "browser.reload" })}
        >
          {active?.isLoading ? "×" : "↻"}
        </button>
        <label className="visually-hidden" htmlFor="tools-browser-address">
          网页地址
        </label>
        <input
          id="tools-browser-address"
          ref={address}
          autoComplete="off"
          spellCheck={false}
          placeholder="输入网址或 localhost:3000"
          value={model.address}
          onChange={(event) => model.editAddress(event.target.value)}
          onFocus={(event) => {
            model.focusAddress(true);
            event.target.select();
          }}
          onBlur={() => model.focusAddress(false)}
        />
        <button type="submit" className="icon-button compact" aria-label="打开网页">
          →
        </button>
      </form>
      <div className="browser-surface" id="tools-browser-host" ref={host}>
        <div className="browser-empty" id="tools-browser-empty" hidden={Boolean(active?.url && !active.error)}>
          <h3 id="tools-browser-empty-title">{active?.error ? "网页未能打开" : "从一个网址开始"}</h3>
          <p id="tools-browser-empty-detail">{active?.error || "在这里浏览资料、打开项目预览，与 Being 并排工作。"}</p>
        </div>
      </div>
      <div className="browser-bottom">
        <span id="tools-browser-load-status" title={active?.error || active?.notice || active?.url || ""}>
          {active?.error || active?.notice || (active?.isLoading ? "正在加载…" : active?.url || "新标签页")}
        </span>
        <span>独立浏览器会话</span>
      </div>
    </section>
  );
}
