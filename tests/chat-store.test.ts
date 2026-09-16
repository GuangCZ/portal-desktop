// Ported from BeingDesktop 0.8.26 test/chat-store.test.cjs (245 lines); 2026-09-16.
// Fixture data is copied verbatim; only the assertion style changes (node:test +
// node:assert/strict -> vitest). The invariants under test are BeingDesktop
// docs/desktop-message-layer.md 六「必须照抄的不变量」items 3-5, mirrored from
// Loom's IndexedDB cache (loom.html:3620 / 3600 / 3660).
import { expect, test } from "vitest";
import { ChatStore, snapshot } from "../desktop/main/chat/store";
import type {
  ChatCacheLike,
  ChatSnapshot,
  StoreSummary,
} from "../desktop/main/chat/types";

const DESKTOP = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
/** BeingDesktop src/being-chat.cjs line 63. Kept local so this stage does not
 * import the parallel being-chat.ts port; every id below is a valid UUID, so the
 * original's argument validation has nothing to reject here. */
const sceneId = (desktopId: string, sessionId: string) =>
  `desktop-${desktopId}-${sessionId}`;
const sceneA = sceneId(DESKTOP, A),
  sceneB = sceneId(DESKTOP, B);
const row = (seq: number, scene: string, content = "x", role = "assistant") => ({
  seq,
  role,
  content,
  at: "2026-09-11T00:00:00Z",
  ...(scene ? { scene_id: scene } : {}),
});

function fixture({ fail = false, disk = null }: { fail?: boolean; disk?: unknown } = {}) {
  const saves: { identityKey: string; value: ChatSnapshot }[] = [];
  let stored: unknown = disk;
  const cache: ChatCacheLike = {
    load: async () => stored,
    save: async (identityKey, value) => {
      saves.push({ identityKey, value });
      if (fail) return false;
      stored = value;
      return true;
    },
  };
  const changes: StoreSummary[] = [];
  const store = new ChatStore({
    cache,
    identityKey: "https://echo.beings.town/cz_being",
    desktopId: DESKTOP,
    clock: () => 1757000000000,
    onChange: (value) => changes.push(value),
  });
  return { store, saves, changes, disk: () => stored as ChatSnapshot | null };
}

test("nothing is persisted before a baseline exists", async () => {
  const f = fixture();
  await f.store.load();
  // Invariant 2: a five-row cursor sync must not become the whole of the persisted history.
  const result = await f.store.apply({ rows: [row(11, sceneA)], cursor: 11 });
  expect(result.stored).toBe(1);
  expect(result.persisted).toBe(false);
  expect(f.saves).toEqual([]);
  // The rows are still usable in memory; only the disk waits for a baseline.
  expect(f.store.rows(A).map((item) => item.seq)).toStrictEqual([11]);
  expect(f.store.cursor).toBe(11);
  expect(f.store.seeded).toBe(false);
  const seeded = await f.store.apply({ rows: [row(12, sceneA)], cursor: 12, baseline: true });
  expect(seeded.persisted).toBe(true);
  expect(f.store.seeded).toBe(true);
  // A baseline replaces rather than merges: the earlier increment is not smuggled in.
  expect(f.store.rows(A).map((item) => item.seq)).toStrictEqual([12]);
});

test("rows and the cursor are persisted as one replacement", async () => {
  const f = fixture();
  await f.store.load();
  await f.store.apply({ rows: [row(5, sceneA)], cursor: 5, baseline: true });
  await f.store.apply({ rows: [row(7, sceneB)], cursor: 7 });
  // Invariant 1: every write carries both, so a cursor can never outrun the rows it counted.
  const written = f.saves.at(-1)!.value;
  expect(written.cursor).toBe(7);
  expect(
    written.sessions.map((session) => [session.id, session.rows.map((item) => item.seq)]),
  ).toStrictEqual([
    [A, [5]],
    [B, [7]],
  ]);
});

test("the cursor only moves forward", async () => {
  const f = fixture();
  await f.store.load();
  await f.store.apply({ rows: [row(50, sceneA)], cursor: 50, baseline: true });
  const back = await f.store.apply({ rows: [], cursor: 10 });
  expect(back.cursor).toBe(50);
  expect(f.store.cursor).toBe(50);
});

