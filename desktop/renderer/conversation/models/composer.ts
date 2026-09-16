// The composer's own state: the draft text, the images waiting to go with it,
// and the quoted selections travelling with it. Ported from BeingDesktop 0.8.26
// renderer/chat-app.js (`drafts`, `addFiles`, `base64`, `thumbnail`,
// `renderTray`, `renderReferences`) and renderer/chat-references.js; 2026-09-16.
//
// The measured envelope (docs/desktop-message-layer.md §十, measured 2026-09-11):
// images go to the Being as content blocks alongside the text and are not kept
// by it — history holds the text alone, and a message of images with no text
// lands no row at all and gets the *previous* question answered. That is why
// text is required here and why a small local preview is all the transcript
// keeps of an image.
//
// Reading a file is injected rather than imported: `FileReader`,
// `createImageBitmap` and `<canvas>` exist only in a browser, and the ordering
// and limit rules are what the tests are about.
import { Store } from '../../shared/models/store';
import { validate, type ChatReference } from '../../../shared/chat-references';

/** The measured envelope: PNG/JPEG/WebP/GIF, 8 per message, 10 MB in total
 * (chat-app.js line 27, docs/interfaces.md §1.2). */
export const IMAGE_TYPES = /^image\/(?:png|jpeg|webp|gif)$/;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024, MAX_IMAGES = 8, THUMB_EDGE = 256, MAX_THUMB = 48 * 1024;

/** How long after an input method commits its text an Enter still belongs to
 * that commit rather than to us (chat-composer.js line 142: 50ms). Several
 * input methods report the Enter that accepts a candidate as a plain key press
 * — `isComposing` already false — and without this window that keystroke sends
 * the half-typed message. */
export const COMPOSITION_MS = 50;

export interface PendingImage {
  id: string;
  name: string;
  media_type: string;
  size: number;
  /** base64 without the data-URL prefix — what `chatSend` carries. */
  data: string;
  /** A small JPEG data URL, or '' when it would not fit under 48KB. */
  thumb: string;
}

export interface Draft { text: string; images: PendingImage[]; references: ChatReference[] }

/** What one image contributes: the bytes for the Being, the preview for us. */
export interface ImageReader { (file: File): Promise<{ data: string; thumb: string }> }

export interface ComposerOptions {
  toast: (message: string) => void;
  /** Overridden in tests; the default uses FileReader and a canvas. */
  read?: ImageReader;
  randomUUID?: () => string;
  now?: () => number;
}

/** Reads a file as base64 and draws a small preview of it. A transparent PNG is
 * flattened onto white so it stays legible, and the preview is dropped rather
 * than kept oversized: nothing will ever come back from the Being for it. */
export const browserImageReader: ImageReader = async (file: File) => {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || ''), at = value.indexOf(',');
      if (at >= 0) resolve(value.slice(at + 1)); else reject(new Error('unreadable'));
    };
    reader.onerror = () => reject(reader.error || new Error('unreadable'));
    reader.readAsDataURL(file);
  });
  let thumb = '';
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, THUMB_EDGE / Math.max(bitmap.width, bitmap.height, 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const url = canvas.toDataURL('image/jpeg', 0.7);
    thumb = url.length <= MAX_THUMB ? url : '';
  } catch { /* A conversation without a preview is still a conversation. */ }
  return { data, thumb };
};

export class ComposerModel extends Store {
  text = '';
  images: PendingImage[] = [];
  references: ChatReference[] = [];
  /** How many files are still being read. Sending waits for them. */
  reading = 0;
  /** No conversation selected means nothing can be typed into anything. */
  session = '';
  private drafts = new Map<string, Draft>();
  private composing = false;
  private compositionUntil = 0;
  private readonly read: ImageReader;
  private readonly uuid: () => string;
  private readonly now: () => number;
  constructor(private readonly options: ComposerOptions) {
    super();
    this.read = options.read || browserImageReader;
    this.uuid = options.randomUUID || (() => crypto.randomUUID());
    this.now = options.now || (() => Date.now());
  }

  /** An input method opened a candidate window over the composer. */
  startComposition() { this.composing = true; }

  /** It committed. Nothing is published: no rendered output depends on the flag,
   * and a re-render in the middle of a commit is exactly what not to do. */
  endComposition() {
    this.composing = false;
    this.compositionUntil = this.now() + COMPOSITION_MS;
  }

  /** Composing, or within the grace window after a commit (chat-composer.js
   * lines 98 and 106 ask this same question of `composing` and
   * `compositionUntil` before letting an Enter through). */
  get settling(): boolean {
    return this.composing || this.now() < this.compositionUntil;
  }

  /** Point the composer at another conversation, keeping each one's draft where
   * it was typed (chat-app.js line 292: the draft map is keyed by session id). */
  switchTo(session: string) {
    if (session === this.session) return;
    if (this.session) this.drafts.set(this.session, this.snapshot());
    this.session = session;
    const draft = this.drafts.get(session);
    this.text = draft?.text || '';
    this.images = draft?.images || [];
    this.references = draft?.references || [];
    this.changed();
  }

