// The production installer list itself — `INSTALLERS` in desktop/main/extensions.ts;
// 2026-09-16 (I3, review pass).
//
// tests/subsystem-registry.test.ts covers the registry MACHINERY with fake
// installers. This file covers the LIST: `installDesktopExtensions` is what
// main.ts calls, and nothing else in the suite constructs it.
//
// The hazard is specific, and it is the one five parallel worktrees appending to
// one array create. `ipcMain.handle` throws on a channel name that is already
// registered; `installSubsystems` catches an installer's throw into
// `report('subsystem-install:<name>', …)` and drops that subsystem (extensions.ts
// lines 156-161) so that one broken subsystem cannot stop the window opening.
// Both halves of that are deliberate — and together they mean two units that
// collide on a channel name produce a client which starts with a whole feature
// missing, writes one line to the error log, and fails no test. This asserts the
// collision does not happen.
//
// THE POINT OF THE FILE IS THAT NO LATER UNIT HAS TO EDIT IT. Nothing here names
// a subsystem, a channel or a count: a unit appends its two lines to `INSTALLERS`
// and this test starts covering it. The only reason to touch this file is if the
// context a subsystem needs to install at all changes shape.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { installDesktopExtensions, type DesktopExtensionsContext } from "../desktop/main/extensions";

const DESKTOP_ID = "22222222-2222-4222-8222-222222222222";

let directory = "";
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "subsystem-installers-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

/** The context main.ts hands over, reduced to what installation needs. Nothing
 * Electron-shaped is supplied: a subsystem that cannot build its half without a
 * window or a `WebContentsView` is required to install anyway and refuse later
 * (the `blocked` pattern), which is exactly what this exercises. */
function fixture() {
  const channels: string[] = [];
  const errors: { scope: string; error: unknown }[] = [];
  const window = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: () => {} },
  };
  const context: DesktopExtensionsContext = {
    handle: (channel: string) => { channels.push(channel); },
    exclusive: operation => operation(),
    window: () => window,
    store: { connection: null, connectionAddress: "" },
    secretStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString(),
    },
    userData: directory,
    desktopId: DESKTOP_ID,
    clientVersion: "0.9.0",
    fetchImpl: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch,
    onError: (scope, error) => { errors.push({ scope, error }); },
  };
  return { channels, errors, context };
}

test("every subsystem in the production list installs, and no two claim the same channel", async () => {
  const { channels, errors, context } = fixture();
  const extensions = installDesktopExtensions(context);
  try {
    // (a) Every installer ran to completion. A thrown installer is swallowed into
    // this scope, so an empty list is the only proof the whole list landed.
    expect(errors.filter(entry => entry.scope.startsWith("subsystem-install:"))).toEqual([]);
    // `linked()` is the fan-out after every installer has run — the one place a
    // subsystem reaches a peer — and a failure there is swallowed the same way.
    expect(errors.filter(entry => entry.scope.endsWith("-linked"))).toEqual([]);

    // (b) No channel name is registered twice. In production `handle` is
    // `createTrustedHandle`, whose `register` is `ipcMain.handle`, and that throws
    // on a duplicate — which would have landed in (a) as a dropped subsystem.
    // Collecting the names instead says WHICH name collided.
    const seen = new Set<string>();
    const duplicates = channels.filter(channel => seen.size === seen.add(channel).size);
    expect(duplicates).toEqual([]);
    // The list is not empty — a context so reduced that nothing installed would
    // pass every assertion above.
    expect(channels.length).toBeGreaterThan(0);

    // Every channel belongs to this client's namespace. A channel registered under
    // another prefix would not collide here but would collide with the shell's own
    // handlers in main.ts, which this context does not see.
    expect(channels.filter(channel => !channel.startsWith("beings:"))).toEqual([]);
  } finally {
    await extensions.quitting();
  }
});
