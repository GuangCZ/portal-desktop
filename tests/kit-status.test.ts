import { describe, expect, it, vi } from "vitest";
import { TownModel } from "../desktop/renderer/town/models/town";
import { SceneStore } from "../desktop/renderer/shared/models/scene";
import type { DesktopAPI, KitInstallPlan, KitLibrary, LocalKit } from "../desktop/shared/types";

const kit = (name: string, version = "1.0"): LocalKit => ({ name, version, directory: "/kits/" + name, description: "Kit", command: ["node", "server.mjs"], tools: [], compatible: true, eager: false });
const library = (...kits: LocalKit[]): KitLibrary => ({ directory: "/kits", enabled: true, kits });
const plan: KitInstallPlan = { ...kit("alpha"), ticket: "ticket", tools: 0, environment: [], dependency: "none", sha256: "fixture", notes: "" };
function fixture(overrides: Partial<DesktopAPI> = {}) {
  const api = {
    localKits: vi.fn(async () => library()),
    townAuth: vi.fn(async () => ({ configured: false })),
    town: vi.fn(async () => ({ ok: true, data: { kits: [{ id: "alpha-id", name: "alpha", version: "1.0" }] }, fetchedAt: "2026-09-15" })),
    installKit: vi.fn(async () => ({ name: "alpha", tools: 0, message: "已安装" })),
    ...overrides,
  } as unknown as DesktopAPI;
  const model = new TownModel(api, vi.fn(), vi.fn(), new SceneStore(), vi.fn(), vi.fn());
  model.view = "kits"; model.tab = "grove";
  return { model, api };
}

describe("Kit installation status", () => {
  it("reads all local manifests, including old versions and imports, on every Grove visit", async () => {
    const files = [kit("alpha", "0.9"), kit("imported")];
    const { model, api } = fixture({ localKits: vi.fn(async () => library(...files)) });
    await model.load();
    expect(model.installedKit("alpha")?.version).toBe("0.9");
    expect(model.installedKit("imported")).toBe(files[1]);
    expect(model.installedKit("absent")).toBeUndefined();
    files.splice(0, 1);
    await model.load();
    expect(api.localKits).toHaveBeenCalledTimes(2);
    expect(model.installedKit("alpha")).toBeUndefined();
    expect(model.installedKit("imported")).toBe(files[0]);
  });

  it("keeps the selected Grove item and ignores older disk reads after installation", async () => {
    let finishOld!: (value: KitLibrary) => void;
    const localKits = vi.fn().mockImplementationOnce(() => new Promise<KitLibrary>(resolve => { finishOld = resolve; })).mockResolvedValue(library(kit("alpha"), kit("beta")));
    const { model } = fixture({ localKits });
    const older = model.refreshInstalledKits();
    model.plan = plan;
    model.selectedId = "alpha-id";
    model.search = "alpha";
    const detail = { query: { kind: "kit" as const, id: "alpha-id" }, fragments: [{ name: "alpha" }] };
    model.detail = detail;
    await model.install();
    expect(model.installedKit("alpha")?.version).toBe("1.0");
    finishOld(library()); await older;
    expect(model.installedKit("alpha")?.version).toBe("1.0");
    expect(model.installedKit("beta")?.version).toBe("1.0");
    expect(model.tab).toBe("grove");
    expect(model.selectedId).toBe("alpha-id");
    expect(model.detail).toBe(detail);
    expect(model.search).toBe("alpha");
    expect(model.plan).toBeUndefined();
    await model.showInstalledKit("alpha");
    expect(model.tab).toBe("local");
    expect(model.localKit?.name).toBe("alpha");
  });

  it("keeps installation success separate from a failed status read, then retries", async () => {
    const localKits = vi.fn().mockRejectedValueOnce(new Error("目录暂时不可读")).mockResolvedValue(library(kit("alpha")));
    const { model, api } = fixture({ localKits });
    model.plan = plan;
    await model.install();
    expect(model.plan).toBeUndefined();
    expect(model.installError).toBe("");
    expect(model.installedError).toBe("目录暂时不可读");
    expect(model.installedLibrary).toBeNull();
    await model.refreshInstalledKits();
    expect(model.installedError).toBe("");
    expect(model.installedKit("alpha")?.version).toBe("1.0");
    expect(api.installKit).toHaveBeenCalledTimes(1);
  });

  it("does not report installation success for a failed install", async () => {
    const { model, api } = fixture({ installKit: vi.fn(async () => { throw new Error("依赖安装失败"); }) });
    await model.refreshInstalledKits();
    model.plan = plan;
    await model.install();
    expect(model.plan).toBe(plan);
    expect(model.installError).toBe("依赖安装失败");
    expect(model.installedKit("alpha")).toBeUndefined();
    expect(api.localKits).toHaveBeenCalledTimes(1);
  });
});
