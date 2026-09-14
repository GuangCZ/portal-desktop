import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { feedMessages, mailReply } from '../desktop/renderer/town-feed';
import { TownClient, TownCredentials, townRoute } from '../desktop/town';
import { TownLive } from '../desktop/town-live';

describe('official Town client identity fields (2026-09-14)', () => {
  it.each([
    [{ sender_display: '河流', sender_name: '旧名称', sender: 'river', sender_town_id: 't_River1' }, '河流'],
    [{ sender_name: '河流', sender: 'river', sender_town_id: 't_River1' }, '河流'],
    [{ sender: 'river', sender_town_id: 't_River1' }, 'river'],
    [{ sender_town_id: 't_River1' }, 't_River1'],
    [{ sender_display_name: '旧版显示名', sender_being_id: 'river' }, '旧版显示名'],
    [{ sender: { town_id: 't_River1', display: '嵌套显示名' } }, '嵌套显示名'],
    [{}, '未知'],
  ])('selects the server display name with official fallbacks: %j', (entry, author) => {
    const [message] = feedMessages([{ id: 'dm-1', ...entry }], { me: 't_Willow', mail: 'inbox' });
    expect(message.author).toBe(author);
  });

  it('keeps display names separate from case-sensitive reply addresses in inbox and sent mail', () => {
    const [incoming, outgoing] = feedMessages([
      { id: 'dm-in', sender_display: '同名 Being', sender_town_id: 't_RiverA', sender_being_id: 'old-river', recipient_town_id: 't_Willow', content: '来信' },
      { id: 'dm-out', sender_town_id: 't_Willow', recipient_display: '同名 Being', recipient_town_id: 't_RiverB', recipient: '旧收件人', content: '发信' },
    ], { me: 't_Willow', mail: 'all' });
    expect(incoming).toMatchObject({ author: '同名 Being', authorId: 't_RiverA', received: true, mine: false });
    expect(outgoing).toMatchObject({ recipient: '同名 Being', recipientId: 't_RiverB', mine: true });
    expect(mailReply(incoming)).toMatchObject({ id: 'dm-in', recipient: 't_RiverA' });
    expect(mailReply(outgoing)).toMatchObject({ id: 'dm-out', recipient: 't_RiverB' });
    const [otherCase] = feedMessages([{ sender_town_id: 't_willow', recipient_town_id: 't_WILLOW', content: '@t_willow' }], { me: 't_Willow', mail: 'all' });
    expect(otherCase).toMatchObject({ mine: false, received: false, mentioned: false });
  });

  it('never uses a feed sequence as a private message reply ID', () => {
    const [missingId] = feedMessages([{ seq: 1, sender_town_id: 't_RiverA' }], { me: 't_Willow', mail: 'inbox' });
    expect(mailReply(missingId)).toBeUndefined();
  });

  it('preserves a display-name fallback when the server did not return a Town ID', () => {
    const [message] = feedMessages([{ id: 'dm-1', sender: 'Seam Walker' }], { me: 'willow', mail: 'inbox' });
    expect(mailReply(message)?.recipient).toBe('Seam Walker');
  });

  it('pairs by Town ID without lowercasing and stores the canonical response when pairing by legacy name', async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true, token: 'a'.repeat(64), town_id: 't_Willow', being_id: 'willow' }));
    const client = new TownClient(() => '', fetcher as typeof fetch);
    for (const beingId of [' t_Willow ', 'Willow']) {
      expect(await client.pair({ beingId, code: 'ab3xy9' })).toEqual({ token: 'a'.repeat(64), beingId: 't_Willow' });
    }
    expect((fetcher.mock.calls as unknown as [string, RequestInit][]).map(([, init]) => JSON.parse(String(init.body)))).toEqual([
      { town_id: 't_Willow', code: 'AB3XY9' }, { being_id: 'willow', code: 'AB3XY9' },
    ]);
    await expect(client.pair({ beingId: 't_willow', code: 'AB3XY9' })).rejects.toThrow('身份不匹配');
  });

  it('preserves canonical Town IDs across encrypted credential reload and my-scrolls queries', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'town-identity-test-'));
    const storage = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() };
    try {
      await new TownCredentials(directory, storage).save('a'.repeat(64), 't_Willow');
      const credentials = new TownCredentials(directory, storage);
      await credentials.load();
      expect(credentials.beingId).toBe('t_Willow');
      expect(townRoute({ kind: 'my-scrolls' }, credentials.beingId).route).toBe('/api/scrolls?author=t_Willow&limit=24&offset=0');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each([
    ['t_Willow', { town_id: 't_Willow' }, 'connected'],
    ['willow', { town_id: 't_Willow', being_id: 'willow' }, 'connected'],
    ['t_willow', { town_id: 't_Willow' }, 'auth-error'],
    ['t_Willow', { town_id: 't_Other', being_id: 't_Willow' }, 'auth-error'],
  ])('confirms stream identity %s against %j', async (expected, identity, phase) => {
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`event: hello\ndata: ${JSON.stringify({ ...identity, token_kind: 'client', anonymous: false })}\n\n`));
    } }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const live = new TownLive(() => 'fixture-token', () => expected, () => {}, fetcher as typeof fetch);
    try {
      live.restart();
      await vi.waitFor(() => expect(live.state.phase).toBe(phase));
      expect(live.state.beingId).toBe(phase === 'connected' ? 't_Willow' : undefined);
    } finally { live.dispose(); }
  });
});
