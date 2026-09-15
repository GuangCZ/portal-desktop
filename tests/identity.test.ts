// Ported from BeingDesktop 0.8.26 test/desktop-identity.test.cjs; 2026-09-16.
// The fixtures are copied verbatim; only the runner and assertion style change.
import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { desktopPortalName, loadDesktopId } from "../desktop/main/app/identity";

const directories: string[] = [];
afterEach(async () => { for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temporary() {
  const root = await mkdtemp(path.join(os.tmpdir(), "desktop-id-test-"));
  directories.push(root); return root;
}

it("survives restarts while separate profiles get separate tool targets", async () => {
  const dir = await temporary();
  const a = await loadDesktopId(path.join(dir, "mac")), b = await loadDesktopId(path.join(dir, "win"));
  expect(a).not.toBe(b);
  expect(await loadDesktopId(path.join(dir, "mac"))).toBe(a);
  expect(desktopPortalName(a)).not.toBe(desktopPortalName(b));
  expect(desktopPortalName(a)).toBe(`being-desktop-tools-${a}`);
  if (process.platform !== "win32") {
    expect((await stat(path.join(dir, "mac", "desktop-id.json"))).mode & 0o777).toBe(0o600);
  }
});

it("publishes one complete Desktop identity across concurrent first launches", async () => {
  const dir = await temporary();
  const ids = await Promise.all(Array.from({ length: 16 }, () => loadDesktopId(dir)));
  expect(new Set(ids).size).toBe(1);
  expect(await readdir(dir)).toEqual(["desktop-id.json"]);
});

it("preserves an invalid Desktop identity instead of silently replacing it", async () => {
  const dir = await temporary();
  const file = path.join(dir, "desktop-id.json");
  await writeFile(file, "broken");
  await expect(loadDesktopId(dir)).rejects.toThrow(/原文件已保留/);
  expect(await readFile(file, "utf8")).toBe("broken");
  expect(() => desktopPortalName("bad\nroute")).toThrow(/身份无效/);
});
