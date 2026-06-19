import { describe, it, expect } from "vitest";
import {
  createBrowserAgentBridge,
  type BrowserSessionOpener,
} from "../../src/runtime/browser/agent-bridge.js";
import { resolveBrowserCaps, type BrowserCaps } from "../../src/runtime/browser/caps.js";
import { createFakeBrowserDriver } from "../../src/runtime/browser/driver.js";
import { pendingApprovalGate, autoApprovalGate } from "../../src/runtime/browser/approval.js";
import { BrowserSessionManager } from "../../src/runtime/browser/manager.js";
import {
  resolveSessionInjectionCaps,
  type SessionInjectionCaps,
} from "../../src/runtime/browser/session-injection-caps.js";
import type { BrowserSessionResolver, BrowserStorageState } from "../../src/runtime/browser/session-store.js";
import { BROWSER_TOOL_NAMES } from "../../src/runtime/browser/tools.js";

const WS = "w1";
const SID = "s1";

/** Build a real manager (over a fake driver) so the bridge exercises the REAL session/gate/receipt path. */
function makeManager(opts: {
  approve?: boolean;
  injection?: SessionInjectionCaps;
  resolver?: BrowserSessionResolver;
}) {
  const driver = createFakeBrowserDriver();
  const manager = new BrowserSessionManager({
    driver,
    loadCaps: () => resolveBrowserCaps({ enabled: true }),
    approvalGate: opts.approve ? autoApprovalGate() : pendingApprovalGate(),
    ...(opts.injection ? { loadSessionInjectionCaps: () => opts.injection! } : {}),
    ...(opts.resolver ? { sessionResolver: opts.resolver } : {}),
  });
  return { driver, manager };
}

const ENABLED: BrowserCaps = resolveBrowserCaps({ enabled: true });
const DISABLED: BrowserCaps = resolveBrowserCaps({ enabled: false });

