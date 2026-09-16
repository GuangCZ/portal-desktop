// Ported from BeingDesktop test/town-controller.test.cjs on 2026-09-16. Fixtures copied verbatim.
// The fixture uses a real temporary directory, exactly as BeingDesktop did. crypto.randomUUID is
// substituted through the constructor rather than by mocking the module.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it } from "vitest";
import { TownController, requireTownIdentity } from "../desktop/main/town/channel/town-controller";
import type { TownControllerOptions } from "../desktop/main/town/channel/town-controller";

const confirmation = () => ({ confirmed: true, permissions: { files: true, exec: false, web: false } });
function deferred() {
  let resolve!: (value?: any) => void, reject!: (reason?: any) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

interface Overrides {
  context?: Record<string, unknown>;
  portalState?: Record<string, unknown>;
  platform?: string;
  arch?: string;
  configFactory?: TownControllerOptions["configFactory"];
  randomUUID?: () => string;
  groveConfigText?: (text: string, kitsDir: string) => string;
  inspectInstallation?: (h: any) => any;
  inspectPortal?: (h: any) => unknown;
  install?: (h: any, options: any) => any;
  save?: (h: any, value: any) => unknown;
  start?: (h: any) => any;
  onChange?: (h: any) => void;
}

async function harness(overrides: Overrides = {}) {
  // macOS resolves os.tmpdir() through the /var symlink, which validatePortalWorkspace refuses.
  // The fixture is otherwise unchanged: a fresh directory directly under the temporary root.
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporaryRoot, "being-town-controller-test-"));
  cleanups.push(() => {
    expect(path.dirname(path.resolve(root))).toBe(path.resolve(temporaryRoot));
    expect(path.basename(root).startsWith("being-town-controller-test-")).toBe(true);
    return fs.rm(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, "workspace");
  const installedDirectory = path.join(root, "managed-portal", "v0.8.0");
  await fs.mkdir(workspace);
  await fs.mkdir(installedDirectory, { recursive: true });
  const executable = path.join(installedDirectory, "heart-portal.exe");
  await fs.writeFile(executable, "Non-executable unit-test fixture");
  const calls: string[] = [];
  const context: Record<string, any> = {
    configured: true, connected: true, exiting: false,
    workspace, portalWorkspace: workspace, portalExecutable: "", portalConfig: "", beingName: "fixture-being",
    connectionId: "private-identity-fixture", credential: "private-credential-fixture",
    ...overrides.context,
  };
  const portalState: Record<string, any> = { status: "not_configured", owned: false, detail: "", ...overrides.portalState };
  const installation: Record<string, any> = { status: "installed", phase: "not_started", version: "0.8.0", executable, verified: true, started: false };
  const h: any = { root, workspace, installedDirectory, executable, calls, context, portalState, installation, saved: null, progress: [] };
  h.defaultWorkspace = path.join(root, "portal-workspace");
  const installer = {
    async inspect() {
      calls.push("installer.inspect");
      return overrides.inspectInstallation ? overrides.inspectInstallation(h) : { ...installation };
    },
    async install(options: any) {
      calls.push("installer.install");
      options.onProgress({ phase: "download", receivedBytes: 0, totalBytes: 12193280 });
      if (overrides.install) return overrides.install(h, options);
      options.onProgress({ phase: "hash", receivedBytes: 12193280, totalBytes: 12193280 });
      options.onProgress({ phase: "install", receivedBytes: 12193280, totalBytes: 12193280 });
      return { ...installation };
    },
  };
  const portal = {
    get state() { return { ...portalState } as any; },
    async inspect() { calls.push("portal.inspect"); if (overrides.inspectPortal) await overrides.inspectPortal(h); return { ...portalState }; },
  };
  h.controller = new TownController({
    installer, portal, getContext: () => ({ ...context }), platform: overrides.platform || "win32", arch: overrides.arch || "x64",
    defaultWorkspace: h.defaultWorkspace,
    ...(overrides.configFactory ? { configFactory: overrides.configFactory } : {}),
    ...(overrides.randomUUID ? { randomUUID: overrides.randomUUID } : {}),
    ...(overrides.groveConfigText ? { groveConfigText: overrides.groveConfigText } : {}),
    async saveDeployment(value) {
      calls.push("save");
      h.saved = { ...value };
      expect((await fs.stat(value.configPath)).isFile()).toBe(true);
      Object.assign(context, { portalWorkspace: value.workspace, portalExecutable: value.executable, portalConfig: value.configPath, managedPortal: { ...value } });
      if (overrides.save) await overrides.save(h, value);
    },
    async startPortal() {
      calls.push("start");
      expect(h.saved, "Starting requires a saved deployment").toBeTruthy();
      if (overrides.start) return overrides.start(h);
      return { status: "running", health: "unknown" };
    },
    onChange() {
      h.progress.push(h.controller.state().portalInstall);
      if (overrides.onChange) overrides.onChange(h);
    },
  });
  return h;
}

it("deployment requires exact confirmation and the supported permission combination", async () => {
  const h = await harness();
  for (const value of [undefined, null, [], {}, { ...confirmation(), confirmed: false },
    { ...confirmation(), extra: true }, { confirmed: true, permissions: {} },
    { confirmed: true, permissions: { files: false, exec: false, web: false } },
    { confirmed: true, permissions: { files: true, exec: true, web: false } },
    { confirmed: true, permissions: { files: true, exec: false, web: true } }]) {
    await expect(h.controller.deploy(value)).rejects.toThrow(/确认/);
  }
  expect(h.calls).toEqual([]);
});

it("inherited, accessor, symbol, and hidden confirmation fields are not accepted", async () => {
  let getterReads = 0;
  const inheritedPermissions = Object.assign(Object.create({ web: false }), { files: true, exec: false, extra: true });
  const withHidden = Object.defineProperty(confirmation(), "extra", { value: true });
  const inputs = [
    { ...confirmation(), [Symbol("extra")]: true }, withHidden,
    Object.create(confirmation()), { confirmed: true, permissions: inheritedPermissions },
    { get confirmed() { getterReads++; return true; }, permissions: confirmation().permissions },
  ];
  for (const value of inputs) {
    const h = await harness();
    await expect(h.controller.deploy(value)).rejects.toThrow(/确认/);
    expect(h.calls).toEqual([]);
  }
  expect(getterReads).toBe(0);
});

it("unsupported platform or architecture fails before inspecting processes or installing", async () => {
  for (const [platform, arch] of [["darwin", "ia32"], ["linux", "x64"], ["win32", "arm64"]]) {
    const h = await harness({ platform, arch });
    expect(h.controller.state().platformSupported).toBe(false);
    await expect(h.controller.deploy(confirmation())).rejects.toThrow(/已校验/);
    expect(h.calls).toEqual([]);
  }
});

it("Mac deployment supports both architectures and retains external Portal ownership", async () => {
  for (const arch of ["arm64", "x64"]) {
    const h = await harness({ platform: "darwin", arch, portalState: { status: "external", pid: 123, owned: false } });
    expect(h.controller.state().platformSupported).toBe(true);
    const result = await h.controller.deploy(confirmation());
    expect(result.status).toBe("external");
    expect(h.calls).toEqual(["portal.inspect"]);
    expect(h.saved).toBeNull();
  }
});

it("Mac fresh deployment persists the selected release metadata before starting", async () => {
  const h = await harness({ platform: "darwin", arch: "arm64" });
  const result = await h.controller.deploy(confirmation());
  expect(result.status).toBe("running");
  expect(h.calls.indexOf("save") < h.calls.indexOf("start")).toBe(true);
  expect(h.controller.state().portalInstall.totalBytes).toBe(12205520);
});

it("unconfigured, disconnected, and exiting contexts cannot begin deployment", async () => {
  for (const context of [{ configured: false }, { connected: false }, { exiting: true }]) {
    const h = await harness({ context });
    await expect(h.controller.deploy(confirmation())).rejects.toThrow(/连接 Being/);
    expect(h.calls).toEqual([]);
  }
});

it("missing real workspace fails before any download or persistence", async () => {
  const h = await harness();
  h.context.portalWorkspace = path.join(h.root, "does-not-exist");
  await expect(h.controller.deploy(confirmation())).rejects.toThrow(/工作区/);
  expect(h.calls).toEqual(["portal.inspect"]);
  expect(await fs.stat(h.context.portalWorkspace).then(() => true, () => false)).toBe(false);
});

it("one-click configuration previews and creates a dedicated default workspace, then reuses it", async () => {
  const h = await harness({ context: { portalWorkspace: "" } });
  expect(h.controller.state().portalWorkspace).toEqual({ path: h.defaultWorkspace, automatic: true, readOnly: false, source: "new_portal" });
  await expect(fs.stat(h.defaultWorkspace)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(h.controller.deploy({ confirmed: false })).rejects.toThrow(/确认/);
  await expect(fs.stat(h.defaultWorkspace)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await h.controller.deploy(confirmation())).status).toBe("running");
  const realWorkspace = await fs.realpath(h.defaultWorkspace);
  expect(h.context.portalWorkspace).toBe(realWorkspace);
  expect(h.context.workspace).toBe(h.workspace);
  expect(h.saved.workspace).toBe(realWorkspace);
  expect(h.controller.state().portalWorkspace).toEqual({ path: realWorkspace, automatic: false, readOnly: true, source: "managed_portal" });
  expect(JSON.parse(/^workspace = (.+)$/m.exec(await fs.readFile(h.saved.configPath, "utf8"))![1])).toBe(realWorkspace);
  expect(await fs.readdir(realWorkspace)).toEqual([]);
  const saved = { ...h.saved };
  h.calls.length = 0;
  await h.controller.deploy(confirmation());
  expect(h.calls).toEqual(["portal.inspect", "installer.inspect", "start"]);
  expect(h.saved).toEqual(saved);
});

it("an owned Portal for a previous identity is preserved without reporting it as the current connection", async () => {
  const h = await harness({ context: { identityRevision: 2, portalIdentityRevision: 1 }, portalState: { status: "running", owned: true } });
  const result = await h.controller.deploy(confirmation());
  expect(result.status).toBe("existing_connection");
  expect(result.detail).toMatch(/之前的 Being/);
  expect(h.calls).toEqual(["portal.inspect"]);
  expect(h.saved).toBeNull();
});

it("identity changes while inspecting processes prevent workspace creation and installation", async () => {
  const h = await harness({ context: { portalWorkspace: "", identityRevision: 1 }, inspectPortal(h: any) { h.context.identityRevision++; } });
  await expect(h.controller.deploy(confirmation())).rejects.toThrow(/变化/);
  expect(h.calls).toEqual(["portal.inspect"]);
  await expect(fs.stat(h.defaultWorkspace)).rejects.toMatchObject({ code: "ENOENT" });
});

it("external and owned Portal instances are reused without installer, config writes, or new launch", async () => {
  for (const portalState of [{ status: "external", owned: false }, { status: "running", owned: true }]) {
    const h = await harness({ portalState });
    const result = await h.controller.deploy(confirmation());
    expect(result.status).toBe(portalState.status);
    expect(h.calls).toEqual(["portal.inspect"]);
    expect(await fs.readdir(h.installedDirectory)).toEqual(["heart-portal.exe"]);
  }
});

it("any existing program or configuration selection is preserved without automatic start", async () => {
  for (const context of [{ portalExecutable: "existing-program" }, { portalConfig: "existing-config" },
    { portalExecutable: "existing-program", portalConfig: "existing-config" }]) {
    const h = await harness({ context });
    expect((await h.controller.deploy(confirmation())).status).toBe("existing_configuration");
    expect(h.calls).toEqual(["portal.inspect"]);
    expect(h.saved).toBeNull();
  }
});

it("uncertain process state blocks installer and launch", async () => {
  const h = await harness({ portalState: { status: "error", detail: "Process inspection unavailable" } });
  await expect(h.controller.deploy(confirmation())).rejects.toThrow(/Process inspection/);
  expect(h.calls).toEqual(["portal.inspect"]);
});

it("deployment validates workspace, installs, writes config, saves, then starts once", async () => {
  const h = await harness();
  const result = await h.controller.deploy(confirmation());
  expect(result.status).toBe("running");
  expect(h.calls).toEqual(["portal.inspect", "installer.install", "save", "start"]);
  const toml = await fs.readFile(h.saved.configPath, "utf8");
  expect(toml).toMatch(/exec = false/);
  expect(toml).toMatch(/workspace = /);
  expect(h.saved.workspace).toBe(await fs.realpath(h.workspace));
  expect(h.controller.state().portalInstall.capabilities.strictSandbox).toBe(false);
  expect(h.progress.some((item: any) => item.phase === "hash")).toBe(true);
  expect(h.progress.some((item: any) => item.phase === "install")).toBe(true);
  expect(result.detail).toMatch(/等待中继/);
  expect(JSON.stringify(h.controller.state())).not.toMatch(/private-identity|private-credential/);
});

it("save failure cleans the new configuration, retains the binary and unrelated files, and never launches", async () => {
  const h = await harness({ save() { throw new Error("Save failed"); } });
  await fs.writeFile(path.join(h.installedDirectory, "keep.toml"), "existing = true");
  await expect(h.controller.deploy(confirmation())).rejects.toThrow();
  expect(h.calls.includes("start")).toBe(false);
  expect((await fs.readdir(h.installedDirectory)).sort()).toEqual(["heart-portal.exe", "keep.toml"]);
  expect(h.controller.state().portalInstall.recovery).toEqual({ program: "retained_verified", configuration: "removed", process: "unknown" });
});

it("exclusive-create collision must not delete the preexisting configuration", async () => {
  const fixedId = "11111111-2222-4333-8444-555555555555";
  const h = await harness({ randomUUID: () => fixedId });
  const existing = path.join(h.installedDirectory, `desktop-${fixedId}.toml`);
  await fs.writeFile(existing, "preserve_this = true");
  await expect(h.controller.deploy(confirmation())).rejects.toThrow();
  expect(h.calls.includes("save")).toBe(false);
  expect(h.calls.includes("start")).toBe(false);
  expect(await fs.readFile(existing, "utf8")).toBe("preserve_this = true");
  expect(h.controller.state().portalInstall.recovery).toEqual({ program: "retained_verified", configuration: "not_created", process: "unknown" });
});

it("startup failure preserves an already saved configuration for retry", async () => {
  const h = await harness({ start(h: any) { h.portalState.status = "error"; throw new Error("Start failed"); } });
  await expect(h.controller.deploy(confirmation())).rejects.toThrow();
  expect((await fs.stat(h.saved.configPath)).isFile()).toBe(true);
  expect(h.controller.state().portalInstall.phase).toBe("failed");
  expect(h.controller.state().portalInstall.recovery).toEqual({ program: "retained_verified", configuration: "saved", process: "error" });
});

it("one-click deployment restarts its verified saved configuration without another install", async () => {
  const h = await harness();
  await h.controller.deploy(confirmation());
  Object.assign(h.context, { portalExecutable: h.saved.executable, portalConfig: h.saved.configPath, managedPortal: { ...h.saved } });
  h.calls.length = 0;
  const result = await h.controller.deploy(confirmation());
  expect(result.status).toBe("running");
  expect(h.calls).toEqual(["portal.inspect", "installer.inspect", "start"]);
});

it("one-click retry preserves changed configurations and does not start them", async () => {
  const h = await harness();
  await h.controller.deploy(confirmation());
  Object.assign(h.context, { portalExecutable: h.saved.executable, portalConfig: h.saved.configPath, managedPortal: { ...h.saved } });
  await fs.appendFile(h.saved.configPath, "\n# User customization\n");
  h.calls.length = 0;
  await expect(h.controller.deploy(confirmation())).rejects.toThrow(/未能启动/);
  expect(h.calls.includes("start")).toBe(false);
  expect(await fs.readFile(h.saved.configPath, "utf8")).toMatch(/User customization/);
});

// The original drove src/grove-portal.cjs enableGrovePortal, which belongs to the Grove/Kits
// migration unit. Here the Grove config extension is an injected hook, so this case waits for
// the real grovePortalConfigText and enableGrovePortal.
it.skip("one-click Portal retry accepts the verified Grove configuration extension", () => {});

it("one-click retry rejects modified binaries and workspace changes before launch", async () => {
  for (const change of ["binary", "workspace"]) {
    const h = await harness();
    await h.controller.deploy(confirmation());
    Object.assign(h.context, { portalExecutable: h.saved.executable, portalConfig: h.saved.configPath, managedPortal: { ...h.saved } });
    if (change === "binary") h.installation.verified = false;
    else h.context.managedPortal.workspace = "different-workspace";
    h.calls.length = 0;
    await expect(h.controller.deploy(confirmation())).rejects.toThrow();
    expect(h.calls.includes("start")).toBe(false);
    expect(h.calls.includes("installer.install")).toBe(false);
  }
});

it("identity, workspace, or selected paths changing during download leave the installed binary unstarted", async () => {
  for (const change of [(h: any) => { h.context.connectionId = "new-identity"; },
    (h: any) => { h.context.identityRevision = 2; }, (h: any) => { h.context.beingName = "different-being"; },
    (h: any) => { h.context.portalExecutable = "different-program"; }, (h: any) => { h.context.portalConfig = "different-config"; },
    (h: any) => { h.context.portalWorkspace = path.join(h.root, "other-workspace"); }, (h: any) => { h.context.exiting = true; }]) {
    const h = await harness({ install(h: any) { change(h); return { ...h.installation }; } });
    await expect(h.controller.deploy(confirmation())).rejects.toThrow(/变化/);
    expect(h.calls.includes("save")).toBe(false);
    expect(h.calls.includes("start")).toBe(false);
    expect(await fs.readdir(h.installedDirectory)).toEqual(["heart-portal.exe"]);
  }
});

it("loss of connected or configured state during download prevents saving and starting", async () => {
  for (const field of ["connected", "configured"]) {
    const h = await harness({ install(h: any) { h.context[field] = false; return { ...h.installation }; } });
    await expect(h.controller.deploy(confirmation())).rejects.toThrow();
    expect(h.calls.includes("save")).toBe(false);
    expect(h.calls.includes("start")).toBe(false);
  }
});

it("identity and workspace are checked again after asynchronous persistence before start", async () => {
  for (const field of ["connectionId", "identityRevision", "beingName", "portalWorkspace", "portalExecutable", "portalConfig"]) {
    const h = await harness({ save(h: any) { h.context[field] = "changed-during-save"; } });
    await expect(h.controller.deploy(confirmation())).rejects.toThrow();
    expect(h.calls.includes("start")).toBe(false);
    expect((await fs.stat(h.saved.configPath)).isFile()).toBe(true);
  }
});

it("duplicate deployment clicks share one workflow and a failed workflow can be retried", async () => {
  const started = deferred();
  const release = deferred();
  let attempts = 0;
  const h = await harness({ async install(h: any) {
    attempts++;
    if (attempts === 1) { started.resolve(); await release.promise; throw new Error("First fixture download failed"); }
    return { ...h.installation };
  } });
  const first = h.controller.deploy(confirmation());
  const duplicate = h.controller.deploy(confirmation());
  expect(first).toBe(duplicate);
  const rejection = first.then(() => { throw new Error("expected a rejection"); }, (error: unknown) => error);
  await started.promise;
  expect(h.calls.filter((call: string) => call === "installer.install").length).toBe(1);
  release.resolve();
  expect(await rejection).toBeInstanceOf(Error);
  expect((await h.controller.deploy(confirmation())).status).toBe("running");
  expect(attempts).toBe(2);
  expect(h.calls.filter((call: string) => call === "start").length).toBe(1);
});

it("public state does not publish credential-bearing failure text or unknown progress fields", async () => {
  const h = await harness({
    install(_h: any, { onProgress }: any) {
      onProgress({ phase: "download", receivedBytes: 3, totalBytes: 12193280,
        authorization: "Bearer fixture-private-secret", url: "https://private.test/?token=fixture-private-secret" });
      throw new Error("Download https://private.test/?token=fixture-private-secret Authorization: Bearer fixture-private-secret");
    },
  });
  let failure: any;
  try { await h.controller.deploy(confirmation()); } catch (error) { failure = error; }
  expect(failure).toBeTruthy();
  expect(failure.message).not.toMatch(/fixture-private-secret|Authorization:/);
  expect(JSON.stringify(h.controller.state())).not.toMatch(/fixture-private-secret|authorization|private\.test/);
  expect(JSON.stringify(h.progress)).not.toMatch(/fixture-private-secret|authorization|private\.test/);
});

it("observer exceptions do not interrupt deployment or leave serialization stuck", async () => {
  const h = await harness({ onChange() { throw new Error("Observer failed"); } });
  expect((await h.controller.deploy(confirmation())).status).toBe("running");
});

it("a stale refresh cannot overwrite deployment progress after installation begins", async () => {
  const inspection = deferred();
  const inspectionStarted = deferred();
  const installation = deferred();
  const installationStarted = deferred();
  const h = await harness({
    inspectInstallation() { inspectionStarted.resolve(); return inspection.promise; },
    async install(h: any, { onProgress }: any) {
      onProgress({ phase: "download", receivedBytes: 10, totalBytes: 12193280 });
      installationStarted.resolve();
      await installation.promise;
      return { ...h.installation };
    },
  });
  const refresh = h.controller.refresh();
  await inspectionStarted.promise;
  const deployment = h.controller.deploy(confirmation());
  await installationStarted.promise;
  inspection.resolve({ ...h.installation, status: "not_installed", phase: "not_started", verified: false });
  await refresh;
  const phase = h.controller.state().portalInstall.phase;
  installation.resolve();
  await deployment;
  expect(phase).toBe("download");
});

it("a refresh started before deployment cannot overwrite its completed state with an old failure", async () => {
  const inspection = deferred();
  const inspectionStarted = deferred();
  const h = await harness({ inspectInstallation() { inspectionStarted.resolve(); return inspection.promise; } });
  const refresh = h.controller.refresh();
  await inspectionStarted.promise;
  await h.controller.deploy(confirmation());
  inspection.reject(new Error("Earlier inspection failed"));
  await refresh;
  expect(h.controller.state().portalInstall.status).toBe("installed");
  expect(h.controller.state().portalInstall.phase).toBe("running");
});

it("unsupported room management directs users to Being without claiming Town pairing is unavailable", () => {
  expect(requireTownIdentity).toThrow(/暂不支持创建或加入围炉，请通过 Being 完成/);
});

it("Desktop project changes never replace a deployed Portal workspace or config", async () => {
  const h = await harness();
  await h.controller.deploy(confirmation());
  const before = await fs.readFile(h.saved.configPath, "utf8");
  h.context.workspace = "/another-desktop-project";
  h.calls.length = 0;
  expect(h.controller.state().portalWorkspace.path).toBe(h.saved.workspace);
  expect((await h.controller.deploy(confirmation())).status).toBe("running");
  expect(await fs.readFile(h.saved.configPath, "utf8")).toBe(before);
  expect(h.calls).toEqual(["portal.inspect", "installer.inspect", "start"]);
});

it("external configuration is authoritative even while the process is stopped", async () => {
  const h = await harness({ portalState: { status: "external", pid: null, management: "external", deployment: { workspace: "/" } } });
  expect(h.controller.state().portalWorkspace.path).toBe("/");
  expect(h.controller.state().portalWorkspace.readOnly).toBe(true);
  await h.controller.deploy(confirmation());
  expect(h.calls).toEqual(["portal.inspect"]);
  h.portalState.deployment.workspace = "";
  expect(h.controller.state().portalWorkspace.path).toBe("");
});
