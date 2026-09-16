// The composer's two directories; new on 2026-09-16 (integration unit I5).
//
// Ported from BeingDesktop 0.8.26's own contract for `getChatComposerData`
// (src/main.cjs lines 1266 and 1334-1349) and `normalizeComposerData`
// (src/loom-composer.cjs lines 8-49). Every rule below is one the original has:
// which entries are offered, how a handle is made, what a collision does, what a
// failure of one directory does to the other, and what a Being switch during the
// read does to the whole answer.
//
// The normalization is the boundary between two untrusted directories and the
// user's own composer, so the cases that matter most are the ugly ones: a control
// character in a name, an id that is not an id, a duplicate handle, a thousand
// and one entries.
import { expect, test } from "vitest";
import { composerData, memberOptions, normalizeComposerData } from "../desktop/main/chat/composer-data";

// A local Kit as `localKits` answers it. The name is the id the composer
// addresses, and `readKit` already constrains it to
// `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$` — anything else never reaches this layer.
const kit = (name: string, description = "") => ({ name, description, command: ["node", "kit.js"], problem: undefined as string | undefined });

test("the two built-in abilities lead the list and cannot be uninstalled", () => {
  const data = normalizeComposerData();
  expect(data.kits.map(item => [item.handle, item.builtin, item.installed])).toEqual([
    ["search", "search", true],
    ["browse", "browse", true],
  ]);
  expect(data.kits[0].description).toBe("网络搜索 · 搜索互联网并读取网页正文。");
  expect(data.members).toEqual([]);
  // A Kit from the directory that calls itself `search` gets the name, never the
  // ability: `builtin` is decided by identity with the frozen pair above.
  const clash = normalizeComposerData({ kits: [{ id: "search", name: "search", installed: true, builtin: "search" }] });
  expect(clash.kits.map(item => [item.id, item.handle, item.builtin])).toEqual([
    ["being-search", "search", "search"],
    ["being-browse", "browse", "browse"],
    ["search", "search-search", ""],
  ]);
});

test("only an installed Kit is offered, and only under an id that can be addressed", () => {
  const data = normalizeComposerData({
    kits: [
      { id: "not-installed", name: "Uninstalled Market Kit" },
      { id: "fixture-kit", name: "Fixture Tools", description: "测试工具目录", installed: true },
      { id: "bad id", name: "Spaces In Id", installed: true },
      { id: "fixture-kit", name: "Duplicate Id", installed: true },
    ],
  });
  expect(data.kits.map(item => item.id)).toEqual(["being-search", "being-browse", "fixture-kit"]);
  expect(data.kits[2]).toMatchObject({ name: "Fixture Tools", handle: "Fixture-Tools", description: "测试工具目录", installed: true, kind: "kit" });
});

test("a Being is addressed by its Town id, never by its display name", () => {
  const data = normalizeComposerData({ members: [
    { id: "t_hidden_yomi", display_name: "YomiyaHina", bio: "伙伴" },
    { id: "t_twin_a", name: "Twin Name" },
    { id: "t_twin_b", name: "Twin Name" },
  ] });
  expect(data.members.map(item => [item.id, item.handle, item.name])).toEqual([
    ["t_hidden_yomi", "t_hidden_yomi", "YomiyaHina"],
    ["t_twin_a", "t_twin_a", "Twin Name"],
    ["t_twin_b", "t_twin_b", "Twin Name"],
  ]);
  // Two members sharing a display name keep separate entries — the id is the
  // address, so there is nothing to disambiguate.
  expect(data.members[0].description).toBe("伙伴");
  expect(data.members.every(item => item.kind === "member" && item.icon === "")).toBe(true);
});

test("names and descriptions are projected, not trusted", () => {
  const data = normalizeComposerData({
    kits: [{ id: "evil", name: "  <img src=x onerror=alert(1)>\u0000\u001b ", description: "描述".repeat(200), installed: true }],
    members: [{ id: "t_evil", name: "名\u0007字", description: "d".repeat(300) }],
    kitsError: "读取失败\u0000", membersError: "x".repeat(400),
  });
  // Control characters become spaces and the value is trimmed; the markup-looking
  // text survives verbatim, because it is text and the renderer draws it as text.
  expect(data.kits[2].name).toBe("<img src=x onerror=alert(1)>");
  expect(data.kits[2].description.length).toBe(220);
  expect(data.members[0].name).toBe("名 字");
  expect(data.members[0].description.length).toBe(220);
  expect(data.kitsError).toBe("读取失败");
  expect(data.membersError.length).toBe(200);
  // A handle is built from the name: whitespace runs become one hyphen and every
  // character that is not a letter, a digit, `_`, `.` or `-` is dropped — so
  // there is nothing left in it that a `/` token could be confused by.
  expect(data.kits[2].handle).toBe("img-srcx-onerroralert1");
});

