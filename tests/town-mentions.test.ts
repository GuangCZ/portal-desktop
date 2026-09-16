import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mentionNames, mentionParts, mentionText, withSelf } from '../desktop/renderer/town/models/mentions';
import { MentionText } from '../desktop/renderer/town/components/mention-text';
import { Markdown, markdownText } from '../desktop/renderer/shared/components/markdown';

// 2026-09-16: the source of names changed and the rules did not.
//
// The shell used to mine display names out of message envelopes, because an
// anonymous Town read was all it had. The paired client has a real member
// directory (`beings:town-members`), so the map is built from that. Every case
// below is the one it was before — exact case-sensitive ids, unknown ids left
// alone, URLs and emails untouched, names rendered as inert text — restated
// against the directory instead of against a pile of envelope spellings.
const names = mentionNames([
  { id: 't_NNzQHl8Icb7E8E1e', name: 'Neo', description: '' },
  { id: 't_RiverA', name: '河流 (t_RiverA)', description: '' },
  { id: 't_RiverB', name: '河流 (t_RiverB)', description: '' },
  { id: 't_Other', name: '<img src=x onerror=alert(1)> (t_Other)', description: '' },
]);

describe('Town mentions are a display projection of the original text', () => {
  it('maps exact IDs from the member directory', () => {
    const source = '@t_NNzQHl8Icb7E8E1e 刚发现一个私信寻址 bug，@t_RiverA 和 @t_RiverB 一起看。';
    expect(mentionText(source, names)).toBe('@Neo 刚发现一个私信寻址 bug，@河流 和 @河流 一起看。');
    expect(mentionParts(source, names).filter(part => part.id).map(part => part.id)).toEqual(['t_NNzQHl8Icb7E8E1e', 't_RiverA', 't_RiverB']);
    expect(source).toContain('@t_NNzQHl8Icb7E8E1e');
  });

  it('preserves unknown, differently cased and abbreviated IDs, URLs and email addresses', () => {
    const source = '@t_Unknown @t_riverA @t_River @t_RiverA_more user@t_RiverA https://example.com/@t_RiverA';
    expect(mentionText(source, names)).toBe(source);
    expect(mentionText('中文@t_RiverA，(@t_RiverB)', names)).toBe('中文@河流，(@河流)');
  });

  it('refuses a directory entry that is not a Town ID, or whose name is the ID again', () => {
    // Message prose is never a name directory, and a name that merely repeats the
    // id would render `@t_RiverA` as `@t_RiverA` through a lookup — a cost with
    // no effect, and one that hides a directory that has not really loaded.
    const useless = mentionNames([
      { id: 't_RiverA', name: 't_RiverA', description: '' },
      { id: 'legacy_name', name: '旧版 Being', description: '' },
      { id: 't_Quiet', name: '   ', description: '' },
    ]);
    expect(mentionText('@t_RiverA @legacy_name @t_Quiet', useless)).toBe('@t_RiverA @legacy_name @t_Quiet');
  });

  it('a later directory replaces an earlier name without mutating the previous map', () => {
    const newer = mentionNames([{ id: 't_NNzQHl8Icb7E8E1e', name: '新名字', description: '' }], names);
    expect(mentionText('@t_NNzQHl8Icb7E8E1e', newer)).toBe('@新名字');
    expect(mentionText('@t_NNzQHl8Icb7E8E1e', names)).toBe('@Neo');
  });

  it('adds the paired profile itself, which the directory does not list', () => {
    const withMe = withSelf(names, 't_Willow', '柳树 (t_Willow)');
    expect(mentionText('@t_Willow', withMe)).toBe('@柳树');
    expect(mentionText('@t_Willow', names)).toBe('@t_Willow');
  });

  it('renders mention names as React text while leaving code and links intact', () => {
    const source = '**@t_RiverA**\n\n@t_Other\n\n`@t_RiverA`\n\n```txt\n@t_RiverA\n```\n\n[@t_RiverA](https://example.com/@t_RiverA)';
    const html = renderToStaticMarkup(createElement(Markdown, {
      content: source,
      renderText: text => createElement(MentionText, { text, names }),
    }));
    expect(html.match(/class="town-mention"/g)).toHaveLength(2);
    expect(html).toContain('title="@t_RiverA" data-town-id="t_RiverA">@河流</span>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
    expect(html).toContain('<code>@t_RiverA</code>');
    expect(html).toContain('href="https://example.com/@t_RiverA"');
    expect(markdownText(source, text => mentionText(text, names))).toContain('@河流');
    expect(markdownText(source, text => mentionText(text, names)).match(/@t_RiverA/g)).toHaveLength(3);
  });
});
