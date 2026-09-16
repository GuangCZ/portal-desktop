// Ported from BeingDesktop test/p1-name-rules.test.cjs on 2026-09-16 — only the two cases that
// exercise TownController. Fixtures copied verbatim. The TownClient, town-mentions and town-wire
// halves of each original case belong to other migration units and are noted inline.
// See docs/p1-town-identity-mentions-2026-09-15.md: the Loom name, the verified Town ID and the
// display name are three separate fields and must never be collapsed.
import { expect, it } from "vitest";
import { TownController } from "../desktop/main/town/channel/town-controller";
import type { TownControllerOptions } from "../desktop/main/town/channel/town-controller";

// BeingDesktop constructed the controller with only these three options; state() must not need more.
const identityOnly = (getContext: TownControllerOptions["getContext"]) =>
  new TownController({ installer: {} as any, portal: { state: {} } as any, getContext } as TownControllerOptions);

it("P1 identity exposes distinct Loom, verified Town and display fields", () => {
  const controller = identityOnly(() => ({ beingName: "cz_being", townId: "t_self", displayName: "After" }));
  expect(controller.state().identity.loomBeingId).toBe("cz_being");
  expect(controller.state().identity.townId).toBe("t_self");
  expect(controller.state().identity.displayName).toBe("After");
});

it("P1 exact acceptance fixture keeps Loom, Town and display identities separate across IPC", () => {
  const identity = { loomBeingId: "cz_being", townId: "t_IzYOPP3G0ABJuK2M", displayName: "Neuromancer" };
  const controller = identityOnly(() => ({ beingName: identity.loomBeingId, townId: identity.townId, displayName: identity.displayName }));
  // structuredClone stands in for the IPC boundary, exactly as the preload fixture did.
  const actual = structuredClone(controller.state()).identity as Record<string, unknown>;
  for (const field of ["loomBeingId", "townId", "displayName"] as const) expect(actual[field]).toBe(identity[field]);
  expect(actual.beingId).toBe(identity.loomBeingId);
  expect(actual.sendAs).toBe("being");
});
