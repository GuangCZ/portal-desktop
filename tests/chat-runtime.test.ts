import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatState } from "../desktop/renderer/chat/models/chat";
import { createChatRuntime } from "../desktop/renderer/chat/services/runtime";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Markdown,
  markdownText,
} from "../desktop/renderer/shared/components/markdown";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("location", new URL("https://fixture.test/loom.html"));
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { visibilityState: "visible" }),
  );
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) =>
    setTimeout(fn, 16),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const response = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("React chat runtime lifecycle", () => {
  it("initializes once and aborts requests and every scheduled resource on disposal", async () => {
    const calls: { url: string; signal: AbortSignal }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, signal: init.signal! });
        if (url.includes("/history")) return response({ messages: [] });
        if (url.includes("/stream/active"))
          return new Response(null, { status: 204 });
        if (url.includes("/llm/config"))
          return response({ sbs_enabled: false });
        if (url.endsWith("/health")) return new Response("OK fixture");
        return response({ name: "fixture" });
      }),
    );
    const state = new ChatState(),
      runtime = createChatRuntime(state);
    await runtime.start();
    await flush();
    await runtime.start();
    expect(calls.filter((call) => call.url.includes("/history"))).toHaveLength(
      1,
    );
    expect(state.sbsEnabled).toBe(false);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    runtime.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(calls.every((call) => call.signal.aborted)).toBe(true);
    const count = calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(calls).toHaveLength(count);
  });

  it("keeps a retry cancellation signal across POST attempts and stops during backoff", async () => {
    let attempts = 0;
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (!url.includes("/chat/stream")) return response({ messages: [] });
        attempts++;
        signals.push(init.signal!);
        throw new TypeError("offline");
      }),
    );
    const state = new ChatState(),
      runtime = createChatRuntime(state);
    const sending = runtime.send("one message");
    await flush();
    expect(attempts).toBe(1);
    await runtime.stopCurrentTurn();
    await sending;
    await vi.advanceTimersByTimeAsync(8000);
    expect(attempts).toBe(1);
    expect(signals[0].aborted).toBe(true);
    expect(state.streaming).toBe(false);
    expect(
      state.items.filter(
        (item) => item.kind === "message" && item.role === "user",
      ),
    ).toHaveLength(1);
    runtime.dispose();
  });

  it("ignores a stale initial SBS read after a confirmed toggle", async () => {
    let finishRead!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        if (init.method === "PATCH")
          return response({ ok: true, config: { sbs_enabled: false } });
        return new Promise<Response>((resolve) => {
          finishRead = resolve;
        });
      }),
    );
    const state = new ChatState(),
      runtime = createChatRuntime(state);
    const read = runtime.loadSbsState();
    await flush();
    await runtime.toggleSbs();
    finishRead(response({ sbs_enabled: true }));
    await read;
    expect(state.sbsEnabled).toBe(false);
    expect(state.sbsKnown).toBe(true);
    runtime.dispose();
  });
});

describe("React Markdown boundary", () => {
  it("renders tables, highlighted code and text without executable HTML or unsafe links", () => {
    const content =
      '```javascript\nconst message = "<img onerror=alert(1)>";\n```\n\n| One | Two |\n| --- | --- |\n| A | B |\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n[x](https://user:password@example.com)';
    const html = renderToStaticMarkup(
      createElement(Markdown, { content, chat: true }),
    );
    expect(html).toContain("<table>");
    expect(html).toContain("hljs-keyword");
    expect(html).not.toMatch(
      /<script|<img|href="javascript:|href="https:\/\/user:/,
    );
    expect(html).toContain("&lt;script&gt;");
  });
  it("keeps code references inert and decorates only the first eligible place mention", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        content: "`seeds`\n\nseeds and seeds",
        chat: true,
        onPlace: () => {},
      }),
    );
    expect(html.match(/class="chat-place-link"/g)).toHaveLength(1);
    expect(html).toContain("<code>seeds</code>");
    expect(markdownText("**标题** &amp; [链接](https://example.com)")).toBe(
      "标题 & 链接",
    );
  });
});
