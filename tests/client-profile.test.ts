import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { clientUserData, profileOverride } from "../desktop/main/app/profile";

describe("client profile compatibility", () => {
  it("keeps an explicit isolated profile for tests and development", () => {
    const exists = vi.fn();
    expect(clientUserData("C:\\Users\\fixture\\AppData\\Roaming", ".\\profile", exists)).toBe(path.resolve(".\\profile"));
    const unavailable = vi.fn(() => { throw new Error("Failed to get 'appData' path"); });
    expect(clientUserData(unavailable, ".\\profile", exists)).toBe(path.resolve(".\\profile"));
    expect(unavailable).not.toHaveBeenCalled();
    expect(() => clientUserData(unavailable)).toThrow("Failed to get 'appData' path");
    expect(exists).not.toHaveBeenCalled();
  });

  it("opens the BeingDesktop 0.8.x profile in place", () => {
    const appData = path.resolve("fixture-app-data");
    const exists = vi.fn(() => true);
    expect(clientUserData(appData, undefined, exists)).toBe(path.join(appData, "Being Desktop"));
  });

  it("keeps using an earlier portal-desktop profile until this client has one of its own", () => {
    const appData = path.resolve("fixture-app-data");
    const exists = vi.fn((file: unknown) => String(file) === path.join(appData, "portal-desktop"));
    expect(clientUserData(appData, undefined, exists)).toBe(path.join(appData, "portal-desktop"));
    // The rename must not turn an upgrade into a fresh setup, and must not copy
    // encrypted credentials or recovery journals out of a live profile.
    expect(clientUserData(appData, undefined, () => false)).toBe(path.join(appData, "Being Desktop"));
  });

  it("accepts BeingDesktop's profile variable and the existing test alias", () => {
    expect(profileOverride({ BEING_DATA_DIR: "/data/being" })).toBe("/data/being");
    expect(profileOverride({ PORTAL_DESKTOP_USER_DATA: "/data/legacy" })).toBe("/data/legacy");
    expect(profileOverride({ BEING_DATA_DIR: "/data/being", PORTAL_DESKTOP_USER_DATA: "/data/legacy" })).toBe("/data/being");
    expect(profileOverride({ BEING_DATA_DIR: "" })).toBeUndefined();
    expect(profileOverride({})).toBeUndefined();
  });
});