describe("createBrowserAgentBridge (#388 slice 2 — agent→browser tool bridge)", () => {
  it("exposes NO tools when the browser is disabled (flag off ⇒ bridge not offered)", () => {
    const { manager } = makeManager({});
    const bridge = createBrowserAgentBridge({ manager, workspaceId: WS, sessionId: SID, caps: DISABLED });
    expect(bridge.tools).toEqual([]);
  });

  it("exposes all seven browser tools when the browser is enabled", () => {
    const { manager } = makeManager({});
    const bridge = createBrowserAgentBridge({ manager, workspaceId: WS, sessionId: SID, caps: ENABLED });
    expect(bridge.tools.map((t) => t.name).sort()).toEqual([...BROWSER_TOOL_NAMES].sort());
    // click/type are the side-effectful (gated) tools; the rest are read-only.
    const gated = bridge.tools.filter((t) => t.sideEffectful).map((t) => t.name).sort();
    expect(gated).toEqual(["click", "type"]);
  });

  it("does not open a browser until the first tool call (lazy session)", async () => {
    const { driver, manager } = makeManager({});
    const bridge = createBrowserAgentBridge({ manager, workspaceId: WS, sessionId: SID, caps: ENABLED });
    expect(driver.contexts).toHaveLength(0);
    await bridge.tools.find((t) => t.name === "navigate")!.invoke({ url: "https://example.com" });
    expect(driver.contexts).toHaveLength(1);
  });

  it("delegates every read tool through the session manager (one shared session)", async () => {
    const { driver, manager } = makeManager({});
    const bridge = createBrowserAgentBridge({ manager, workspaceId: WS, sessionId: SID, caps: ENABLED });
    const tool = (name: string) => bridge.tools.find((t) => t.name === name)!;

    const nav = await tool("navigate").invoke({ url: "https://example.com/contact" });
    expect(nav.ok).toBe(true);
    const read = await tool("read_page").invoke({});
    expect(read.ok).toBe(true);
    expect(read.page?.text).toContain("example.com/contact");

    // All calls used the SAME isolated context (one browser per session).
    expect(driver.contexts).toHaveLength(1);
  });

  it("opens the session WITH the injected target (slice-1 session injection)", async () => {
    const blob: BrowserStorageState = { cookies: [{ name: "sid", value: "abc" }], origins: [] };
    const resolver: BrowserSessionResolver = {
      async resolve(): Promise<BrowserStorageState | null> {
        return blob;
      },
    };
    const injection = resolveSessionInjectionCaps({ enabled: true, ownerWorkspaceId: WS });
    const { driver, manager } = makeManager({ injection, resolver });
    const bridge = createBrowserAgentBridge({
      manager,
      workspaceId: WS,
      sessionId: SID,
      caps: ENABLED,
      target: "x.com",
    });
    await bridge.tools.find((t) => t.name === "navigate")!.invoke({ url: "https://x.com/compose" });
    // The context was opened logged-in: the slice-1 injection seeded the storageState.
    expect(driver.contexts[0]?.storageState).toEqual(blob);
  });

  it("REFUSES an unapproved side-effectful action and parks a #13 approval (SUBMIT stays gated)", async () => {
    const { manager } = makeManager({ approve: false });
    const bridge = createBrowserAgentBridge({ manager, workspaceId: WS, sessionId: SID, caps: ENABLED });
    await bridge.tools.find((t) => t.name === "navigate")!.invoke({ url: "https://x.com/compose" });

    // A click on a submit/post control: the gate refuses (no human approval yet) — the driver is never
    // touched, and a pending #13 request id is returned for a human to act on.
    const submit = await bridge.tools.find((t) => t.name === "click")!.invoke({ selector: "button[type=submit]" });
    expect(submit.ok).toBe(false);
    expect(submit.decision).toBe("needs_approval");
    expect(submit.approvalRequestId).toMatch(/^pending-/);
  });

  it("ALLOWS a side-effectful action once the #13 gate approves it (approved path)", async () => {
    const { manager } = makeManager({ approve: true });
    const bridge = createBrowserAgentBridge({ manager, workspaceId: WS, sessionId: SID, caps: ENABLED });
    await bridge.tools.find((t) => t.name === "navigate")!.invoke({ url: "https://x.com/compose" });
    const submit = await bridge.tools.find((t) => t.name === "click")!.invoke({ selector: "button[type=submit]" });
    expect(submit.ok).toBe(true);
    expect(submit.decision).toBe("allow");
    expect(submit.approvalRequestId).toMatch(/^approved-/);
  });

  it("hard-forbids credential typing — the agent browser never enters a credential (ADR-0174 §2)", async () => {
    const { manager } = makeManager({ approve: true }); // even with approval, credentials are forbidden
    const bridge = createBrowserAgentBridge({ manager, workspaceId: WS, sessionId: SID, caps: ENABLED });
    await bridge.tools.find((t) => t.name === "navigate")!.invoke({ url: "https://x.com/login" });
    const typed = await bridge.tools
      .find((t) => t.name === "type")!
      .invoke({ selector: "#password", text: "hunter2", credentialEntry: true });
    expect(typed.ok).toBe(false);
    expect(typed.decision).toBe("forbidden");
  });

  it("routes every call through the manager.open seam exactly once (delegation contract)", async () => {
    let opens = 0;
    let lastOpen: { sessionId: string; workspaceId: string; target?: string } | null = null;
    const real = makeManager({}).manager;
    const spy: BrowserSessionOpener = {
      async open(input) {
        opens += 1;
        lastOpen = input;
        return real.open(input);
      },
    };
    const bridge = createBrowserAgentBridge({
      manager: spy,
      workspaceId: WS,
      sessionId: SID,
      caps: ENABLED,
      target: "x.com",
    });
    await bridge.tools.find((t) => t.name === "navigate")!.invoke({ url: "https://x.com" });
    await bridge.tools.find((t) => t.name === "read_page")!.invoke({});
    await bridge.tools.find((t) => t.name === "screenshot")!.invoke({});
    // Session opened ONCE (memoised) with the workspace + session + injected target.
    expect(opens).toBe(1);
    expect(lastOpen).toEqual({ sessionId: SID, workspaceId: WS, target: "x.com" });
  });
});
