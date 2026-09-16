// The seam every integration unit installs through. Added by the I0 seam stage on
// 2026-09-16 (integration plan §2.7).
//
// What it pins is the three properties that let five worktrees append to one
// array without coordinating: installation order carries no meaning, because a
// cross-subsystem reference is a lazy getter; one broken installer does not take
// the client window down with it; and shutdown runs in reverse, so a subsystem is
// torn down before whatever it was built on top of.
//
// The fakes register real keys through `declare module`, exactly as a production
// subsystem does, rather than being cast past the type system — the augmentation
// *is* the mechanism under test.
import { describe, expect, it } from "vitest";
import { installSubsystems, type DesktopExtensionsContext } from "../desktop/main/extensions";
import type { DesktopSubsystem, SubsystemContext, SubsystemInstaller } from "../desktop/main/subsystems/types";

interface AlphaSubsystem extends DesktopSubsystem { greet(): string }
/** `presentation` stands in for the real one: a field a PEER assigns after both
 * are installed (integration plan §3.4, the tool bridge's `WorkerPresentation`). */
interface BetaSubsystem extends DesktopSubsystem { throughAlpha(): string; presentation?: string }
declare module "../desktop/main/subsystems/types" {
  interface SubsystemMap {
    "test-alpha": AlphaSubsystem;
    "test-beta": BetaSubsystem;
  }
}

const DESKTOP_ID = "11111111-1111-4111-8111-111111111111";

function fixture() {
  const errors: { scope: string; error: unknown }[] = [];
  const pushes: { channel: string; payload: unknown }[] = [];
  const contexts: SubsystemContext[] = [];
  let destroyed = false;
  const window = {
    isDestroyed: () => destroyed,
    webContents: { isDestroyed: () => destroyed, send: (channel: string, payload: unknown) => { pushes.push({ channel, payload }); } },
  };
  const context: DesktopExtensionsContext = {
    handle: () => {},
    exclusive: operation => operation(),
    window: () => window,
    store: { connection: null, connectionAddress: "" },
    secretStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() },
    userData: "/nonexistent",
    desktopId: DESKTOP_ID,
    onError: (scope, error) => { errors.push({ scope, error }); },
  };
  /** Capture each installer's context so a test can use the same registry the
   * subsystems were handed. */
  const capture = (installer: SubsystemInstaller): SubsystemInstaller =>
    Object.defineProperty((ctx: SubsystemContext) => { contexts.push(ctx); return installer(ctx); }, "name", { value: installer.name });
  return {
    errors, pushes, contexts, context,
    destroy: () => { destroyed = true; },
    install: (installers: SubsystemInstaller[]) => installSubsystems(context, installers.map(capture)),
  };
}

/** Beta reaches Alpha only through a lazy getter, which is the rule the whole seam
 * rests on: dereferenced during `install` it would find nothing. */
function installTestBetaSubsystem(ctx: SubsystemContext): BetaSubsystem {
  const alpha = () => ctx.registry.require("test-alpha");
  return { key: "test-beta", throughAlpha: () => alpha().greet() };
}
function installTestAlphaSubsystem(ctx: SubsystemContext): AlphaSubsystem {
  return { key: "test-alpha", greet: () => `alpha:${ctx.desktopId.slice(0, 8)}` };
}

