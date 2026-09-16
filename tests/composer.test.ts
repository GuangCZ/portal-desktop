// The composer's own rules: what may be attached, what may be sent, and where a
// draft lives. Cases follow BeingDesktop 0.8.26 renderer/chat-app.js
// (`addFiles`, `send`'s guards, the `drafts` map) and renderer/chat-references.js;
// 2026-09-16.
import { describe, expect, it, vi } from "vitest";
import {
  ComposerModel, IMAGE_TYPES, MAX_IMAGES, MAX_IMAGE_BYTES,
} from "../desktop/renderer/conversation/models/composer";

const image = (name: string, bytes: number, type = "image/png") =>
  new File([new Uint8Array(bytes)], name, { type });

const fixture = () => make();

function make({ read }: { read?: (file: File) => Promise<{ data: string; thumb: string }> } = {}) {
  const toasts: string[] = [];
  let id = 0;
  const composer = new ComposerModel({
    toast: message => toasts.push(message),
    read: read || (async (file: File) => ({ data: `base64:${file.name}`, thumb: `data:image/jpeg;base64,${file.name}` })),
    randomUUID: () => `image-${++id}`,
  });
  composer.switchTo("session-a");
  return { composer, toasts };
}

describe("the composer", () => {
  it("accepts the measured image envelope and refuses everything outside it", async () => {
    const { composer, toasts } = fixture();
    await composer.addFiles([image("a.png", 10), image("notes.txt", 10, "text/plain")]);
    expect(composer.images.map(item => item.name)).toEqual(["a.png"]);
    expect(toasts).toEqual(["notes.txt 不是图片，只支持 PNG、JPEG、WebP、GIF。"]);
    expect(IMAGE_TYPES.test("image/gif")).toBe(true);
    expect(IMAGE_TYPES.test("image/svg+xml")).toBe(false);
  });

  it("stops at eight images per message and says so once", async () => {
    const { composer, toasts } = fixture();
    await composer.addFiles(Array.from({ length: 10 }, (_item, index) => image(`${index}.png`, 10)));
    expect(composer.images).toHaveLength(MAX_IMAGES);
    expect(toasts).toEqual([`一条消息最多 ${MAX_IMAGES} 张图片。`]);
  });

  it("keeps a message's images under ten megabytes in total, skipping the one that would not fit", async () => {
    const { composer, toasts } = fixture();
    await composer.addFiles([
      image("big.png", MAX_IMAGE_BYTES - 10),
      image("over.png", 100),
      image("tiny.png", 5),
    ]);
    expect(composer.images.map(item => item.name)).toEqual(["big.png", "tiny.png"]);
    expect(toasts).toEqual(["over.png 放不下了：一条消息的图片合计不能超过 10 MB。"]);
  });

  it("drops an image whose conversation changed while it was being read", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { composer } = make({ read: async (file: File) => { await gate; return { data: file.name, thumb: "" }; } });
    const reading = composer.addFiles([image("late.png", 10)]);
    expect(composer.reading).toBe(1);
    composer.switchTo("session-b");
    release();
    await reading;
    expect(composer.images).toEqual([]);
    expect(composer.reading).toBe(0);
  });

  it("reports a file it could not read without losing the ones it could", async () => {
    const { composer, toasts } = make({
      read: async (file: File) => {
        if (file.name === "broken.png") throw new Error("unreadable");
        return { data: file.name, thumb: "" };
      },
    });
    await composer.addFiles([image("broken.png", 10), image("fine.png", 10)]);
    expect(composer.images.map(item => item.name)).toEqual(["fine.png"]);
    expect(toasts).toEqual(["broken.png 读取失败，请重新添加。"]);
  });

  it("refuses more than twelve quoted selections, and more than sixty thousand characters of them", () => {
    const { composer } = fixture();
    for (let index = 0; index < 12; index++) composer.addReference({ text: `quote ${index}`, source: "Being" });
    expect(composer.references).toHaveLength(12);
    expect(() => composer.addReference({ text: "one too many", source: "Being" }))
      .toThrow("一条消息最多引用 12 段文本。");
    const wide = make().composer;
    wide.addReference({ text: "x".repeat(59_000), source: "you" });
    expect(() => wide.addReference({ text: "y".repeat(1_001), source: "you" }))
      .toThrow("引用文本合计不能超过 60,000 个字符，请缩小选择范围。");
    expect(wide.references).toHaveLength(1);
  });

  it("narrows a selection's source to the two the Being is told about", () => {
    const { composer } = fixture();
    composer.addReference({ text: "quoted", source: "attacker" as unknown as "you" });
    expect(composer.references).toEqual([{ text: "quoted", source: "Being" }]);
  });

  it("refuses an empty message, and says why when something is attached to it", async () => {
    const { composer } = fixture();
    expect(composer.refusal()).toEqual({ blocked: true, message: "" });
    composer.addReference({ text: "quoted", source: "Being" });
    expect(composer.refusal()).toEqual({ blocked: true, message: "输入想讨论的问题，再连同引用一起发送。" });
    composer.clearReferences();
    await composer.addFiles([image("a.png", 10)]);
    // Images alone land no row and get the previous question answered (docs §十).
    expect(composer.refusal()).toEqual({ blocked: true, message: "给图片配一句话再发送。" });
    composer.setText("  ");
    expect(composer.refusal().blocked).toBe(true);
    composer.setText("看看这张图");
    expect(composer.refusal()).toEqual({ blocked: false, message: "" });
  });

  it("waits for an image still being read rather than sending the message without it", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { composer } = make({ read: async (file: File) => { await gate; return { data: file.name, thumb: "" }; } });
    composer.switchTo("session-a");
    composer.setText("看看这张图");
    const reading = composer.addFiles([image("slow.png", 10)]);
    expect(composer.refusal()).toEqual({ blocked: true, message: "图片还在读取，稍等一下再发送。" });
    release();
    await reading;
    expect(composer.refusal().blocked).toBe(false);
  });

  it("keeps each conversation's draft where it was typed", async () => {
    const { composer } = fixture();
    composer.setText("给 A 的话");
    await composer.addFiles([image("a.png", 10)]);
    composer.addReference({ text: "A 的引用", source: "you" });
    composer.switchTo("session-b");
    expect(composer.text).toBe("");
    expect(composer.images).toEqual([]);
    expect(composer.references).toEqual([]);
    composer.setText("给 B 的话");
    composer.switchTo("session-a");
    expect(composer.text).toBe("给 A 的话");
    expect(composer.images.map(item => item.name)).toEqual(["a.png"]);
    expect(composer.references).toEqual([{ text: "A 的引用", source: "you" }]);
    composer.switchTo("session-b");
    expect(composer.text).toBe("给 B 的话");
  });

  it("puts a refused message back in front of whatever was typed while it was away", () => {
    const { composer } = fixture();
    composer.setText("第一句");
    composer.addReference({ text: "引用一", source: "Being" });
    const draft = composer.take();
    expect(composer.text).toBe("");
    composer.setText("等待时写的第二句");
    composer.addReference({ text: "引用二", source: "you" });
    composer.restore("session-a", draft);
    expect(composer.text).toBe("第一句\n等待时写的第二句");
    expect(composer.references).toEqual([
      { text: "引用一", source: "Being" },
      { text: "引用二", source: "you" },
    ]);
  });

  it("restores a refused message into the conversation it was typed in, not the one on screen", () => {
    const { composer } = fixture();
    composer.setText("给 A 的话");
    const draft = composer.take();
    composer.switchTo("session-b");
    composer.setText("给 B 的话");
    composer.restore("session-a", draft);
    expect(composer.text).toBe("给 B 的话");
    composer.switchTo("session-a");
    expect(composer.text).toBe("给 A 的话");
  });

  it("forgets a conversation's draft when the conversation itself is forgotten", () => {
    const { composer } = fixture();
    composer.setText("给 A 的话");
    composer.forget("session-a");
    expect(composer.text).toBe("");
    expect(composer.session).toBe("");
    composer.switchTo("session-a");
    expect(composer.text).toBe("");
  });

  it("refuses to attach anything without a conversation to attach it to", async () => {
    const read = vi.fn(async () => ({ data: "", thumb: "" }));
    const { composer } = make({ read });
    composer.forget("session-a");
    await composer.addFiles([image("a.png", 10)]);
    expect(read).not.toHaveBeenCalled();
    expect(composer.images).toEqual([]);
  });

  it("publishes one version per change so React re-renders", async () => {
    const { composer } = fixture();
    const before = composer.getVersion();
    composer.setText("x");
    expect(composer.getVersion()).toBeGreaterThan(before);
  });
});
