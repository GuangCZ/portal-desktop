// Who calls `connectionCleared()`, and why nobody does; 2026-09-16 (IM).
//
// Four migration records in a row end with the same line — "`connectionCleared()`
// 依然没有调用方" (P1, docs/migration/i0-seams.md, i3, i4, i6 §4.7). The hook
// exists on `DesktopSubsystem`, `installSubsystems` fans it out in installation
// order, and four subsystems implement it. Nothing invokes it.
//
// IM went looking for the moment it should fire — "the saved Being address is
// cleared, or replaced by a different Being" — and MEASURED that the first half of
// that moment does not exist in this shell:
//
//   · `SettingsStore.connection` starts null and is only ever assigned a parsed
//     connection (app/settings.ts lines 72, 90, 127, 150). There is no assignment
//     back to null anywhere in `desktop/`.
//   · `save()` resolves its connection through `resolveConnection`, which falls
//     back to the current one and THROWS「请先输入 Being 链接。」when there is
//     none. An empty `connectionLink` therefore keeps the Being; it cannot remove
//     it.
//   · There is no `beings:disconnect` channel — `grep -n "handle('beings:"
//     desktop/main` lists 61 channels and none of them unbinds — and no renderer
//     entry point for one. BeingDesktop 0.8.26 has `handle('disconnect')`
//     (src/main.cjs:1476), which clears `disk.credential` and is exactly the
//     caller this shell is missing; portal-desktop never had that command.
//
// The second half — SWITCHING Beings — deliberately does NOT go through this hook.
// 0.8.26 switches inside `storeConnection` (src/main.cjs:704-716): on an identity
// change it drops the previous Being's state and binds the new one in one pass,
// with no disconnect step. This shell does the same thing in each subsystem's
// `connectionVerified`, which compares `sessionPartition` before tearing anything
// down. Announcing a clear first would push an empty ledger, an empty sidebar and
// a dropped tool link between two states that are both bound — a flicker 0.8.26
// does not have — and would then be undone microseconds later.
//
// So this file pins the finding rather than a new call site: the day someone adds
// an unbind path, the first case here fails and says what to wire up.
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SettingsStore } from '../desktop/main/app/settings';
import { installSubsystems } from '../desktop/main/extensions';
import type { DesktopExtensionsContext } from '../desktop/main/extensions';
import type { DesktopSubsystem, SubsystemContext } from '../desktop/main/subsystems/types';
import type { Settings } from '../desktop/shared/types';

const LINK = 'https://echo.example/alice/?token=first-credential';
const OTHER = 'https://other.example/bob/?token=second-credential';

function storage() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(text), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString: (data: Buffer) => {
      const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(-16));
      return Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]).toString();
    },
  };
}

describe('the missing caller of connectionCleared', () => {
  it('has no way to clear a saved Being, which is why nothing announces one', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'beings-cleared-'));
    try {
      const keyed = storage();
      const store = new SettingsStore(directory, keyed, process.execPath);
      await store.load();
      expect(store.connection).toBeNull();
      // Saving without ever naming a Being is the only refusal in this area.
      await expect(store.save({ ...store.settings, workspace: directory })).rejects.toThrow('请先输入 Being 链接。');

      await store.save({ ...store.settings, workspace: directory, connectionLink: LINK });
      expect(store.connection?.being).toBe('alice');

      // AN EMPTY LINK KEEPS THE BEING. This is the shape a "disconnect" would
      // take if the renderer had one, and it is not a disconnect.
      for (const connectionLink of ['', '   ', undefined]) {
        await store.save({ ...store.settings, workspace: directory, connectionLink });
        expect(store.connection?.being).toBe('alice');
        expect(store.connectionAddress).toContain('first-credential');
      }

      // Switching is a replacement, never a clear: the address that comes back is
      // the new Being's, in one step.
      await store.save({ ...store.settings, workspace: directory, connectionLink: OTHER });
      expect(store.connection?.being).toBe('bob');
      expect(store.connectionAddress).toContain('second-credential');
      expect(store.connectionAddress).not.toContain('first-credential');

      // And it survives a restart as the new one — there is no null state to
      // reload into, so a fresh process comes up bound rather than unbound.
      const reopened = new SettingsStore(directory, keyed, process.execPath);
      await reopened.load();
      expect(reopened.connection?.being).toBe('bob');
      expect(reopened.settings.being).toBe('bob');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('still fans the hook out in installation order when something does call it', async () => {
    // The hook itself is not broken, and must not be deleted as dead code: it is
    // the shape an unbind would use. Installation order for cleared, reverse for
    // quitting (docs/migration/i0-seams.md §A).
    const directory = await mkdtemp(path.join(os.tmpdir(), 'beings-cleared-'));
    try {
      const calls: string[] = [];
      const errors: string[] = [];
      const make = (key: string, fail = false) => {
        const install = (_ctx: SubsystemContext): DesktopSubsystem => ({
          key: key as never,
          async connectionCleared() { calls.push(key); if (fail) throw new Error('boom'); },
        });
        Object.defineProperty(install, 'name', { value: `install${key}` });
        return install;
      };
      const context: DesktopExtensionsContext = {
        handle: () => {},
        exclusive: operation => operation(),
        window: () => null,
        store: { connection: null, connectionAddress: '', settings: {} as Settings, extras: {}, saveExtra: async () => {} },
        secretStorage: storage(),
        userData: directory,
        desktopId: '11111111-1111-4111-8111-111111111111',
        onError: scope => { errors.push(scope); },
      };
      const extensions = installSubsystems(context, [make('alpha'), make('beta', true), make('gamma')]);
      await extensions.connectionCleared();
      expect(calls).toEqual(['alpha', 'beta', 'gamma']);
      // One failure is reported and does not stop the rest — the same rule the
      // other three fan-outs follow.
      expect(errors).toEqual(['beta-cleared']);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
