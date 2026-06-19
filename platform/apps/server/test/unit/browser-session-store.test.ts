import { describe, it, expect } from "vitest";
import {
  parseStorageState,
  browserSessionServiceKey,
  NULL_BROWSER_SESSION_RESOLVER,
  BROWSER_SESSION_KEY_PREFIX,
  BROWSER_SESSION_SECRET_FIELD,
  type BrowserSessionResolver,
  type BrowserStorageState,
} from "../../src/runtime/browser/session-store.js";
import {
  SESSION_INJECTION_DEFAULTS,
  resolveSessionInjectionCaps,
  isOwnerWorkspace,
  sessionInjectionActive,
} from "../../src/runtime/browser/session-injection-caps.js";
import { resolveBrowserCaps } from "../../src/runtime/browser/caps.js";
import { createFakeBrowserDriver } from "../../src/runtime/browser/driver.js";
import { pendingApprovalGate } from "../../src/runtime/browser/approval.js";
import { BrowserSessionManager } from "../../src/runtime/browser/manager.js";

const VALID: BrowserStorageState = {
  cookies: [{ name: "auth", value: "tok", domain: ".x.com", path: "/" }],
  origins: [{ origin: "https://x.com", localStorage: [{ name: "k", value: "v" }] }],
};

describe("parseStorageState (#388 — fail-closed shape validation)", () => {
  it("parses a valid Playwright storageState", () => {
    const out = parseStorageState(JSON.stringify(VALID));
    expect(out).not.toBeNull();
    expect(out?.cookies).toHaveLength(1);
    expect(out?.cookies[0]?.name).toBe("auth");
    expect(out?.origins[0]?.origin).toBe("https://x.com");
    expect(out?.origins[0]?.localStorage[0]).toEqual({ name: "k", value: "v" });
  });

  it("accepts empty-but-well-formed arrays", () => {
    expect(parseStorageState(JSON.stringify({ cookies: [], origins: [] }))).toEqual({
      cookies: [],
      origins: [],
    });
  });

  it("returns null for an empty / blank string", () => {
    expect(parseStorageState("")).toBeNull();
    expect(parseStorageState("   ")).toBeNull();
  });

  it("returns null for malformed JSON (never throws)", () => {
    expect(parseStorageState("{not json")).toBeNull();
    expect(parseStorageState("[1,2,3")).toBeNull();
  });

  it("returns null when the shape is wrong (missing/!array cookies or origins)", () => {
    expect(parseStorageState(JSON.stringify({ cookies: [] }))).toBeNull(); // origins missing
    expect(parseStorageState(JSON.stringify({ origins: [] }))).toBeNull(); // cookies missing
    expect(parseStorageState(JSON.stringify({ cookies: {}, origins: [] }))).toBeNull();
    expect(parseStorageState(JSON.stringify("a string"))).toBeNull();
    expect(parseStorageState(JSON.stringify([1, 2, 3]))).toBeNull();
    expect(parseStorageState(JSON.stringify(42))).toBeNull();
  });

  it("drops malformed cookie / origin entries rather than throwing", () => {
    const out = parseStorageState(
      JSON.stringify({
        cookies: [{ name: "ok", value: "v" }, { name: 1, value: 2 }, "nope", null],
        origins: [
          { origin: "https://a.com", localStorage: [{ name: "x", value: "y" }, { bad: true }] },
          { localStorage: [] }, // no origin → dropped
          "nope",
        ],
      }),
    );
    expect(out?.cookies).toHaveLength(1);
    expect(out?.origins).toHaveLength(1);
    expect(out?.origins[0]?.localStorage).toHaveLength(1);
  });
});

describe("browserSessionServiceKey (#388 — vault key)", () => {
  it("namespaces + lower-cases + trims the target", () => {
    expect(browserSessionServiceKey("  X.com ")).toBe(`${BROWSER_SESSION_KEY_PREFIX}x.com`);
    expect(BROWSER_SESSION_KEY_PREFIX).toBe("browser_session:");
    expect(BROWSER_SESSION_SECRET_FIELD).toBe("STORAGE_STATE");
  });
});

describe("NULL_BROWSER_SESSION_RESOLVER (#388 — default authless fallback)", () => {
  it("returns null for any workspace/target (no stored session)", async () => {
    expect(await NULL_BROWSER_SESSION_RESOLVER.resolve("w1", "x.com")).toBeNull();
  });
});

