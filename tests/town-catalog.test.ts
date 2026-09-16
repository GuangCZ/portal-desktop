// Town's public catalogue, 2026-09-16.
//
// These are the surviving cases of the deleted tests/town.test.ts. That file
// tested `desktop/main/town/client.ts`, which integration unit I1 replaced with
// BeingDesktop's paired client (decision §5.1); its「Town SDK 2769e2f protocol」
// half now lives against the real client in tests/town-session-client.test.ts and
// tests/town-session-name-rules.test.ts, and its credential-persistence case in
// tests/town-timeline-client-store.test.ts. What had no home there is this: the
// ANONYMOUS reader that browses Town's public pages, which BeingDesktop has no
// counterpart for and which `desktop/main/kits/install.ts` depends on.
//
// Every assertion below is the assertion it was. What changed is that the kinds
// it refuses now include the six private ones — routing them without a credential
// could only ever have produced a 401 (docs/town-sdk-integration.md「真实验证」).
import { describe, expect, it, vi } from 'vitest';
import { TOWN_LINK, TownCatalog, townRoute } from '../desktop/main/town/catalog';
import type { TownQuery } from '../desktop/shared/types';

const ok = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

describe('Town public reads', () => {
  it('routes only fixed resources with constrained identifiers and pagination', () => {
    expect(townRoute({ kind: 'home' }).route).toBe('/api');
    expect(townRoute({ kind: 'scrolls', offset: 24 }).route).toContain('visibility=public&limit=24&offset=24');
    expect(townRoute({ kind: 'ember', id: 'story-7' }).route).toBe('/api/embers/story-7?limit=10000&offset=0');
    expect(townRoute({ kind: 'kit', id: 'weather' }).route).toBe('/api/grove/weather');
    for (const query of [
      { kind: 'kit', id: '../messages' },
      { kind: 'kit', id: 'x?token=secret' },
      { kind: 'grove', offset: -1 },
      { kind: 'grove', offset: 1.5 },
      { kind: 'scrolls', scrollKind: 'secret' },
      { kind: 'exec' },
    ]) expect(() => townRoute(query as TownQuery)).toThrow();
  });

  it('never has a credential to send, on any route', async () => {
    // The old reader carried a dedicated Town bearer and attached it to the
    // private kinds only. The private kinds are gone, so the header is gone: this
    // reader cannot authenticate even by mistake.
    const fetcher = vi.fn(async () => ok({ messages: [] }));
    const catalog = new TownCatalog(fetcher as unknown as typeof fetch);
    await catalog.query({ kind: 'home' });
    await catalog.query({ kind: 'seed', id: 'seed-1' });
    for (const [url, options] of fetcher.mock.calls as unknown as [string, RequestInit][]) {
      expect(options).toMatchObject({ headers: { Accept: 'application/json' }, credentials: 'omit', redirect: 'error', method: 'GET' });
      expect(Object.keys(options.headers as Record<string, string>)).toEqual(['Accept']);
      expect(url.startsWith('https://beings.town/api')).toBe(true);
    }
    // A private kind is refused before any request: the route table has no entry
    // for it, so there is nothing to send anywhere without a credential.
    for (const kind of ['bonfire', 'firesides', 'fireside', 'inbox', 'sent', 'my-scrolls']) {
      await expect(catalog.query({ kind } as unknown as TownQuery)).rejects.toThrow('不支持的 Town 请求。');
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('distinguishes authorization failure, offline, invalid HTML and upstream error', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('secret error text', { status: 401 }))
      .mockRejectedValueOnce(new Error('URL with secret'))
      .mockResolvedValueOnce(new Response('<html>loom</html>', { headers: { 'content-type': 'text/html' } }))
      .mockResolvedValueOnce(new Response('', { status: 503 }));
    const catalog = new TownCatalog(fetcher);
    const auth = await catalog.query({ kind: 'home' });
    expect(auth).toMatchObject({ ok: false, code: 'auth' });
    // An upstream body is never reflected raw, even from an unauthenticated read.
    if (!auth.ok) expect(auth.message).not.toContain('secret error text');
    expect(await catalog.query({ kind: 'seeds' })).toMatchObject({ ok: false, code: 'network' });
    expect(await catalog.query({ kind: 'scrolls' })).toMatchObject({ ok: false, code: 'network' });
    expect(await catalog.query({ kind: 'home' })).toMatchObject({ ok: false, code: 'http' });
  });

  it('bounds body size and cancels an oversized stream', async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(5 * 1024 * 1024)); },
        cancel() { cancelled = true; },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
    const catalog = new TownCatalog(async () => response);
    expect(await catalog.query({ kind: 'home' })).toMatchObject({ ok: false });
    expect(cancelled).toBe(true);
  });

  it('opens only the public pages the deleted town/ipc.ts allowed', () => {
    for (const route of ['/', '/api/seeds/help', '/api/grove/weather-kit/download', '/embers/story-7', '/scrolls/note-1', '/seeds/seed-1'])
      expect(TOWN_LINK.test(route)).toBe(true);
    for (const route of ['', '/api/messages', '/bonfire', '/embers/../api/messages', '/seeds/seed-1?token=secret', 'https://elsewhere.example/'])
      expect(TOWN_LINK.test(route)).toBe(false);
  });
});