describe("the subsystem registry", () => {
  it("resolves a peer lazily, whichever order the installers ran in", () => {
    for (const installers of [
      [installTestAlphaSubsystem, installTestBetaSubsystem],
      [installTestBetaSubsystem, installTestAlphaSubsystem],
    ]) {
      const f = fixture();
      f.install(installers);
      expect(f.errors).toEqual([]);
      const registry = f.contexts[0]!.registry;
      // The same registry object reaches every installer, so Beta installed first
      // still sees an Alpha that did not exist when its body ran.
      expect(f.contexts[0]!.registry).toBe(f.contexts[1]!.registry);
      expect(registry.require("test-beta").throughAlpha()).toBe(`alpha:${DESKTOP_ID.slice(0, 8)}`);
      expect(registry.get("test-alpha")).not.toBeNull();
    }
  });

  it("answers for a subsystem that is not installed without throwing, and names it when asked to insist", () => {
    const f = fixture();
    f.install([installTestAlphaSubsystem]);
    const registry = f.contexts[0]!.registry;
    expect(registry.get("test-beta")).toBeNull();
    expect(() => registry.require("test-beta")).toThrow("子系统 test-beta 未安装。");
  });

  it("keeps installing after one installer throws, and reports the scope with its name", () => {
    const f = fixture();
    const failure = new Error("this installer is broken");
    const installBrokenSubsystem = () => { throw failure; };
    const extensions = f.install([installBrokenSubsystem, installTestAlphaSubsystem, installTestBetaSubsystem]);
    expect(f.errors).toEqual([{ scope: "subsystem-install:installBrokenSubsystem", error: failure }]);
    // The two healthy subsystems installed, and the client is still usable.
    expect(f.contexts[0]!.registry.require("test-beta").throughAlpha()).toBe(`alpha:${DESKTOP_ID.slice(0, 8)}`);
    expect(extensions.chat).toBeNull();
  });

  // `linked` is the lazy rule's one escape hatch: a lazy getter reads, and
  // `orchestration.presentation = …` writes. Assigning during install would hit
  // whichever half installed second, so the write waits until every installer has
  // run — which is exactly what this asserts, from the subsystem that installs
  // FIRST and therefore cannot see its peer while its own body runs.
  it("links every subsystem once all of them are installed, so a peer can be assigned into", () => {
    const f = fixture();
    let duringInstall: BetaSubsystem | null = null;
    const installAssigningAlpha = (ctx: SubsystemContext): AlphaSubsystem => {
      duringInstall = ctx.registry.get("test-beta");
      return {
        key: "test-alpha",
        greet: () => "alpha",
        linked: () => { ctx.registry.require("test-beta").presentation = "assigned by alpha"; },
      };
    };
    f.install([installAssigningAlpha, installTestBetaSubsystem]);
    expect(f.errors).toEqual([]);
    expect(duringInstall).toBeNull();
    expect(f.contexts[0]!.registry.require("test-beta").presentation).toBe("assigned by alpha");
  });

  it("reports a failing `linked` and links the rest anyway", () => {
    const f = fixture();
    const linked: string[] = [];
    const failure = new Error("link failed");
    const first = (): DesktopSubsystem => ({ key: "test-alpha", linked: () => { linked.push("alpha"); throw failure; } });
    const second = (): DesktopSubsystem => ({ key: "test-beta", linked: () => { linked.push("beta"); } });
    f.install([first, second]);
    expect(linked).toEqual(["alpha", "beta"]);
    expect(f.errors).toEqual([{ scope: "test-alpha-linked", error: failure }]);
  });

  it("shuts down in reverse order and finishes the list even when one subsystem fails", async () => {
    const f = fixture();
    const order: string[] = [];
    const failure = new Error("shutdown failed");
    const first = (): DesktopSubsystem => ({ key: "test-alpha", quitting: async () => { order.push("alpha"); } });
    const second = (): DesktopSubsystem => ({ key: "test-beta", quitting: async () => { order.push("beta"); throw failure; } });
    const extensions = f.install([first, second]);
    await extensions.quitting();
    expect(order).toEqual(["beta", "alpha"]);
    expect(f.errors).toEqual([{ scope: "test-beta-quitting", error: failure }]);
  });

  it("fans the connection lifecycle out in installation order and survives a failure in one", async () => {
    const f = fixture();
    const verified: string[] = [];
    const cleared: string[] = [];
    const failure = new Error("verify failed");
    const first = (): DesktopSubsystem => ({
      key: "test-alpha",
      connectionVerified: () => { verified.push("alpha"); throw failure; },
      connectionCleared: async () => { cleared.push("alpha"); },
    });
    const second = (): DesktopSubsystem => ({
      key: "test-beta",
      connectionVerified: () => { verified.push("beta"); },
      connectionCleared: async () => { cleared.push("beta"); },
    });
    const extensions = f.install([first, second]);
    extensions.connectionVerified(null);
    expect(verified).toEqual(["alpha", "beta"]);
    expect(f.errors).toEqual([{ scope: "test-alpha-verified", error: failure }]);
    await extensions.connectionCleared();
    expect(cleared).toEqual(["alpha", "beta"]);
  });

  it("settles `ready` only when every subsystem's own work has", async () => {
    const f = fixture();
    let release = () => {};
    const pending = new Promise<void>(resolve => { release = resolve; });
    let settled = false;
    const slow = (): DesktopSubsystem => ({ key: "test-alpha", ready: pending });
    const extensions = f.install([slow, installTestBetaSubsystem]);
    void extensions.ready.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await extensions.ready;
    expect(settled).toBe(true);
  });

  it("pushes through the window guard, so a subsystem never has to check it", () => {
    const f = fixture();
    f.install([installTestAlphaSubsystem]);
    f.contexts[0]!.push("beings:test-state", { value: 1 });
    expect(f.pushes).toEqual([{ channel: "beings:test-state", payload: { value: 1 } }]);
    f.destroy();
    f.contexts[0]!.push("beings:test-state", { value: 2 });
    expect(f.pushes).toHaveLength(1);
  });

  it("gives a subsystem a settings façade that refuses rather than silently dropping a write", async () => {
    const f = fixture();
    f.install([installTestAlphaSubsystem]);
    const store = f.contexts[0]!.store;
    expect(store.connectionAddress).toBe("");
    expect(store.extras).toEqual({});
    await expect(store.saveExtra({ sidebar: {} })).rejects.toThrow("设置暂时无法写入，请重启客户端后重试。");
  });
});
