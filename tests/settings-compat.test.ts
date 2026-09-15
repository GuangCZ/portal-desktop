// A BeingDesktop 0.8.x profile has to open here unchanged, and has to stay
// openable by BeingDesktop 0.8.x afterwards. The fixture mirrors BeingDesktop
// docs/interfaces.md §7「持久化格式」; 2026-09-16.
import { afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SettingsStore } from "../desktop/main/app/settings";

const directories: string[] = [];
afterEach(async () => { for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temporary() {
  const root = await mkdtemp(path.join(os.tmpdir(), "being-settings-compat-"));
  directories.push(root); return root;
}
// safeStorage is unavailable in a test process. This stands in for it with a
// reversible, deterministic transform so the stored ciphertext can be compared.
const storage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`sealed:${value}`, "utf8"),
  decryptString: (value: Buffer) => {
    const text = value.toString("utf8");
    if (!text.startsWith("sealed:")) throw new Error("Credential protection unavailable");
    return text.slice("sealed:".length);
  },
};
const seal = (address: string) => Buffer.from(`sealed:${address}`, "utf8").toString("base64");
const read = async (dir: string) => JSON.parse(await readFile(path.join(dir, "settings.json"), "utf8"));

const address = "https://echo.example/alice/?token=fixture-token&secret=relay-fixture&api=https://echo.example/alice/api";
// Every key BeingDesktop 0.8.x writes that this client has no field for.
const unknown = {
  closeToTray: false, chatMode: "native",
  typography: { chatFontSize: 15, codeFontSize: 13 },
  colors: { accent: "#3b6ea5" },
  chatBackground: { preset: "glass-landscape", image: "", transparency: 0.4 },
  glassStrength: 0.7,
  onboarding: { step: "connected", completed: true },
  onboardingLoomConnected: true,
  sidebar: { projects: ["/Users/fixture/项目"], owners: {} },
  orchestration: { enabled: true, defaultAgent: "claude", paths: {} },
  desktopAutoUpdate: true,
  portalExecutable: "/Users/fixture/.heart-portal/bin/heart-portal",
  portalConfig: "/Users/fixture/.heart-portal/portal.toml",
  portalUpdateNotifiedVersion: "0.8.26",
  adoptedPortal: { bindingHash: "a".repeat(64) },
};
async function beingDesktopProfile(overrides: Record<string, unknown> = {}) {
  const dir = await temporary();
  await writeFile(path.join(dir, "settings.json"), JSON.stringify({
    ...unknown,
    workspace: path.join(dir, "项目工作区"),
    portalWorkspace: path.join(dir, "portal-workspace"),
    managedPortal: { workspace: path.join(dir, "portal-workspace"), executable: unknown.portalExecutable,
      configPath: unknown.portalConfig, release: "0.8.2", version: "0.8.2", groveKitsDir: path.join(dir, "grove-kits") },
    credential: seal(address),
    ...overrides,
  }, null, 2));
  return dir;
}

it("reads a BeingDesktop profile, including the api parameter and both workspaces", async () => {
  const dir = await beingDesktopProfile();
  const store = new SettingsStore(dir, storage, "/client/heart-portal");
  await store.load();
  expect(store.connection).toMatchObject({ being: "alice", token: "fixture-token", relaySecret: "relay-fixture",
    endpoint: "https://echo.example/alice/api", link: "https://echo.example/alice/?token=fixture-token" });
  expect(store.settings).toMatchObject({ hasToken: true, endpoint: "https://echo.example/alice/api", being: "alice",
    // Settings.workspace is the Portal working directory; BeingDesktop's own
    // top-level `workspace` is the Desktop project directory.
    workspace: path.join(dir, "portal-workspace"), projectWorkspace: path.join(dir, "项目工作区"),
    portalBinary: "/client/heart-portal" });
});

it("prefers managedPortal.workspace and falls back to portalWorkspace", async () => {
  const managed = await beingDesktopProfile({ managedPortal: { workspace: "/deployed/grove-workspace" } });
  const deployed = new SettingsStore(managed, storage, "/client/heart-portal");
  await deployed.load();
  expect(deployed.settings.workspace).toBe("/deployed/grove-workspace");
  const plain = await beingDesktopProfile({ managedPortal: undefined });
  const store = new SettingsStore(plain, storage, "/client/heart-portal");
  await store.load();
  expect(store.settings.workspace).toBe(path.join(plain, "portal-workspace"));
});