test("one page fans out to the conversations it names and skips the rest", async () => {
  const f = fixture();
  await f.store.load();
  const result = await f.store.apply({
    baseline: true,
    cursor: 20,
    rows: [
      row(11, sceneA, "A 问", "user"),
      row(12, sceneA, "A 答"),
      row(13, sceneB, "B 答"),
      row(14, "loom-being", "别的客户端"),
      row(15, sceneId(A, B), "别的 Desktop"),
      { seq: 16, role: "user", content: "[breath yielded to human]", from: "system" },
      { seq: 0, role: "user", content: "坏行" },
    ],
  });
  expect(result.stored).toBe(3);
  expect(result.skipped).toBe(4);
  expect(f.store.rows(A).map((item) => [item.seq, item.role])).toStrictEqual([
    [11, "user"],
    [12, "being"],
  ]);
  expect(f.store.rows(B).map((item) => item.seq)).toStrictEqual([13]);
  // Unroutable rows still advance the cursor, or every read would fetch them again forever.
  expect(f.store.cursor).toBe(20);
});

test("a conversation seen only in history joins the list", async () => {
  const f = fixture();
  await f.store.load();
  await f.store.apply({ rows: [row(9, sceneB)], cursor: 9, baseline: true });
  expect(f.store.summary().sessions.map((session) => session.id)).toStrictEqual([B]);
});

test("rows merge in seq order, and a re-read replaces rather than duplicates", async () => {
  const f = fixture();
  await f.store.load();
  await f.store.apply({ rows: [row(30, sceneA, "三十")], cursor: 30, baseline: true });
  await f.store.apply({
    rows: [row(10, sceneA, "十"), row(20, sceneA, "二十"), row(30, sceneA, "三十改")],
    cursor: 30,
  });
  expect(f.store.rows(A).map((item) => [item.seq, item.content])).toStrictEqual([
    [10, "十"],
    [20, "二十"],
    [30, "三十改"],
  ]);
});

test("a reloaded store resumes from its stored cursor and transcripts", async () => {
  const f = fixture();
  await f.store.load();
  await f.store.apply({ rows: [row(41, sceneA, "记住我")], cursor: 41, baseline: true });
  f.store.rename(A, "会话一");
  f.store.setActive(A);
  await f.store.touch();
  const again = fixture({ disk: f.disk() });
  const summary = await again.store.load();
  expect(summary.cursor).toBe(41);
  expect(summary.seeded).toBe(true);
  expect(summary.active).toBe(A);
  expect(summary.sessions).toStrictEqual([
    {
      id: A,
      title: "会话一",
      titleSource: "manual",
      createdAt: 1757000000000,
      updatedAt: "2026-09-11T00:00:00Z",
      truncated: false,
      count: 1,
      lastSeq: 41,
    },
  ]);
  expect(again.store.rows(A).map((item) => item.content)).toStrictEqual(["记住我"]);
});

test("a corrupt or inconsistent file is a cache miss, not a startup failure", async () => {
  for (const disk of [
    { version: 2, cursor: 1, seeded: true, sessions: [] },
    { version: 1, cursor: -1, seeded: true, sessions: [] },
    // A cursor behind its own rows is the corruption invariant 1 exists to prevent.
    { version: 1, cursor: 5, seeded: true, sessions: [{ id: A, rows: [{ seq: 9, role: "user", content: "x" }] }] },
    {
      version: 1,
      cursor: 9,
      seeded: true,
      sessions: [{ id: A, rows: [{ seq: 2, role: "user", content: "x" }, { seq: 1, role: "user", content: "y" }] }],
    },
    { version: 1, cursor: 9, seeded: true, sessions: [{ id: A, rows: [] }, { id: A, rows: [] }] },
    { version: 1, cursor: 9, seeded: "yes", sessions: [] },
  ]) {
    const f = fixture({ disk });
    const summary = await f.store.load();
    expect(summary.cursor, JSON.stringify(disk)).toBe(0);
    expect(summary.seeded).toBe(false);
  }
  // Only `load` is reached here, so the rest of the cache contract is not supplied.
  const thrown = new ChatStore({
    cache: {
      load: async () => {
        throw new Error("unreadable");
      },
    } as unknown as ChatCacheLike,
    desktopId: DESKTOP,
  });
  expect((await thrown.load()).cursor).toBe(0);
});

test("a store with no cache at all still works in memory", async () => {
  const store = new ChatStore({ desktopId: DESKTOP });
  await store.load();
  const result = await store.apply({ rows: [row(3, sceneA)], cursor: 3, baseline: true });
  expect(result.persisted).toBe(false);
  expect(store.degraded).toBe(false);
  expect(store.rows(A).map((item) => item.seq)).toStrictEqual([3]);
  expect(() => new ChatStore({ desktopId: "nope" })).toThrow(TypeError);
});

