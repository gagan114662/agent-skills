import { describe, it, expect } from "vitest";
import { resolveBrowserCaps } from "../../src/runtime/browser/caps.js";
import { createFakeBrowserDriver } from "../../src/runtime/browser/driver.js";
import { pendingApprovalGate } from "../../src/runtime/browser/approval.js";
import {
  BrowserDisabledError,
  BrowserSessionManager,
} from "../../src/runtime/browser/manager.js";

function makeManager(enabledByWorkspace: Record<string, boolean>) {
  const driver = createFakeBrowserDriver();
  const manager = new BrowserSessionManager({
    driver,
    loadCaps: (wid) => resolveBrowserCaps({ enabled: enabledByWorkspace[wid] ?? false }),
    approvalGate: pendingApprovalGate(),
  });
  return { driver, manager };
}

describe("BrowserSessionManager (#174 — lifecycle + isolation)", () => {
  it("refuses to open a session when the workspace browser policy is OFF", async () => {
    const { manager } = makeManager({ w1: false });
    await expect(manager.open({ sessionId: "s1", workspaceId: "w1" })).rejects.toBeInstanceOf(
      BrowserDisabledError,
    );
  });

  it("opens one isolated context per session and tears it down on close", async () => {
    const { driver, manager } = makeManager({ w1: true });
    const session = await manager.open({ sessionId: "s1", workspaceId: "w1" });
    expect(session.id).toBe("s1");
    expect(driver.contexts).toHaveLength(1);
    expect(driver.contexts[0]?.closed).toBe(false);
    expect(manager.openCount).toBe(1);

    await manager.close("s1");
    expect(driver.contexts[0]?.closed).toBe(true);
    expect(manager.openCount).toBe(0);
  });

  it("refuses a second browser for the same session id", async () => {
    const { manager } = makeManager({ w1: true });
    await manager.open({ sessionId: "s1", workspaceId: "w1" });
    await expect(manager.open({ sessionId: "s1", workspaceId: "w1" })).rejects.toThrow(/already open/);
  });

  it("isolates contexts across tenants — a cookie in one session is invisible to another", async () => {
    const { driver, manager } = makeManager({ w1: true, w2: true });
    await manager.open({ sessionId: "s1", workspaceId: "w1" });
    await manager.open({ sessionId: "s2", workspaceId: "w2" });

    expect(driver.contexts).toHaveLength(2);
    const [c1, c2] = driver.contexts;
    expect(c1).not.toBe(c2);
    expect(c1?.workspaceId).toBe("w1");
    expect(c2?.workspaceId).toBe("w2");

    // Set a cookie in tenant w1's context; it must not appear in tenant w2's context.
    c1?.setCookie("session", "w1-secret");
    expect(c1?.cookies.get("session")).toBe("w1-secret");
    expect(c2?.cookies.has("session")).toBe(false);
  });

  it("closes the context when page init fails — a failed open leaks no context", async () => {
    const driver = createFakeBrowserDriver({ failNewPage: true });
    const manager = new BrowserSessionManager({
      driver,
      loadCaps: () => resolveBrowserCaps({ enabled: true }),
      approvalGate: pendingApprovalGate(),
    });
    await expect(manager.open({ sessionId: "s1", workspaceId: "w1" })).rejects.toThrow(/newPage/);
    // The context was created then closed on failure — no leak, and nothing is tracked as open.
    expect(driver.contexts).toHaveLength(1);
    expect(driver.contexts[0]?.closed).toBe(true);
    expect(manager.openCount).toBe(0);
  });

  it("closeAll tears down every live session", async () => {
    const { driver, manager } = makeManager({ w1: true, w2: true });
    await manager.open({ sessionId: "s1", workspaceId: "w1" });
    await manager.open({ sessionId: "s2", workspaceId: "w2" });
    expect(manager.openCount).toBe(2);
    await manager.closeAll();
    expect(manager.openCount).toBe(0);
    expect(driver.contexts.every((c) => c.closed)).toBe(true);
  });
});
