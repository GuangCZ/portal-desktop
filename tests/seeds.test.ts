import { describe, expect, it, vi } from 'vitest';
import { TownCatalog, townRoute } from '../desktop/main/town/catalog';
import type { DesktopAPI, TownQuery, TownResult } from '../desktop/shared/types';
import { TownModel } from '../desktop/renderer/town/models/town';
import { SceneStore } from '../desktop/renderer/shared/models/scene';
import { placeFromURL, validPlaceTarget } from '../desktop/renderer/shared/lib/navigation';

const success = (data: Record<string, unknown>): TownResult => ({ ok: true, data, fetchedAt: '2026-09-14T00:00:00Z' });
/** The Seed Garden is part of the PUBLIC catalogue, so the model needs the
 * catalogue channel and nothing else. `townDesktop` is present but never reached
 * from a seed view; a call to it here would be the bug. */
function model(query: DesktopAPI['town']) {
  const navigate = vi.fn();
  const townDesktop = new Proxy({}, { get: (_target, key) => () => { throw new Error(`公开目录不应调用 townDesktop.${String(key)}`); } }) as DesktopAPI['townDesktop'];
  const town = new TownModel({ town: query, townDesktop } as DesktopAPI, vi.fn(), navigate, new SceneStore(), vi.fn(), vi.fn());
  return { town, navigate };
}

describe('Seed Garden public protocol', () => {
  it('encodes server search, filters and pagination without exposing stored credentials', async () => {
    const fetcher = vi.fn(async () => Response.json({ count: 34, seeds: [] }));
    const client = new TownCatalog(fetcher as typeof fetch);
    await client.query({ kind: 'seeds', offset: 24, q: '修复 & 经验', tag: '远程运维', domain: '文件管理', kit: 'my kit', lifecycle: 'stale' });
    const [url, init] = (fetcher.mock.calls as unknown as [string, RequestInit][])[0];
    expect(Object.fromEntries(new URL(url).searchParams)).toEqual({ limit: '24', offset: '24', q: '修复 & 经验', tag: '远程运维', domain: '文件管理', kit: 'my kit', lifecycle: 'stale' });
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', headers: { Accept: 'application/json' } });
    expect(JSON.stringify(init)).not.toContain('must-not-send-this');
    for (const kind of ['seed', 'seed-lineage', 'seed-absorbs'] as const) {
      await client.query({ kind, id: 'Seed_A-1' });
    }
    expect((fetcher.mock.calls as unknown as [string, RequestInit][]).slice(1).map(([url]) => new URL(url).pathname)).toEqual([
      '/api/seeds/Seed_A-1', '/api/seeds/Seed_A-1/lineage', '/api/seeds/Seed_A-1/absorb',
    ]);
  });

  it.each([
    { kind: 'seed', id: '../messages' }, { kind: 'seed', id: 'x?token=secret' }, { kind: 'seed', id: 'help' },
    { kind: 'seeds', offset: -1 }, { kind: 'seeds', lifecycle: 'private' }, { kind: 'seeds', tag: ['x'] },
    { kind: 'seeds', q: 'x'.repeat(301) }, { kind: 'seeds', kit: 'bad\nheader' },
  ])('rejects malformed resource/filter input: %j', query => expect(() => townRoute(query as TownQuery)).toThrow());

  it('routes official Seed Garden links into the native view without accepting credentials or unrelated paths', () => {
    for (const url of ['https://beings.town/seeds/Seed_A-1', '/api/seeds/Seed_A-1']) expect(placeFromURL(url)).toEqual({ view: 'seeds', id: 'Seed_A-1' });
    expect(placeFromURL('/seeds')).toEqual({ view: 'seeds' });
    expect(validPlaceTarget({ view: 'seeds', id: 'Seed_A-1' })).toBe(true);
    for (const url of ['https://evil.test/seeds/Seed_A-1', 'https://beings.town/seeds/x?token=secret', '/api/seeds/help', '/api/seeds/x/absorb']) expect(placeFromURL(url)).toBeNull();
  });

  it('cannot reach a private feed at all, so a denied public read has no credential to invalidate', async () => {
    // 2026-09-16: the old shape of this case asserted that a 401 on a PUBLIC read
    // did not invalidate the paired credential, because one anonymous client
    // served both halves and could confuse them. It now cannot: the private
    // kinds left this route table with the credential (desktop/main/town/catalog.ts),
    // and a denied public read carries no identity to reject.
    const fetcher = vi.fn(async () => Response.json({ error: 'nope' }, { status: 401 }));
    const client = new TownCatalog(fetcher as typeof fetch);
    expect(await client.query({ kind: 'seeds' })).toMatchObject({ ok: false, code: 'auth' });
    expect((fetcher.mock.calls as unknown as [string, RequestInit][])[0][1].headers).toEqual({ Accept: 'application/json' });
    for (const kind of ['bonfire', 'firesides', 'fireside', 'inbox', 'sent', 'my-scrolls']) {
      expect(() => townRoute({ kind } as unknown as TownQuery)).toThrow();
    }
  });
});

describe('Seed Garden reading state', () => {
  it('loads publicly, resets server-search pagination, and opens Kit experience walls', async () => {
    const query = vi.fn(async () => success({ count: 34, seeds: [{ id: 'one', name: '经验' }] }));
    const { town, navigate } = model(query);
    town.show('seeds');
    await vi.waitFor(() => expect(town.data?.count).toBe(34));
    town.offset = 24;
    town.filterSeeds({ q: '真正的全文搜索', domain: '', tag: '', kit: '', lifecycle: '' });
    expect(town.offset).toBe(0);
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2));
    expect(query.mock.calls.at(-1)).toEqual([{ kind: 'seeds', offset: 0, q: '真正的全文搜索', domain: '', tag: '', kit: '', lifecycle: '' }]);
    town.view = 'kits';
    town.seedWall('codex');
    expect(navigate).toHaveBeenCalledWith('seeds');
    expect(town.seedFilters.kit).toBe('codex');
  });

  it('does not let an earlier detail overwrite the newly selected seed', async () => {
    let resolve!: (value: TownResult) => void;
    const first = new Promise<TownResult>(done => { resolve = done; });
    const { town } = model(vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(success({ id: 'new', name: '新种子', brief: '新经验' })));
    town.view = 'seeds';
    const oldRequest = town.loadDetail({ kind: 'seed', id: 'old' });
    await town.loadDetail({ kind: 'seed', id: 'new' });
    resolve(success({ id: 'old', name: '旧种子', brief: '旧经验' }));
    await oldRequest;
    expect(town.detail?.query.id).toBe('new');
    expect(town.detail?.fragments[0].brief).toBe('新经验');
  });

  it('loads a direct seed link as a seed and surfaces invalid detail data', async () => {
    const query = vi.fn(async () => success({ id: 'direct', name: '不完整数据' }));
    const { town } = model(query);
    town.show('seeds', 'direct');
    await vi.waitFor(() => expect(town.detailError?.message).toContain('种子详情格式'));
    expect(query).toHaveBeenCalledWith({ kind: 'seed', id: 'direct' });
    expect(town.detail).toBeUndefined();
  });
});
