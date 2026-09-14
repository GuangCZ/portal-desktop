import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { SettingsStore } from '../desktop/main/app/settings';
import { TownClient, TownCredentials } from '../desktop/main/town/client';
import { TownLive } from '../desktop/main/town/live';
import { registerTownIpc } from '../desktop/main/town/ipc';

it('persists pairing display through IPC, exposes saved metadata without confirming identity, and clears it with the token', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'town-ipc-test-'));
  const storage = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() };
  const credentials = new TownCredentials(directory, storage);
  const fetcher = vi.fn(async () => Response.json({ ok: true, token: 'fixture-token-123456', town_id: 't_WillowFull', display: '柳树 (t_Willow)' }));
  const town = new TownClient(() => credentials.token, fetcher as typeof fetch);
  const live = new TownLive(() => credentials.token, () => credentials.beingId, () => {});
  const restart = vi.spyOn(live, 'restart').mockImplementation(() => {});
  const handlers = new Map<string, (...args: any[]) => any>();
  registerTownIpc({ handle: (channel, callback) => { handlers.set(channel, callback); }, exclusive: operation => operation(), town, townLive: live, townCredentials: credentials,
    store: { settings: { being: 'other-loom-being' } } as SettingsStore, secretStorage: storage, getWarning: () => undefined, clearWarning: vi.fn(), open: vi.fn() });
  try {
    await handlers.get('beings:town-pair')!({ beingId: 't_Willow', code: 'AB3XY9' });
    const reloaded = new TownCredentials(directory, storage);
    await reloaded.load();
    expect(reloaded).toMatchObject({ beingId: 't_WillowFull', display: '柳树 (t_Willow)' });
    const auth = handlers.get('beings:town-auth')!();
    expect(auth).toMatchObject({ configured: true, pairedBeingId: 't_WillowFull', display: '柳树 (t_Willow)' });
    expect(auth.beingId).toBeUndefined();
    expect(auth.token).toBeUndefined();
    expect(await handlers.get('beings:town-send')!({ kind: 'bonfire', content: 'must not send' })).toMatchObject({ ok: false, code: 'auth' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await handlers.get('beings:town-token')!('another-token-123456');
    expect(handlers.get('beings:town-auth')!()).toMatchObject({ configured: true, pairedBeingId: undefined, display: undefined });
    await handlers.get('beings:town-token')!('');
    expect(handlers.get('beings:town-auth')!()).toMatchObject({ configured: false, pairedBeingId: undefined, display: undefined });
    expect(restart).toHaveBeenCalledTimes(3);
  } finally { restart.mockRestore(); live.dispose(); await rm(directory, { recursive: true, force: true }); }
});
