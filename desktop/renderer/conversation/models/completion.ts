// The composer's token parsing and the prompt a `/` reference expands into.
// Ported line for line from BeingDesktop 0.8.26 renderer/composer-helpers.js
// (62 lines); 2026-09-16.
//
// It is a separate module there for the same reason it is one here: the native
// composer and the isolated-world adapter that enhanced Loom's page both used it,
// so the parsing could not live in either. Nothing in it touches the DOM, which
// is what lets the rules be tested as rules.
import type { ChatComposerData, ChatComposerEntry } from '../../../shared/desktop-types';

export interface ComposerToken {
  kind: 'kit' | 'member';
  prefix: '/' | '@';
  query: string;
  /** Where the prefix character is. */
  start: number;
  /** The end of the word being typed, including what sits after the caret. */
  end: number;
}

/**
 * The `/` or `@` token the caret is inside, or null.
 *
 * A token has to start at the beginning of the text or after whitespace, so an
 * email address and a URL path are not tokens, and the caret has to be a caret
 * rather than a selection — replacing a range the user chose would throw their
 * selection away.
 */
export function tokenAtCaret(text: string, start: number, end: number = start): ComposerToken | null {
  if (typeof text !== 'string' || !Number.isInteger(start) || start < 0 || start > text.length || start !== end) return null;
  const match = /(^|\s)([/@])([^\s/@]{0,200})$/u.exec(text.slice(0, start));
  if (!match) return null;
  const remaining = /^[^\s/@]*/u.exec(text.slice(start))![0];
  return {
    kind: match[2] === '/' ? 'kit' : 'member',
    prefix: match[2] as '/' | '@',
    query: match[3],
    start: start - match[3].length - 1,
    end: start + remaining.length,
  };
}

/** The menu's entries: a case-insensitive match over everything an entry is
 * called, with the ones whose handle starts with the query first, capped at 12. */
export function composerSuggestions(data: Pick<ChatComposerData, 'kits' | 'members'>, token: ComposerToken | null): ChatComposerEntry[] {
  if (!token) return [];
  const query = token.query.toLocaleLowerCase();
  const source = token.kind === 'kit' ? data.kits : data.members;
  return source
    .filter(item => `${item.name} ${item.handle} ${item.id} ${item.description}`.toLocaleLowerCase().includes(query))
    .sort((left, right) => Number(!left.handle.toLocaleLowerCase().startsWith(query)) - Number(!right.handle.toLocaleLowerCase().startsWith(query)))
    .slice(0, 12);
}

/** Replace the token with the chosen entry, leaving one space after it so the
 * next word is not glued on. The caret lands after that space. */
export function replaceComposerToken(text: string, token: ComposerToken, item: { handle: string }): { text: string; caret: number } {
  const inserted = `${token.prefix}${item.handle}`;
  const suffix = text.slice(token.end);
  const separator = /^\s/u.test(suffix) ? '' : ' ';
  return { text: text.slice(0, token.start) + inserted + separator + suffix, caret: token.start + inserted.length + (separator ? 1 : 0) };
}

/**
 * Which entries the finished text actually references.
 *
 * A marker counts only where it stands as a word: at the start or after
 * whitespace, and followed by the end, whitespace or punctuation. `/searching`
 * is not a reference to `/search`, and neither is `路径/search`.
 */
export function composerReferences<T extends { handle: string }>(text: string, items: readonly T[], prefix: string): T[] {
  return items.filter(item => {
    const marker = prefix + item.handle;
    let cursor = 0;
    while ((cursor = text.indexOf(marker, cursor)) !== -1) {
      const before = cursor === 0 || /\s/u.test(text[cursor - 1]);
      const after = text[cursor + marker.length];
      if (before && (!after || /[\s.,!?;:，。！？；：、)\]}]/u.test(after))) return true;
      cursor += marker.length;
    }
    return false;
  });
}

/**
 * The message a `/` reference actually sends.
 *
 * The user typed a shorthand; the Being is asked in words, because it has no
 * `/search` syntax — it has abilities and Kits, and what it needs is a request
 * that names them. Two sentences, one for the built-in abilities and one for the
 * installed Kits, then the user's own text unchanged below them.
 *
 * Both sentences say what to do when the thing is not available: ask, or explain
 * — never install, never invent.
 */
export function buildKitPrompt(text: string, kits: readonly ChatComposerEntry[]): string {
  const referenced = composerReferences(text, kits, '/');
  if (!referenced.length) return text;
  const instructions: string[] = [];
  const builtin = referenced.filter(item => item.builtin);
  if (builtin.length) {
    const abilities = builtin.map(item => item.builtin === 'search'
      ? '网络搜索（Search），搜索互联网并读取相关网页正文'
      : '网页读取（Browse），读取指定公开网页，必要时使用 JavaScript 渲染，不控制本机浏览器');
    instructions.push(`请使用 Being 的内置能力完成我的请求：${abilities.join('；')}。如果缺少搜索主题或网页地址，请先询问我；如果能力不可用，请说明原因。`);
  }
  const remote = referenced.filter(item => !item.builtin);
  if (remote.length) {
    const names = remote.map(item => `「${item.name}」（Kit ID: ${item.id}）`).join('、');
    instructions.push(`请使用以下 Kit 完成我的请求：${names}。先检查 Kit 是否已经可用，再调用其中适合本次请求的工具；如果尚不可用，请说明缺少的配置，不要自动安装或登记。`);
  }
  return `${instructions.join('\n')}\n\n${text}`;
}