test("both directories are capped, so one bad answer cannot flood the menu", () => {
  const many = Array.from({ length: 1200 }, (_item, index) => ({ id: `t_${index}`, name: `M${index}` }));
  expect(normalizeComposerData({ members: many }).members.length).toBe(1000);
  // 1000 including the two built-ins: the cap is applied to the combined list, so
  // a directory that answers with a million entries cannot push them out either.
  const kits = normalizeComposerData({ kits: many.map(item => ({ ...item, installed: true })) }).kits;
  expect(kits.length).toBe(1000);
  expect(kits.slice(0, 2).map(item => item.handle)).toEqual(["search", "browse"]);
});

test("the refresh flag is the only parameter, and an unknown one is refused", () => {
  expect(memberOptions(undefined)).toEqual({ force: false });
  expect(memberOptions({})).toEqual({ force: false });
  expect(memberOptions({ force: true })).toEqual({ force: true });
  for (const bad of [null, 7, "force", [], { force: "yes" }, { force: true, extra: 1 }, Object.assign(Object.create({ force: true }), {})])
    expect(() => memberOptions(bad)).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST", message: "成员刷新参数无效。" }) as unknown as Error);
});

function fixture(overrides: Partial<Parameters<typeof composerData>[0]> = {}) {
  const calls: { force: boolean }[] = [];
  let connected = true, revision = 3;
  const read = composerData({
    readKits: async () => ({ kits: [kit("fixture-tools", "测试工具目录")] }),
    readMembers: async options => { calls.push(options); return { members: [{ id: "t_alice", name: "Alice", description: "写作伙伴" }] }; },
    memberCacheState: () => ({ revision: 11, expiresAt: 1700 }),
    connection: () => ({ connected, revision }),
    ...overrides,
  });
  return { read, calls, set connected(value: boolean) { connected = value; }, set revision(value: number) { revision = value; } };
}

test("a full read carries both directories, the connection revision and the cache metadata", async () => {
  const f = fixture();
  const data = await f.read({ force: true });
  expect(f.calls).toEqual([{ force: true }]);
  expect(data.kits.map(item => item.handle)).toEqual(["search", "browse", "fixture-tools"]);
  expect(data.members.map(item => item.id)).toEqual(["t_alice"]);
  expect(data).toMatchObject({ kitsError: "", membersError: "", connectionRevision: 3, revision: 11, expiresAt: 1700 });
});

test("a Kit directory that cannot be read does not take the member directory with it", async () => {
  const f = fixture({ readKits: async () => { throw new Error("EACCES"); } });
  const data = await f.read();
  expect(data.kitsError).toBe("已安装 Kit 暂时无法读取。");
  expect(data.membersError).toBe("");
  // The built-in abilities are still offered: they are not in that directory.
  expect(data.kits.map(item => item.handle)).toEqual(["search", "browse"]);
  expect(data.members.map(item => item.id)).toEqual(["t_alice"]);
});

test("a member directory that cannot be read leaves the Kits alone", async () => {
  const f = fixture({ readMembers: async () => { throw Object.assign(new Error("未配对"), { code: "AUTH_REQUIRED" }); } });
  const data = await f.read();
  expect(data.membersError).toBe("Being 成员暂时无法加载。");
  expect(data.members).toEqual([]);
  expect(data.kits.map(item => item.handle)).toEqual(["search", "browse", "fixture-tools"]);
});

test("a reader that throws synchronously is settled like one that rejects", async () => {
  const f = fixture({ readMembers: (() => { throw new Error("boom"); }) as never });
  const data = await f.read();
  expect(data.membersError).toBe("Being 成员暂时无法加载。");
  expect(data.kits.length).toBe(3);
});

test("a Kit whose manifest could not be read is not offered", async () => {
  const f = fixture({ readKits: async () => ({ kits: [
    { name: "Broken", description: "", command: [], problem: "无法加载：manifest.json 无效" },
    kit("good-kit"),
  ] }) });
  expect((await f.read()).kits.map(item => item.name)).toEqual(["search", "browse", "good-kit"]);
});

test("nothing is read while no Being is bound", async () => {
  const f = fixture();
  f.connected = false;
  await expect(f.read()).rejects.toThrow("请先连接 Being。");
  expect(f.calls).toEqual([]);
});

test("a Being switched during the read invalidates the whole answer", async () => {
  const f = fixture({ readMembers: async () => { f.revision = 4; return { members: [] }; } });
  await expect(f.read()).rejects.toMatchObject({ code: "SESSION_CHANGED", message: "Being 连接已变化。" });
  const g = fixture({ readMembers: async () => { g.connected = false; return { members: [] }; } });
  await expect(g.read()).rejects.toMatchObject({ code: "SESSION_CHANGED", message: "Being 连接已变化。" });
});
