// The sidebar's activity light; 2026-09-16 (IM).
//
// docs/migration/i4-orchestration-features.md「没做 / 待后续单元」: "侧栏活动灯不认
// Worker. BD 的规则是「有 Worker 在跑 → 会话灯 talking，且优先于『等待回复』」…
// 现在 Worker 在跑不会点亮会话灯." The rule is now
// `desktop/renderer/app/components/session-activity.ts`, and it is a function of
// plain values rather than JSX because this repository's vitest has no DOM — a
// rule inside `sidebar.tsx` is a rule nothing can execute.
//
// Measured against BeingDesktop 0.8.26 renderer/sidebar.js:62-67.
import { describe, expect, it } from "vitest";
import {
  sessionActivity, sessionActivityClass, sessionActivityLabel,
} from "../desktop/renderer/app/components/session-activity";

describe("the sidebar activity light", () => {
  it("shows a running worker as 进行中, outranking 等待回复", () => {
    // THE RULE THAT WAS MISSING. A session whose Being answered but whose CLI is
    // still working reads as idle without it.
    expect(sessionActivity({ inFlight: true }, true)).toBe("talking");
    expect(sessionActivity({}, true)).toBe("talking");
    expect(sessionActivity({ busy: true, inFlight: true }, true)).toBe("talking");
    expect(sessionActivityLabel(sessionActivity({ inFlight: true }, true))).toBe("进行中");
  });

  it("keeps the three states the conversation layer already had", () => {
    expect(sessionActivity({ busy: true }, false)).toBe("talking");
    expect(sessionActivity({ busy: true, inFlight: true }, false)).toBe("talking");
    expect(sessionActivity({ inFlight: true }, false)).toBe("waiting");
    expect(sessionActivity({}, false)).toBe("");
    expect(sessionActivity({ busy: false, inFlight: false }, false)).toBe("");
  });

  it("treats an absent orchestration model as no workers", () => {
    // `app.features.orchestration` is undefined in a build where the unit did not
    // land, and `?.hasActiveWorkers(...) === true` is how the row spells that.
    expect(sessionActivity({ inFlight: true })).toBe("waiting");
    expect(sessionActivity({})).toBe("");
  });

  it("names and classes each state exactly as 0.8.26 does", () => {
    expect(sessionActivityLabel("talking")).toBe("进行中");
    expect(sessionActivityLabel("waiting")).toBe("等待回复");
    // An idle session appends nothing to its aria-label; it does not say 空闲.
    expect(sessionActivityLabel("")).toBe("");
    expect(sessionActivityClass("talking")).toBe("session-activity-light talking");
    expect(sessionActivityClass("waiting")).toBe("session-activity-light waiting");
    expect(sessionActivityClass("")).toBe("session-activity-light inactive");
  });
});
