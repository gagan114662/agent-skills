import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { loadConfig, type ConfigSources } from "../../src/config/loader.js";
import { CONFIG_DEFAULTS, type ResolvedConfig } from "../../src/config/schema.js";
import { resolveVentureCaps, isVentureGateEnabledForWorkspace } from "../../src/venture/caps.js";
import { isLiveSendEnabledForWorkspace } from "../../src/email/live-send.js";
import { resolveConnectOnceCaps, isConnectOnceLiveInScope } from "../../src/connections/caps.js";

/**
 * Owner-workspace full-activation profile (issue #357, ADR-0357).
 *
 * The SHIPPED artifact under test is `platform/deploy/managed.owner-activation.example.toml`. These tests
 * read that real file (not a re-typed copy), substitute the `OWNER_WORKSPACE_ID` placeholder with a test
 * workspace id, feed it through the existing layered loader as the managed layer, and prove the two halves
 * of the tenant-isolation guarantee:
 *
 *   1. loadConfig(OWNER) -> the entire product is ON for the owner workspace, with every live provider
 *      switch flipped and every owner-workspace-first resolver in scope.
 *   2. loadConfig(any other id) and loadConfig(undefined) -> byte-for-byte CONFIG_DEFAULTS (every customer
 *      tenant + every server-wide read is unchanged).
 *
 * And the CRITICAL invariant: every autonomous-without-approval switch stays OFF, so each real/irreversible
 * action still stops at the #13 gate.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// platform/apps/server/test/unit -> platform/deploy/managed.owner-activation.example.toml
const PROFILE_PATH = join(HERE, "../../../../deploy/managed.owner-activation.example.toml");
const RAW_PROFILE = readFileSync(PROFILE_PATH, "utf8");

const OWNER = "ws_owner_test";
const OTHER = "ws_customer_other";
const MANAGED_PATH = "/etc/reload/managed.toml";

/** Substitute the placeholder with the test owner id and serve it as the managed layer only. */
function activatedSources(ownerId: string = OWNER): ConfigSources {
  const managed = RAW_PROFILE.split("OWNER_WORKSPACE_ID").join(ownerId);
  return {
    env: {},
    readFile: (p) => (p === MANAGED_PATH ? managed : undefined),
    managedPath: MANAGED_PATH,
  };
}

describe("owner-activation profile — the shipped example file is well-formed (#357)", () => {
  it("parses as valid TOML before any substitution", () => {
    expect(() => parseToml(RAW_PROFILE)).not.toThrow();
  });

  it("makes ZERO global changes — the [settings] table is empty (tenant-isolation depends on this)", () => {
    const parsed = parseToml(RAW_PROFILE) as Record<string, unknown>;
    // An empty [settings] header parses to {} — nothing applies to all tenants.
    expect(parsed.settings).toEqual({});
    // All activation lives under the per-tenant [workspace.<id>] table.
    expect(parsed.workspace).toBeTypeOf("object");
    expect(Object.keys(parsed.workspace as object)).toEqual(["OWNER_WORKSPACE_ID"]);
  });
});

describe("owner-activation profile — TENANT ISOLATION (#357)", () => {
  it("a different workspace id resolves to CONFIG_DEFAULTS, byte-for-byte", () => {
    expect(loadConfig(OTHER, activatedSources())).toEqual(CONFIG_DEFAULTS);
  });

  it("a server-wide read (no workspace id) resolves to CONFIG_DEFAULTS, byte-for-byte", () => {
    expect(loadConfig(undefined, activatedSources())).toEqual(CONFIG_DEFAULTS);
  });

  it("the owner-workspace-first resolvers are OUT of scope for any other tenant", () => {
    const other = loadConfig(OTHER, activatedSources());
    expect(isVentureGateEnabledForWorkspace(resolveVentureCaps(other.venture), OTHER)).toBe(false);
    expect(isLiveSendEnabledForWorkspace(other.emailDeliverability, OTHER)).toBe(false);
    expect(isConnectOnceLiveInScope(resolveConnectOnceCaps(other.connectOnce), OTHER)).toBe(false);
  });
});