test("a failed write is reported and leaves the previous file intact", async () => {
  const f = fixture({ fail: true });
  await f.store.load();
  expect((await f.store.apply({ rows: [row(4, sceneA)], cursor: 4, baseline: true })).persisted).toBe(false);
  expect(f.store.degraded).toBe(true);
  expect(await f.store.flush()).toBe(false);
  expect(f.disk()).toBe(null);
  // Memory keeps serving, so a machine without encryption is degraded rather than broken.
  expect(f.store.rows(A).map((item) => item.seq)).toStrictEqual([4]);
});

test("conversations can be opened, renamed, activated and forgotten", async () => {
  const f = fixture();
  await f.store.load();
  f.store.ensure(A, { title: "一" });
  f.store.ensure(B);
  expect(f.store.rename(B, "二")).toBe(true);
  expect(f.store.rename("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "x")).toBe(false);
  expect(f.store.setActive(B)).toBe(true);
  expect(f.store.summary().sessions.map((session) => session.title)).toStrictEqual(["一", "二"]);
  expect(f.store.forget(B)).toBe(true);
  expect(f.store.summary().active).toBe("");
  expect(f.store.forget(B)).toBe(false);
  // Forgetting never rewinds the cursor: that would re-deliver every other conversation's rows.
  await f.store.apply({ rows: [row(60, sceneA)], cursor: 60, baseline: true });
  f.store.forget(A);
  expect(f.store.cursor).toBe(60);
  expect(() => f.store.ensure("not-a-uuid")).toThrow(TypeError);
});

test("an oversized transcript gives up age, keeps the conversation, and says so", async () => {
  const f = fixture();
  await f.store.load();
  const big = Array.from({ length: 120 }, (unused, index) => row(index + 1, sceneA, "x".repeat(90000)));
  await f.store.apply({ rows: big, cursor: 120, baseline: true });
  const written = f.saves.at(-1)!.value;
  expect(written.sessions[0].truncated).toBe(true);
  expect(written.sessions[0].rows.length < 120).toBe(true);
  // The newest rows are the ones kept, and the cursor is unaffected by trimming.
  expect(written.sessions[0].rows.at(-1)!.seq).toBe(120);
  expect(written.cursor).toBe(120);
  expect(f.store.summary().sessions[0].truncated).toBe(true);
});

test("a conversation keeps only its most recent rows", async () => {
  const f = fixture();
  await f.store.load();
  await f.store.apply({
    rows: Array.from({ length: 340 }, (unused, index) => row(index + 1, sceneA, "x")),
    cursor: 340,
    baseline: true,
  });
  const rows = f.store.rows(A);
  expect(rows.length).toBe(300);
  expect(rows[0].seq).toBe(41);
  expect(rows.at(-1)!.seq).toBe(340);
  expect(f.store.summary().sessions[0].truncated).toBe(true);
});

test("the snapshot validator is the contract, not a cleanup pass", () => {
  expect(snapshot({ version: 1, cursor: 0, seeded: false, sessions: [] })!.active).toBe("");
  expect(snapshot({ version: 1, cursor: 1, seeded: true, active: A, sessions: [{ id: A, rows: [] }] })!.active).toBe(A);
  // An active id naming no conversation is dropped rather than rejecting the file.
  expect(snapshot({ version: 1, cursor: 1, seeded: true, active: B, sessions: [{ id: A, rows: [] }] })!.active).toBe("");
  expect(snapshot({ version: 1, cursor: 1, seeded: true, sessions: [{ id: "x", rows: [] }] })).toBe(null);
  expect(snapshot(null)).toBe(null);
});

test("concurrent applies serialize into ordered writes", async () => {
  const f = fixture();
  await f.store.load();
  await f.store.apply({ rows: [row(1, sceneA)], cursor: 1, baseline: true });
  await Promise.all([
    f.store.apply({ rows: [row(2, sceneA)], cursor: 2 }),
    f.store.apply({ rows: [row(3, sceneA)], cursor: 3 }),
  ]);
  expect(await f.store.flush()).toBe(true);
  expect(f.saves.map((save) => save.value.cursor)).toStrictEqual([1, 2, 3]);
  expect(f.disk()!.cursor).toBe(3);
});

// History never returns images (measured 2026-09-11): a row's previews are a local annotation,
// attached when the message is confirmed and kept through every re-read of the row.
test("image previews attach to a durable row and survive a re-read and a fresh baseline", async () => {
  const f = fixture();
  await f.store.load();
  await f.store.apply({
    rows: [row(10, sceneA, "看看这张图", "user"), row(11, sceneA, "黄底绿圆")],
    cursor: 11,
    baseline: true,
  });
  const thumb = `data:image/jpeg;base64,${Buffer.from("jpeg").toString("base64")}`;
  expect(
    f.store.attach(A, 10, [
      { media_type: "image/png", name: "probe.png", thumb },
      { media_type: "image/gif" },
      { media_type: "text/plain" },
      null,
      { media_type: "image/png", thumb: "javascript:alert(1)" },
    ]),
  ).toBe(true);
  expect(f.store.rows(A)[0].images).toStrictEqual([
    { media_type: "image/png", name: "probe.png", thumb },
    { media_type: "image/gif" },
    { media_type: "image/png" },
  ]);
  // Attaching is idempotent per row, and refuses rows that are not there.
  expect(f.store.attach(A, 10, [{ media_type: "image/png" }])).toBe(false);
  expect(f.store.attach(A, 99, [{ media_type: "image/png" }])).toBe(false);
  expect(f.store.attach(B, 10, [{ media_type: "image/png" }])).toBe(false);
  await f.store.flush();
  expect(f.disk()!.sessions[0].rows[0].images![0]).toStrictEqual({
    media_type: "image/png",
    name: "probe.png",
    thumb,
  });
  // The row comes back from history without images; the previews stay with it.
  await f.store.apply({
    rows: [row(10, sceneA, "看看这张图", "user"), row(12, sceneA, "还有吗", "user")],
    cursor: 12,
  });
  expect(f.store.rows(A)[0].images!.length).toBe(3);
  await f.store.apply({
    rows: [row(10, sceneA, "看看这张图", "user"), row(11, sceneA, "黄底绿圆")],
    cursor: 12,
    baseline: true,
  });
  expect(f.store.rows(A)[0].images!.length).toBe(3);
  expect(f.store.rows(A)[1].images).toBe(undefined);
  // A reload validates the previews like everything else.
  const g = fixture({ disk: f.disk() });
  await g.store.load();
  expect(g.store.rows(A)[0].images!.length).toBe(3);
  const rows = f.store.rows(A);
  rows[0].images![0].name = "mutated";
  expect(f.store.rows(A)[0].images![0].name).toBe("probe.png");
});

test("previews that do not fit are dropped, never the row they annotate", async () => {
  const f = fixture();
  await f.store.load();
  await f.store.apply({ rows: [row(10, sceneA, "图", "user")], cursor: 10, baseline: true });
  expect(
    f.store.attach(A, 10, [
      { media_type: "image/png", thumb: `data:image/png;base64,${"A".repeat(64 * 1024)}` },
    ]),
  ).toBe(true);
  expect(f.store.rows(A)[0].images).toStrictEqual([{ media_type: "image/png" }]);
  expect(f.store.attach(A, 10, [])).toBe(false);
  const many = Array.from({ length: 12 }, (_, i) => ({ media_type: "image/png", name: `${i}.png` }));
  await f.store.apply({ rows: [{ ...row(11, sceneA, "多", "user"), images: many }], cursor: 11 });
  expect(f.store.rows(A)[1].images!.length).toBe(8);
  expect(
    snapshot({
      version: 1,
      cursor: 11,
      seeded: true,
      active: "",
      sessions: [
        {
          id: A,
          title: "",
          createdAt: 0,
          truncated: false,
          rows: [{ seq: 1, role: "user", content: "x", at: "", images: "nope" }],
        },
      ],
    })!.sessions[0].rows[0].images,
  ).toBe(undefined);
});

// New in this port: the store is where a user row loses its request-context frame,
// so the durable transcript holds what the human actually said. The frame format is
// BeingDesktop src/orchestration-message.cjs lines 18-37 (ported to chat/frame.ts).
test("a user row is stored without its request context frame", async () => {
  const f = fixture();
  await f.store.load();
  const context = "[Being Desktop 当前消息环境]\n工作区：/tmp/ws\n[/Being Desktop 当前消息环境]";
  const framed = `[Being Desktop request context v1; length=${context.length}]\n${context}\n[/Being Desktop request context v1]\n\n真正的问题`;
  // Heart collapses runs of blank lines, so the declared length can no longer point
  // at the footer; the frame is still recognised and removed.
  const normalized = framed.replace(/\n{3,}/g, "\n\n");
  await f.store.apply({
    rows: [
      row(1, sceneA, framed, "user"),
      row(2, sceneA, normalized, "user"),
      // A Being reply is never unwrapped, and neither is text that only looks framed.
      row(3, sceneA, framed),
      row(4, sceneA, "[Being Desktop request context v1; length=1]\nwrong", "user"),
    ],
    cursor: 4,
    baseline: true,
  });
  expect(f.store.rows(A).map((item) => item.content)).toStrictEqual([
    "真正的问题",
    "真正的问题",
    framed,
    "[Being Desktop request context v1; length=1]\nwrong",
  ]);
});