describe("resolveSessionInjectionCaps (#388 — default OFF, owner-first)", () => {
  it("defaults to OFF with no owner workspace", () => {
    const caps = resolveSessionInjectionCaps(undefined);
    expect(caps).toEqual(SESSION_INJECTION_DEFAULTS);
    expect(caps.enabled).toBe(false);
    expect(caps.ownerWorkspaceId).toBeNull();
  });

  it("overrides only the fields the config sets", () => {
    const caps = resolveSessionInjectionCaps({ enabled: true, ownerWorkspaceId: "owner" });
    expect(caps.enabled).toBe(true);
    expect(caps.ownerWorkspaceId).toBe("owner");
  });

  it("is owner-first + fail-closed (unset owner ⇒ nobody)", () => {
    expect(isOwnerWorkspace(resolveSessionInjectionCaps({ enabled: true }), "w1")).toBe(false);
    const caps = resolveSessionInjectionCaps({ enabled: true, ownerWorkspaceId: "owner" });
    expect(isOwnerWorkspace(caps, "owner")).toBe(true);
    expect(isOwnerWorkspace(caps, "other")).toBe(false);
  });

  it("is active only when enabled AND owner workspace", () => {
    const enabledOwner = resolveSessionInjectionCaps({ enabled: true, ownerWorkspaceId: "owner" });
    expect(sessionInjectionActive(enabledOwner, "owner")).toBe(true);
    expect(sessionInjectionActive(enabledOwner, "other")).toBe(false);
    const disabledOwner = resolveSessionInjectionCaps({ enabled: false, ownerWorkspaceId: "owner" });
    expect(sessionInjectionActive(disabledOwner, "owner")).toBe(false);
  });
});

// ---- manager wiring: storageState threads through only when active --------------------------------

function makeManager(opts: {
  injectionEnabled: boolean;
  owner?: string;
  resolver?: BrowserSessionResolver;
}) {
  const driver = createFakeBrowserDriver();
  const manager = new BrowserSessionManager({
    driver,
    loadCaps: () => resolveBrowserCaps({ enabled: true }),
    approvalGate: pendingApprovalGate(),
    loadSessionInjectionCaps: () =>
      resolveSessionInjectionCaps({ enabled: opts.injectionEnabled, ownerWorkspaceId: opts.owner }),
    ...(opts.resolver ? { sessionResolver: opts.resolver } : {}),
  });
  return { driver, manager };
}

const presentResolver: BrowserSessionResolver = {
  async resolve() {
    return VALID;
  },
};

describe("BrowserSessionManager session injection (#388)", () => {
  it("opens an AUTHLESS context when the injection flag is OFF (today's behavior)", async () => {
    const { driver, manager } = makeManager({ injectionEnabled: false, owner: "owner", resolver: presentResolver });
    await manager.open({ sessionId: "s1", workspaceId: "owner", target: "x.com" });
    expect(driver.contexts[0]?.storageState).toBeNull();
  });

  it("opens AUTHLESS when active+resolver present but NO target is supplied", async () => {
    const { driver, manager } = makeManager({ injectionEnabled: true, owner: "owner", resolver: presentResolver });
    await manager.open({ sessionId: "s1", workspaceId: "owner" });
    expect(driver.contexts[0]?.storageState).toBeNull();
  });

  it("opens AUTHLESS for a non-owner workspace even when the flag is enabled", async () => {
    const { driver, manager } = makeManager({ injectionEnabled: true, owner: "owner", resolver: presentResolver });
    await manager.open({ sessionId: "s1", workspaceId: "intruder", target: "x.com" });
    expect(driver.contexts[0]?.storageState).toBeNull();
  });

  it("INJECTS the resolved storageState when active for the owner workspace + target present", async () => {
    const { driver, manager } = makeManager({ injectionEnabled: true, owner: "owner", resolver: presentResolver });
    await manager.open({ sessionId: "s1", workspaceId: "owner", target: "x.com" });
    expect(driver.contexts[0]?.storageState).toEqual(VALID);
  });

  it("opens AUTHLESS when the resolver returns null (no stored session)", async () => {
    const { driver, manager } = makeManager({
      injectionEnabled: true,
      owner: "owner",
      resolver: NULL_BROWSER_SESSION_RESOLVER,
    });
    await manager.open({ sessionId: "s1", workspaceId: "owner", target: "x.com" });
    expect(driver.contexts[0]?.storageState).toBeNull();
  });

  it("fails closed (authless) when the resolver throws", async () => {
    const throwing: BrowserSessionResolver = {
      async resolve() {
        throw new Error("vault unreachable");
      },
    };
    const { driver, manager } = makeManager({ injectionEnabled: true, owner: "owner", resolver: throwing });
    await manager.open({ sessionId: "s1", workspaceId: "owner", target: "x.com" });
    expect(driver.contexts[0]?.storageState).toBeNull();
  });

  it("opens AUTHLESS when no injection deps are wired at all (default manager)", async () => {
    const driver = createFakeBrowserDriver();
    const manager = new BrowserSessionManager({
      driver,
      loadCaps: () => resolveBrowserCaps({ enabled: true }),
      approvalGate: pendingApprovalGate(),
    });
    await manager.open({ sessionId: "s1", workspaceId: "owner", target: "x.com" });
    expect(driver.contexts[0]?.storageState).toBeNull();
  });
});