describe("owner-activation profile — FULL ACTIVATION for the owner workspace (#357)", () => {
  const cfg: ResolvedConfig = loadConfig(OWNER, activatedSources());

  it("turns on every feature master switch (the whole product is ON for the owner)", () => {
    // Boolean `enabled` master switches across all three phases.
    const enabledFlags: Array<keyof ResolvedConfig> = [
      // phase 1
      "marketing", "agentRegistry", "agentCollaboration", "garden", "worktreePool", "durableWorkflow",
      "discovery", "growth", "decisionMaker", "catalog", "workflows", "briefings", "slack", "finance",
      "moat", "insight", "portfolio", "planning", "ventureMemory", "reliability", "sre", "watchdog",
      "flywheel", "verifiers", "verification", "gatePricing", "voice", "constitution", "fleet",
      "automations", "skillopt", "selfqa", "buildLoop",
      // phase 2
      "venture", "ventureFactory", "monetization", "analytics", "seo", "legal", "supportDesk",
      // phase 3
      "onboarding", "provisioning", "connectOnce", "connectClaude", "realworld", "outreach",
      "acquisition", "ads", "hostedSites", "social", "reach", "ventureDeploys",
    ];
    for (const key of enabledFlags) {
      expect((cfg[key] as { enabled?: boolean }).enabled, `${String(key)}.enabled`).toBe(true);
    }
  });

  it("flips the LIVE provider switches so real actions are possible", () => {
    expect(cfg.billing).toEqual({ provider: "stripe", currency: "usd" }); // checkout gate open
    expect(cfg.emailDeliverability.liveSendEnabled).toBe(true); // real Postmark send eligible
    expect(cfg.capabilityTokens.liveMintEnabled).toBe(true); // real token mint eligible
    expect(cfg.ventureDeploys.provider).toBe("vercel");
    expect(cfg.ads.perActionCapCents).toBeGreaterThan(0); // a real (capped) spend is approvable
    expect(cfg.realworld.publishProvider).toBe("github_pages");
  });

  it("brings the owner-workspace-first resolvers INTO scope for the owner", () => {
    expect(isVentureGateEnabledForWorkspace(resolveVentureCaps(cfg.venture), OWNER)).toBe(true);
    expect(isLiveSendEnabledForWorkspace(cfg.emailDeliverability, OWNER)).toBe(true);
    expect(isConnectOnceLiveInScope(resolveConnectOnceCaps(cfg.connectOnce), OWNER)).toBe(true);
  });

  it("names the owner workspace on the owner-first blocks (so the resolvers gate correctly)", () => {
    expect(cfg.marketing.ownerWorkspaceId).toBe(OWNER);
    expect(cfg.venture.ownerWorkspaceId).toBe(OWNER);
    expect(cfg.emailDeliverability.ownerWorkspaceId).toBe(OWNER);
    expect(cfg.connectOnce.ownerWorkspaceId).toBe(OWNER);
    expect(cfg.capabilityTokens.ownerWorkspaceId).toBe(OWNER);
    expect(cfg.ads.ownerWorkspaceId).toBe(OWNER);
  });
});

describe("owner-activation profile — the CRITICAL #13 invariant: nothing autonomous (#357)", () => {
  const cfg = loadConfig(OWNER, activatedSources());

  it("keeps every self-healing auto-act switch OFF (breaches escalate, never self-act)", () => {
    expect(cfg.selfHealing.enabled).toBe(true); // monitoring + escalation IS on
    expect(cfg.selfHealing.autoRemediate).toBe(false);
    expect(cfg.selfHealing.allowRollback).toBe(false);
    expect(cfg.selfHealing.allowScale).toBe(false);
    expect(cfg.selfHealing.preCommitRollback).toBe(false);
    expect(cfg.selfHealing.preCommitScale).toBe(false);
    expect(cfg.selfHealing.requireApprovalForDestructive).toBe(true);
  });

  it("keeps support replies, ticket triage, and verified deliverables human-gated", () => {
    expect(cfg.supportDesk.autoSend).toBe(false);
    expect(cfg.voice.autoTriageDraft).toBe(false);
    expect(cfg.verification.autoSendReversible).toBe(false);
    expect(cfg.verification.requireProductionGrounding).toBe(true);
  });

  it("keeps real acquisition sends and the prod cutover human-gated", () => {
    expect(cfg.acquisition.autoSend).toBe(false);
    expect(cfg.ventureDeploys.preCommitProdPromote).toBe(false);
    expect(cfg.ventureDeploys.requireApprovalForProdPromote).toBe(true);
  });
});

describe("owner-activation profile — managed layer is the lock (#357)", () => {
  it("a lower (repo/env) layer cannot widen or alter the owner activation", () => {
    // Even if a repo layer tried to enable a feature globally, the managed per-tenant block is what
    // governs the owner workspace, and the empty global [settings] still governs everyone else.
    const sources = activatedSources();
    const withRepo: ConfigSources = {
      ...sources,
      readFile: (p) =>
        p === MANAGED_PATH
          ? RAW_PROFILE.split("OWNER_WORKSPACE_ID").join(OWNER)
          : p === "/r/settings.toml"
            ? `[acquisition]\nautoSend = true` // a lower layer attempts to flip autoSend on
            : undefined,
      repoPath: "/r/settings.toml",
    };
    // Other tenants: the repo layer DOES apply to them (no managed override), so this is a reminder that
    // the isolation guarantee is about the MANAGED profile — a deployment must not ship a repo-layer that
    // widens autoSend. For the OWNER, the managed per-tenant block keeps autoSend false (managed wins).
    expect(loadConfig(OWNER, withRepo).acquisition.autoSend).toBe(false);
  });
});
