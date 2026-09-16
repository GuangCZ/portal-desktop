// Ported from BeingDesktop 0.8.26 test/session-titles.test.cjs (58 lines); 2026-09-16.
// Fixture data is copied verbatim; only the assertion style changes (node:test +
// node:assert/strict -> vitest), and `t.after` becomes `onTestFinished`.
//
// Why a title worker exists at all: `scene_meta.scene_label` measurably reaches the
// Being (it sees `[场景] <label>`, BeingDesktop docs/desktop-message-layer.md §九),
// so a conversation's title is the topic sign it reads on every message.
import { expect, onTestFinished, test } from "vitest";
import { ChatStore } from "../desktop/main/chat/store";
import { SessionTitles, titleInput } from "../desktop/main/chat/titles";

const desktopId = "11111111-1111-4111-8111-111111111111";
const ids = [1, 2, 3, 4].map((n) => `0000000${n}-0000-4000-8000-000000000000`);
/** BeingDesktop src/being-chat.cjs line 63, kept local so this stage does not import
 * the parallel being-chat.ts port. */
const sceneId = (desktop: string, sessionId: string) => `desktop-${desktop}-${sessionId}`;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fixture(generate: (id: string, input: string) => unknown = async () => "会话内容摘要") {
  let saved: unknown;
  let available = "worker-v1";
  const cache = {
    save: async (_: string, value: unknown) => {
      saved = value;
      return true;
    },
    load: async () => saved,
  };
  let store: ChatStore | null = new ChatStore({ desktopId, cache, identityKey: "one" });
  for (const id of ids) store.ensure(id, { title: "新会话" });
  store.setActive(ids[3]);
  await store.apply({
    rows: ids.slice(0, 3).map((id, n) => ({
      seq: n + 1,
      role: "user",
      content: ["修复登录按钮", "增加消息搜索", "整理项目分组"][n],
      scene_id: sceneId(desktopId, id),
    })),
    cursor: 3,
    baseline: true,
  });
  const calls: { id: string; input: string }[] = [];
  const titles = new SessionTitles({
    getStore: () => store,
    available: () => available,
    generate: async (id, input) => {
      calls.push({ id, input });
      return generate(id, input);
    },
    changed: () => {},
  });
  onTestFinished(() => titles.reset());
  return {
    store: store!,
    titles,
    calls,
    cache,
    setStore: (value: ChatStore | null) => {
      store = value;
    },
    ready: (value: string) => {
      available = value;
    },
  };
}

test("backfills each populated session, preserves selection and persists generated titles", async () => {
  const f = await fixture();
  await f.titles.run();
  expect(f.calls.length).toBe(3);
  expect(f.store.summary().active).toBe(ids[3]);
  // The fourth conversation has no rows, so there is nothing to name it from.
  expect(f.store.summary().sessions[3].title).toBe("新会话");
  const restored = new ChatStore({ desktopId, cache: f.cache, identityKey: "one" });
  await restored.load();
  expect(restored.summary().sessions[0].titleSource).toBe("auto");
  await f.titles.run();
  expect(f.calls.length).toBe(3);
});

test("manual names including a manually chosen default title are preserved after reload", async () => {
  const f = await fixture();
  f.store.rename(ids[0], "我的名字");
  f.store.rename(ids[1], "新会话");
  await f.store.touch();
  const restored = new ChatStore({ desktopId, cache: f.cache });
  await restored.load();
  f.setStore(restored);
  await f.titles.run();
  expect(f.calls.map((c) => c.id)).toStrictEqual([ids[2]]);
});

test("a manual rename or deletion while generating cannot be overwritten", async () => {
  let finish: (value: string) => void = () => {};
  const f = await fixture(() => new Promise<string>((resolve) => { finish = resolve; }));
  const running = f.titles.run();
  await tick();
  f.store.rename(ids[0], "用户标题");
  f.store.forget(ids[1]);
  f.store.rename(ids[2], "保持");
  finish("过期结果");
  await running;
  expect(f.store.summary().sessions[0].title).toBe("用户标题");
  expect(f.calls.length).toBe(1);
});

test("identity reset discards an in-flight result and stops the old queue", async () => {
  let finish: (value: string) => void = () => {};
  const f = await fixture(() => new Promise<string>((resolve) => { finish = resolve; }));
  const running = f.titles.run();
  await tick();
  f.titles.reset();
  f.setStore(null);
  finish("旧身份标题");
  await running;
  expect(f.store.summary().sessions[0].title).toBe("新会话");
  expect(f.calls.length).toBe(1);
});

test("unavailable workers do no work; failures are deduplicated until availability changes", async () => {
  const f = await fixture(async () => {
    throw new Error("offline");
  });
  f.ready("");
  await f.titles.run();
  expect(f.calls.length).toBe(0);
  f.ready("worker-v1");
  await f.titles.run();
  await f.titles.run();
  expect(f.calls.length).toBe(3);
  f.ready("worker-v2");
  await f.titles.run();
  expect(f.calls.length).toBe(6);
});

test("title input excludes tools and images and redacts URL credentials", () => {
  const input = titleInput([
    { role: "tool", content: "SECRET_TOOL_RESULT" },
    {
      role: "user",
      content: "检查 https://test.example/?token=SECRET_TOKEN",
      images: [{ data: "SECRET_IMAGE" }],
    },
  ]);
  expect(input).toMatch(/检查/);
  expect(input).not.toMatch(/SECRET/);
  expect(input.length <= 4000).toBe(true);
  // A conversation the human has not spoken in yet has nothing to name it from.
  expect(titleInput([{ role: "being", content: "hello" }])).toBe("");
});
