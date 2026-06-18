import { describe, it, expect, vi } from "vitest";
import { GardenService, type GardenDeps } from "../../src/garden/service.js";
import { GARDEN_DEFAULTS, type GardenCaps } from "../../src/garden/caps.js";
import type { GardenAgentState } from "../../src/garden/types.js";

const OWNER = { workspaceId: "ws-owner", memberId: "m-owner" };
const ALL_PRESENT = ["scout", "echo", "quill", "postmark", "bid", "lens", "mark", "comet"];

function caps(over: Partial<GardenCaps> = {}): GardenCaps {
  return { ...GARDEN_DEFAULTS, enabled: true, ownerWorkspaceId: "ws-owner", ...over };
}

function makeService(over: Partial<GardenDeps> = {}) {
  const states: Record<string, GardenAgentState> = {};
  const setState = vi.fn(async (_ws: string, handle: string, state: GardenAgentState) => {
    states[handle] = state;
  });
  const park = vi.fn(async () => ({ id: "req-1" }));
  const deps: GardenDeps = {
    caps: () => caps(),
    listPresentHandles: async () => [...ALL_PRESENT],
    getStates: async () => ({ ...states }),
    setState,
    park,
    ...over,
  };
  return { service: new GardenService(deps), states, setState, park };
}

describe("garden/service — list (read-only catalog)", () => {
  it("lists every fleet agent with canManage true in the owner workspace", async () => {
    const { service } = makeService();
    const view = await service.list(OWNER);
    expect(view.canManage).toBe(true);
    expect(view.agents.length).toBe(ALL_PRESENT.length);
    // default: nothing stored ⇒ every agent disabled + inactive
    expect(view.agents.every((a) => a.state === "disabled" && !a.active)).toBe(true);
  });

  it("lists the catalog but cannot manage when the flag is off", async () => {
    const { service } = makeService({ caps: () => caps({ enabled: false }) });
    const view = await service.list(OWNER);
    expect(view.canManage).toBe(false);
    expect(view.agents.length).toBe(ALL_PRESENT.length);
  });
});

describe("garden/service — enable", () => {
  it("enables a read_only agent directly and reports it active (present + enabled)", async () => {
    const { service, setState, park } = makeService();
    const res = await service.enable(OWNER, "scout");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.outcome).toBe("enabled");
    expect(setState).toHaveBeenCalledWith("ws-owner", "scout", "enabled");
    expect(park).not.toHaveBeenCalled();
    expect(res.view.agents.find((a) => a.handle === "scout")!.active).toBe(true);
  });

  it("parks a #13 approval for an external_send agent and persists pending_approval (never autonomous)", async () => {
    const { service, setState, park } = makeService();
    const res = await service.enable(OWNER, "echo");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.outcome).toBe("pending_approval");
    expect(res.outcome === "pending_approval" && res.requestId).toBe("req-1");
    expect(park).toHaveBeenCalledTimes(1);
    expect(setState).toHaveBeenCalledWith("ws-owner", "echo", "pending_approval");
    const echo = res.view.agents.find((a) => a.handle === "echo")!;
    expect(echo.state).toBe("pending_approval");
    expect(echo.active).toBe(false);
  });

  it("normalizes a @-prefixed, mixed-case handle", async () => {
    const { service, setState } = makeService();
    const res = await service.enable(OWNER, "@Scout");
    expect(res.ok).toBe(true);
    expect(setState).toHaveBeenCalledWith("ws-owner", "scout", "enabled");
  });

  it("404s an unknown agent and persists nothing", async () => {
    const { service, setState } = makeService();
    const res = await service.enable(OWNER, "nobody");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe(404);
    expect(setState).not.toHaveBeenCalled();
  });

  it("409s (and parks nothing) when the workspace is out of scope", async () => {
    const { service, setState, park } = makeService({ caps: () => caps({ ownerWorkspaceId: "ws-other" }) });
    const res = await service.enable(OWNER, "echo");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe(409);
    expect(park).not.toHaveBeenCalled();
    expect(setState).not.toHaveBeenCalled();
  });

  it("409s when the flag is off (catalog lists, but nothing can be enabled)", async () => {
    const { service } = makeService({ caps: () => caps({ enabled: false }) });
    const res = await service.enable(OWNER, "scout");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe(409);
  });
});

describe("garden/service — disable", () => {
  it("disables an agent immediately (never gated), even an external_send one", async () => {
    const { service, setState, park } = makeService();
    const res = await service.disable(OWNER, "echo");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.outcome).toBe("disabled");
    expect(setState).toHaveBeenCalledWith("ws-owner", "echo", "disabled");
    expect(park).not.toHaveBeenCalled();
  });

  it("404s an unknown agent", async () => {
    const { service } = makeService();
    const res = await service.disable(OWNER, "nobody");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe(404);
  });

  it("an enabled→disabled round trip flips active off in the returned view", async () => {
    const { service } = makeService();
    await service.enable(OWNER, "scout");
    const res = await service.disable(OWNER, "scout");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.view.agents.find((a) => a.handle === "scout")!.active).toBe(false);
  });
});