  snapshot(): Draft {
    return { text: this.text, images: this.images, references: this.references };
  }

  setText(value: string) {
    this.text = value;
    this.changed();
  }

  /** Add images to the next message. The type and the size are checked before
   * anything is read, so the user hears about a refusal immediately, and only
   * the last refusal is reported — as in 0.8.26, one line rather than a pile. */
  async addFiles(list: Iterable<File> | null | undefined) {
    const files = [...(list || [])].filter((file): file is File => file instanceof File);
    if (!files.length || !this.session) return;
    let total = this.images.reduce((sum, image) => sum + image.size, 0), refused = '';
    const accepted: File[] = [];
    for (const file of files) {
      if (!IMAGE_TYPES.test(file.type)) { refused = `${file.name || '文件'} 不是图片，只支持 PNG、JPEG、WebP、GIF。`; continue; }
      if (this.images.length + accepted.length >= MAX_IMAGES) { refused = `一条消息最多 ${MAX_IMAGES} 张图片。`; break; }
      if (total + file.size > MAX_IMAGE_BYTES) { refused = `${file.name || '图片'} 放不下了：一条消息的图片合计不能超过 10 MB。`; continue; }
      total += file.size;
      accepted.push(file);
    }
    if (refused) this.options.toast(refused);
    const session = this.session;
    this.reading += accepted.length;
    this.changed();
    await Promise.all(accepted.map(async file => {
      try {
        const { data, thumb } = await this.read(file);
        // The conversation changed while reading: this image was meant for the other one.
        if (this.session === session)
          this.images = [...this.images, { id: this.uuid(), name: file.name || '图片', media_type: file.type, size: file.size, data, thumb }];
      } catch {
        this.options.toast(`${file.name || '图片'} 读取失败，请重新添加。`);
      } finally {
        this.reading--;
        this.changed();
      }
    }));
  }

  removeImage(id: string) {
    this.images = this.images.filter(image => image.id !== id);
    this.changed();
  }

  /** Throws the reference layer's own refusal text (≤12 selections, ≤60000
   * characters in total) rather than silently truncating a selection. */
  addReference(reference: ChatReference) {
    this.references = validate([...this.references, reference]);
    this.changed();
  }

  removeReference(index: number) {
    this.references = this.references.filter((_item, at) => at !== index);
    this.changed();
  }

  clearReferences() {
    this.references = [];
    this.changed();
  }

  /** Hand the message over and leave the composer empty. The caller owns what
   * comes back: a failed send puts it back through `restore`. */
  take(): Draft {
    const draft = this.snapshot();
    this.text = '';
    this.images = [];
    this.references = [];
    this.changed();
    return draft;
  }

  /**
   * Put a refused message back where it was typed. Anything typed since the
   * send began stays — the returned text goes first, the new draft after it, so
   * nothing the user wrote is lost either way (chat-app.js line 508).
   */
  restore(session: string, draft: Draft) {
    const current = this.session === session ? this.snapshot() : this.drafts.get(session);
    const merged: Draft = {
      text: draft.text + (current?.text ? '\n' + current.text : ''),
      images: [...draft.images, ...(current?.images || [])],
      references: [...draft.references, ...(current?.references || [])],
    };
    this.drafts.set(session, merged);
    if (this.session === session) {
      this.text = merged.text;
      this.images = merged.images;
      this.references = merged.references;
    }
    this.changed();
  }

  /** Drop a conversation's remembered draft — it no longer exists. */
  forget(session: string) {
    this.drafts.delete(session);
    if (this.session === session) {
      this.session = '';
      this.text = '';
      this.images = [];
      this.references = [];
      this.changed();
    }
  }

  /**
   * Whether this message can go, and what to say when it cannot. Order matters,
   * and it is 0.8.26's: images still being read come before an empty message,
   * and a message of images alone is refused with the reason it would actually
   * fail (docs §十) rather than a generic one. An empty message with nothing
   * attached is refused silently — pressing Enter on an empty box is not a
   * mistake worth a notice. A message still settling out of an input method is
   * refused last, where 0.8.26 put it: `send` reached `composerUI.prepare`
   * only after the checks below (chat-app.js line 498, chat-composer.js line
   * 106), so an empty box during a commit stays silent too.
   */
  refusal(): { blocked: boolean; message: string } {
    if (this.reading) return { blocked: true, message: '图片还在读取，稍等一下再发送。' };
    if (this.text.trim()) return this.settling
      ? { blocked: true, message: '请完成输入后再发送。' }
      : { blocked: false, message: '' };
    if (this.references.length) return { blocked: true, message: '输入想讨论的问题，再连同引用一起发送。' };
    if (this.images.length) return { blocked: true, message: '给图片配一句话再发送。' };
    return { blocked: true, message: '' };
  }
}
