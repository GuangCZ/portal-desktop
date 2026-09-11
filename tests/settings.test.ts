import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SettingsStore } from '../desktop/settings';
import { portalConfig } from '../desktop/portal';
import { parse } from 'smol-toml';

it('persists credentials encrypted, reloads and preserves them on workspace-only changes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'beings-settings-'));
  const key = randomBytes(32);
  const storage = {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(text), cipher.final(), cipher.getAuthTag()]); },
    decryptString: (data: Buffer) => { const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); cipher.setAuthTag(data.subarray(-16)); return Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]).toString(); },
  };
  try {
    const store = new SettingsStore(dir, storage, process.execPath);
    await store.load(); expect(store.connection).toBeNull();
    expect(store.settings.allowExec).toBe(true);
    expect(store.settings.kitsEnabled).toBe(true);
    expect(parse(portalConfig(store.settings))).toMatchObject({ kits_enabled: true, tools: { exec: true, custom_tools_enabled: true } });
    await store.save({ ...store.settings, workspace: path.join(dir, '中文 workspace'), connectionLink: 'https://echo.example/alice/?token=private-test-credential&secret=relay-secret' });
    expect(JSON.stringify(store.settings)).not.toContain('private-test-credential');
    const disk = await readFile(path.join(dir, 'connection.json'), 'utf8');
    expect(disk).not.toContain('private-test-credential'); expect(disk).not.toContain('relay-secret');
    const reopened = new SettingsStore(dir, storage, process.execPath); await reopened.load();
    expect(reopened.connection?.relaySecret).toBe('relay-secret');
    expect(reopened.settings.allowExec).toBe(true);
    expect(reopened.settings.kitsEnabled).toBe(true);
    await reopened.save({ ...reopened.settings, portalName: 'new-name' });
    expect(reopened.connection?.token).toBe('private-test-credential');
    expect(reopened.settings).toMatchObject({ being: 'alice', endpoint: 'https://echo.example/alice', portalName: 'new-name' });
    expect(reopened.connection).toMatchObject({ relaySecret: 'relay-secret', link: 'https://echo.example/alice/?token=private-test-credential' });
    await expect(reopened.save({ ...reopened.settings, connectionLink: 'another_being' })).rejects.toThrow('完整的 Being 链接');
    await reopened.save({ ...reopened.settings, connectionLink: 'https://other.example/another_being/?token=new-credential&secret=new-relay-secret', portalName: 'my-laptop' });
    expect(reopened.settings).toMatchObject({ being: 'another_being', endpoint: 'https://other.example/another_being', portalName: 'my-laptop' });
    expect(reopened.connection).toMatchObject({ relaySecret: 'new-relay-secret', token: 'new-credential', link: 'https://other.example/another_being/?token=new-credential' });
    await reopened.save({ ...reopened.settings, allowExec: false, kitsEnabled: false });
    const optedOut = new SettingsStore(dir, storage, process.execPath); await optedOut.load();
    expect(optedOut.settings.allowExec).toBe(false);
    expect(optedOut.settings.kitsEnabled).toBe(false);
    expect(parse(portalConfig(optedOut.settings))).toMatchObject({ kits_enabled: false, tools: { exec: false, custom_tools_enabled: false } });
    const unavailable = new SettingsStore(dir, { ...storage, isEncryptionAvailable: () => false }, process.execPath);
    await expect(unavailable.save({ ...store.settings, connectionLink: 'https://echo.example/alice/?token=test' })).rejects.toThrow('密钥库');
    await expect(store.save({ ...store.settings, portalName: 'bad\nname' })).rejects.toThrow();
    await expect(store.save({ ...store.settings, workspace: '../outside' })).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
