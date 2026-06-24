import { describe, it, expect } from "vitest";
import {
  decideVentureAdmission,
  VentureAdmission,
  VentureAdmissionError,
  ventureGatedLauncher,
} from "../../src/venture/admission.js";
import type { AutonomyLauncher } from "../../src/autonomy/engine.js";

const LAUNCH = {
  workspaceId: "ws",
  channelId: "ch",
  taskId: "task",
  agentMemberId: "a",
  createdByMemberId: "a",
  task: "do it",
};

/** A fake inner launcher that records the workspaces it was actually asked to launch in. */
function fakeInner(): AutonomyLauncher & { launched: string[] } {
  const launched: string[] = [];
  return {
    launched,
    launch: async (input) => {
      launched.push(input.workspaceId);
      return { id: "sess-1" };
    },
    join: async () => {},
    status: async () => "completed",
  };
}

describe("decideVentureAdmission (pure, default OFF)", () => {
  it("admits unconditionally when the gate is disabled (unchanged behavior)", () => {
    expect(decideVentureAdmission({ enabled: false, hasPassingUnexpired: false })).toEqual({ ok: true });
    expect(decideVentureAdmission({ enabled: false, hasPassingUnexpired: true })).toEqual({ ok: true });
  });

  it("denies an enabled workspace with no passing unexpired scorecard", () => {
    expect(decideVentureAdmission({ enabled: true, hasPassingUnexpired: false })).toEqual({
      ok: false,
      reason: "no_funded_venture",
    });
  });

  it("admits an enabled workspace that has a passing unexpired scorecard", () => {
    expect(decideVentureAdmission({ enabled: true, hasPassingUnexpired: true })).toEqual({ ok: true });
  });
});

describe("VentureAdmission.check", () => {
  const now = () => new Date("2026-06-10T00:00:00Z");

  it("short-circuits (no scorecard query) when disabled", async () => {
    let queried = false;
    const adm = new VentureAdmission({
      config: () => ({ enabled: false }),
      hasPassingUnexpired: async () => {
        queried = true;
        return false;
      },
      now,
    });
    await expect(adm.check("ws")).resolves.toBeUndefined();
    expect(queried).toBe(false);
  });

  it("throws VentureAdmissionError when enabled and no passing scorecard", async () => {
    const adm = new VentureAdmission({
      config: () => ({ enabled: true }),
      hasPassingUnexpired: async () => false,
      now,
    });
    await expect(adm.check("ws")).rejects.toBeInstanceOf(VentureAdmissionError);
  });

  it("resolves when enabled and a passing scorecard exists", async () => {
    const adm = new VentureAdmission({
      config: () => ({ enabled: true }),
      hasPassingUnexpired: async () => true,
      now,
    });
    await expect(adm.check("ws")).resolves.toBeUndefined();
  });

  it("isolates per workspace: gate on A never affects B", async () => {
    const adm = new VentureAdmission({
      config: (wid) => ({ enabled: wid === "A" }), // only A enforces
      hasPassingUnexpired: async () => false, // nobody has a scorecard
      now,
    });
    await expect(adm.check("A")).rejects.toBeInstanceOf(VentureAdmissionError);
    await expect(adm.check("B")).resolves.toBeUndefined();
  });
});

describe("ventureGatedLauncher (autonomy-only enforcement)", () => {
  it("blocks the launch when the gate denies — inner launcher is never called", async () => {
    const inner = fakeInner();
    const gated = ventureGatedLauncher(inner, {
      check: async () => {
        throw new VentureAdmissionError("no_funded_venture");
      },
    });
    await expect(gated.launch(LAUNCH)).rejects.toBeInstanceOf(VentureAdmissionError);
    expect(inner.launched).toEqual([]);
  });

  it("delegates to the inner launcher when the gate admits", async () => {
    const inner = fakeInner();
    const gated = ventureGatedLauncher(inner, { check: async () => {} });
    await expect(gated.launch(LAUNCH)).resolves.toEqual({ id: "sess-1" });
    expect(inner.launched).toEqual(["ws"]);
  });

  it("isolates per workspace: A blocked, B admitted through the same gated launcher", async () => {
    const inner = fakeInner();
    const blocked = new Set(["A"]);
    const gated = ventureGatedLauncher(inner, {
      check: async (wid) => {
        if (blocked.has(wid)) throw new VentureAdmissionError("no_funded_venture");
      },
    });
    await expect(gated.launch({ ...LAUNCH, workspaceId: "A" })).rejects.toBeInstanceOf(VentureAdmissionError);
    await expect(gated.launch({ ...LAUNCH, workspaceId: "B" })).resolves.toEqual({ id: "sess-1" });
    expect(inner.launched).toEqual(["B"]);
  });

  it("passes join/status straight through", async () => {
    const inner = fakeInner();
    const gated = ventureGatedLauncher(inner, { check: async () => {} });
    await expect(gated.join("x")).resolves.toBeUndefined();
    await expect(gated.status("x")).resolves.toBe("completed");
  });
});
