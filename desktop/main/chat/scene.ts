import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChatScene } from '../../shared/types';

// A room belongs to this persistent desktop profile, independently of the
// current Being, conversation session, page, Portal name or application version.
export async function loadDesktopScene(directory: string, version: string, deviceName: string): Promise<ChatScene> {
  const file = path.join(directory, 'chat-scene.json');
  let sceneId: string;
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (typeof saved?.scene_id !== 'string' || !/^desktop-[a-zA-Z0-9_-]{1,72}$/.test(saved.scene_id)) {
      throw new Error('无效的桌面场景标识。');
    }
    sceneId = saved.scene_id;
  } catch (error) {
    // Do not silently replace an unreadable room with a different identity.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    sceneId = `desktop-${randomUUID()}`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(file + '.tmp', JSON.stringify({ scene_id: sceneId }), { mode: 0o600 });
    await rename(file + '.tmp', file);
  }
  return {
    scene_id: sceneId,
    scene_meta: { client: `portal-desktop/${version}`, scene_label: `桌面·${deviceName}` },
  };
}