it("writes back every unknown key and the original ciphertext when the address is unchanged", async () => {
  const dir = await beingDesktopProfile();
  const before = await read(dir);
  const store = new SettingsStore(dir, storage, "/client/heart-portal");
  await store.load();
  const workspace = path.join(dir, "another-portal-workspace");
  await store.save({ ...store.settings, workspace, portalName: "my-laptop", autoStart: true });
  const after = await read(dir);
  for (const key of Object.keys(unknown)) expect(after[key]).toEqual(before[key]);
  expect(after.workspace).toBe(before.workspace);
  expect(after.credential).toBe(before.credential);
  expect(after.portalWorkspace).toBe(workspace);
  // BeingDesktop reads managedPortal.workspace first, so both records have to
  // agree or this client loses the workspace the user just chose.
  expect(after.managedPortal).toEqual({ ...before.managedPortal, workspace });
  expect(after.portalName).toBe("my-laptop");
  expect(after.autoStart).toBe(true);
  const reopened = new SettingsStore(dir, storage, "/client/heart-portal");
  await reopened.load();
  expect(reopened.settings).toMatchObject({ workspace, portalName: "my-laptop", autoStart: true,
    projectWorkspace: path.join(dir, "项目工作区") });
  expect(reopened.connection).toEqual(store.connection);
});

it("exposes the saved address so a rollback restores it with the api parameter intact", async () => {
  const dir = await beingDesktopProfile();
  const store = new SettingsStore(dir, storage, "/client/heart-portal");
  await store.load();
  const connection = store.connection!;
  // Saving the address back unchanged reuses the ciphertext already on disk.
  await store.save({ ...store.settings, connectionLink: store.connectionAddress });
  expect((await read(dir)).credential).toBe(seal(address));
  expect(store.connection).toEqual(connection);
  // A link reassembled from the parsed parts carries no `api=`, so it would
  // move this profile's API base back to the Loom path. That is what
  // main.ts's rollback avoids by saving `connectionAddress` instead.
  const reassembled = `${connection.link}&relay_secret=${encodeURIComponent(connection.relaySecret)}`;
  await store.save({ ...store.settings, connectionLink: reassembled });
  expect(store.connection?.endpoint).toBe("https://echo.example/alice");
  expect((await read(dir)).credential).toBe(seal(reassembled));
});

it("re-encrypts only when the user saves a different address", async () => {
  const dir = await beingDesktopProfile();
  const store = new SettingsStore(dir, storage, "/client/heart-portal");
  await store.load();
  const next = "https://other.example/bruno/?token=new-token&relay_secret=new-relay";
  await store.save({ ...store.settings, connectionLink: next });
  expect((await read(dir)).credential).toBe(seal(next));
  expect(store.settings).toMatchObject({ being: "bruno", endpoint: "https://other.example/bruno", hasToken: true });
  const reopened = new SettingsStore(dir, storage, "/client/heart-portal");
  await reopened.load();
  expect(reopened.connection).toMatchObject({ token: "new-token", relaySecret: "new-relay" });
});

it("republishes an earlier connection.json profile of this client as settings.json", async () => {
  const dir = await temporary();
  const workspace = path.join(dir, "work");
  await mkdir(workspace);
  await writeFile(path.join(dir, "connection.json"), JSON.stringify({ version: 1, credential:
    Buffer.from(`sealed:${JSON.stringify({ link: "https://echo.example/alice/?token=fixture-token", relaySecret: "relay-fixture" })}`, "utf8").toString("base64"),
    settings: { endpoint: "https://echo.example/alice", being: "alice", workspace, portalBinary: "/removed/old-portal",
      portalName: "imported-name", autoStart: true, backgroundEnabled: false, allowExec: false, kitsEnabled: false } }));
  const store = new SettingsStore(dir, storage, "/client/heart-portal");
  await store.load();
  expect(store.settings).toMatchObject({ portalName: "imported-name", workspace, allowExec: false, kitsEnabled: false,
    autoStart: true, backgroundEnabled: false, hasToken: true, portalBinary: "/client/heart-portal" });
  const disk = await read(dir);
  expect(disk).toMatchObject({ portalWorkspace: workspace, portalName: "imported-name", autoStart: true, allowExec: false });
  expect(disk.credential).toBe(seal("https://echo.example/alice/?token=fixture-token&relay_secret=relay-fixture"));
  // The old file stays where it is; an older build of this client keeps working.
  await expect(readFile(path.join(dir, "connection.json"), "utf8")).resolves.toContain("version");
  const reopened = new SettingsStore(dir, storage, "/client/heart-portal");
  await reopened.load();
  expect(reopened.connection).toEqual(store.connection);
});
