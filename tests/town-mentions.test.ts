import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { collectMentionNames, mentionParts, mentionText } from '../desktop/renderer/town/models/mentions';
import { MentionText } from '../desktop/renderer/town/components/mention-text';
import { Markdown, markdownText } from '../desktop/renderer/shared/components/markdown';

const names = collectMentionNames([
  { town_id: 't_NNzQHl8Icb7E8E1e', speaker_name: 'Neo', at: '2026-09-14' },
  { sender_town_id: 't_RiverA', sender_display: '河流 (t_RiverA)', recipient_town_id: 't_RiverB', recipient_display: '河流 (t_RiverB)' },
  { reply_to_sender: 't_Other', reply_to_sender_display: '<img src=x onerror=alert(1)> (t_Other)' },
]);

describe('Town mentions are a display projection of the original text', () => {
  it('maps exact IDs from server names across bonfire, mail and reply metadata', () => {
    const source = '@t_NNzQHl8Icb7E8E1e 刚发现一个私信寻址 bug，@t_RiverA 和 @t_RiverB 一起看。';
    expect(mentionText(source, names)).toBe('@Neo 刚发现一个私信寻址 bug，@河流 和 @河流 一起看。');
    expect(mentionParts(source, names).filter(part => part.id).map(part => part.id)).toEqual(['t_NNzQHl8Icb7E8E1e', 't_RiverA', 't_RiverB']);
    expect(source).toContain('@t_NNzQHl8Icb7E8E1e');
  });

  it('preserves unknown, differently cased and abbreviated IDs, URLs and email addresses', () => {
    const source = '@t_Unknown @t_riverA @t_River @t_RiverA_more user@t_RiverA https://example.com/@t_RiverA';
    expect(mentionText(source, names)).toBe(source);
    expect(mentionText('中文@t_RiverA，(@t_RiverB)', names)).toBe('中文@河流，(@河流)');
    expect(mentionText('@t_RiverA', collectMentionNames([{ content: 't_RiverA is Alice' }]))).toBe('@t_RiverA');
  });

  it('retains newer server name snapshots across pages without mutating the previous cache', () => {
    const newer = collectMentionNames([{ town_id: 't_NNzQHl8Icb7E8E1e', display_name: '新名字', at: '2026-09-15' }], names);
    const older = collectMentionNames([{ town_id: 't_NNzQHl8Icb7E8E1e', display_name: '旧名字', at: '2026-09-13' }], newer);
    expect(mentionText('@t_NNzQHl8Icb7E8E1e', older)).toBe('@新名字');
    expect(mentionText('@t_NNzQHl8Icb7E8E1e', names)).toBe('@Neo');
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
