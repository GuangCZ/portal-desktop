import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadDesktopScene } from '../desktop/main/chat/scene';
import { ChatProxy } from '../desktop/main/chat/proxy';
import { parseConnection } from '../desktop/main/chat/connection';

const directories: string[] = [];
async function profile() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'portal-chat-scene-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('portal-chat-scene-')) throw new Error('Unexpected test directory');
    await rm(target, { recursive: true, force: true });
  }
});

describe('persistent desktop room', () => {
  it('keeps its ID across restart and upgrade, updates labels, and separates profiles', async () => {
    const directory = await profile();
    const first = await loadDesktopScene(directory, '0.1.2', '广春泽PC');
    expect(first.scene_id).toMatch(/^desktop-[0-9a-f-]{36}$/);
    expect(first.scene_meta).toEqual({ client: 'being-desktop/0.1.2', scene_label: '桌面·广春泽PC' });
    expect(await loadDesktopScene(directory, '0.1.2', '广春泽PC')).toEqual(first);
    const upgraded = await loadDesktopScene(directory, '0.1.3', '新设备名');
    expect(upgraded.scene_id).toBe(first.scene_id);
    expect(upgraded.scene_meta).toEqual({ client: 'being-desktop/0.1.3', scene_label: '桌面·新设备名' });
    expect(JSON.parse(await readFile(path.join(directory, 'chat-scene.json'), 'utf8'))).toEqual({ scene_id: first.scene_id });
    const other = await loadDesktopScene(path.join(directory, 'other-profile'), '0.1.2', '广春泽PC');
    expect(other.scene_id).not.toBe(first.scene_id);
  });

  it.each(['{incomplete', '{"scene_id":""}'])('preserves an invalid saved identity instead of silently switching rooms: %s', async saved => {
    const directory = await profile(), file = path.join(directory, 'chat-scene.json');
    await writeFile(file, saved);
    await expect(loadDesktopScene(directory, '0.1.2', 'PC')).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(saved);
  });

  it('does not return a temporary identity if persistence fails', async () => {
    const directory = await profile();
    await mkdir(path.join(directory, 'chat-scene.json.tmp'));
    await expect(loadDesktopScene(directory, '0.1.2', 'PC')).rejects.toThrow();
    await expect(readFile(path.join(directory, 'chat-scene.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('desktop scene request scope', () => {
  const connection = parseConnection('https://fixture.test/alice/?token=fixture');
  const scene = { scene_id: 'desktop-fixture', scene_meta: { client: 'being-desktop/0.1.2', scene_label: '桌面·PC' } };

  it.each([scene, undefined])('leaves history, stop and config requests unchanged when the scene is %j', async configuredScene => {
    const upstream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = new Request('https://fixture.test', init);
      return Response.json({ body: await request.text() });
    });
    for (const [route, method, body] of [
      ['/api/stop', 'POST', '{ "stream_id": "stream" }'],
      ['/api/llm/config', 'PATCH', '{ "sbs_enabled": "off" }'],
      ['/api/history', 'GET', undefined],
    ] as const) {
      const proxy = new ChatProxy(() => connection, upstream, configuredScene);
      const result = await proxy.handle(new Request('beings://chat' + route, { method, body }));
      expect(await result.json()).toEqual({ body: body || '' });
    }
  });

  it.each(['loom-Willow', 'all', 'desktop-other'])('overrides renderer scene %s with the persistent desktop identity', async rendererScene => {
    const upstream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => Response.json(await new Request('https://fixture.test', init).json()));
    const proxy = new ChatProxy(() => connection, upstream, scene);
    const body = { message: '保持原文', session_id: 'session-fixture', attachments: [{ media_type: 'text/plain', data: 'YWJj' }] };
    const result = await proxy.handle(new Request('beings://chat/api/chat/stream', { method: 'POST', body: JSON.stringify({
      ...body, scene_id: rendererScene, scene_meta: { client: 'loom-web', scene_label: '网页' },
    }) }));
    expect(await result.json()).toEqual({ ...body, ...scene });
  });

  it.each([{}, { scene_id: 'loom-Willow', scene_meta: { client: 'loom-web', scene_label: '网页' } }])('blocks sending without a desktop identity even if the renderer supplies %j', async suppliedScene => {
    const upstream = vi.fn();
    const proxy = new ChatProxy(() => connection, upstream);
    const result = await proxy.handle(new Request('beings://chat/api/chat/stream', { method: 'POST', body: JSON.stringify({ message: '你好', ...suppliedScene }) }));
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({ error: '客户端场景不可用，暂时无法发送消息。请检查启动提示并重启客户端。' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(['{invalid', 'null', '[]', '"message"'])('rejects invalid chat JSON before sending: %s', async body => {
    const upstream = vi.fn();
    const proxy = new ChatProxy(() => connection, upstream, scene);
    const result = await proxy.handle(new Request('beings://chat/api/chat/stream', { method: 'POST', body }));
    expect(result.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
});
