import { describe, it, expect } from "vitest";
import {
  evaluatePolicy,
  REALWORLD_PUBLISH_ACTION,
  OUTREACH_SEND_ACTION,
  type PolicyRule,
} from "../../src/approvals/policy.js";
import {
  ALWAYS_ON_GUARDS,
  isAlwaysOnGuard,
  resolveAutonomyCaps,
  type AutonomyCaps,
} from "../../src/autonomy-defaults/index.js";
import type { ServiceKind } from "../../src/onboarding/types.js";
import {
  RealWorldActuatorService,
  type ArtifactRecordInput,
  type ArtifactStore,
  type ToolApprovalGate,
} from "../../src/realworld/service.js";
import { DryRunPublishProvider } from "../../src/realworld/publish/dry-run-provider.js";

/**
 * #727 — autonomy-by-default wired into the live run/actuator path.
 *
 * These tests prove the acceptance criterion AT the consumption seam (`evaluatePolicy`, the single source
 * of truth the whole run/actuator path funnels through): a default workspace runs ALL capabilities
 * autonomously and ONLY money/spend pauses for approval, while a deliberately dialed-off capability/channel
 * re-gates just its own actions. The always-on guards stay orthogonal.
 */

const NO_RULES: PolicyRule[] = [];
const DEFAULT_CAPS: AutonomyCaps = resolveAutonomyCaps({}); // a fresh workspace: nothing dialed off

function withCapabilityOff(name: "draft" | "publish" | "outreach" | "deploy"): AutonomyCaps {
  return resolveAutonomyCaps({ AUTONOMY_DISABLE_CAPABILITIES: name });
}
function withChannelOff(name: string): AutonomyCaps {
  return resolveAutonomyCaps({ AUTONOMY_DISABLE_CHANNELS: name });
}

describe("evaluatePolicy ⇐ decideAutonomy (#727) — default workspace is autonomous", () => {
  it("runs every capability autonomously by default — publish / post / send / deploy / draft", () => {
    for (const actionType of [
      "blog.publish",
      "realworld.publish",
      "social.publish_post",
      "chat.post_message",
      "outreach.send",
      "external.send",
      "email.send",
      "sms.send",
      "venture.deploy",
      "release.ship",
      "blog.draft",
      "post.compose",
      "agent.deliverable",
    ]) {
      const d = evaluatePolicy({ actionType }, NO_RULES, DEFAULT_CAPS);
      expect(d.requiresApproval, actionType).toBe(false);
    }
  });

  it("pauses ONLY money/spend — the one hard gate (type, money verb, real spend)", () => {
    // A money action TYPE (in MONEY_ACTIONS).
    expect(evaluatePolicy({ actionType: "billing.refund" }, NO_RULES, DEFAULT_CAPS).requiresApproval).toBe(true);
    expect(evaluatePolicy({ actionType: "venture.ad_spend" }, NO_RULES, DEFAULT_CAPS).requiresApproval).toBe(true);
    // A money verb the #727 classifier catches even on a generic type the #243 set never listed.
    const charge = evaluatePolicy({ actionType: "wallet.charge" }, NO_RULES, DEFAULT_CAPS);
    expect(charge.requiresApproval).toBe(true);
    expect(charge.reason).toMatch(/money|approval/i);
    // A real budget riding a generic (non-money) action type — the amount-aware #243 spend gate still fires.
    const spend = evaluatePolicy({ actionType: "external.send", amount: 5000 }, NO_RULES, DEFAULT_CAPS);
    expect(spend.requiresApproval).toBe(true);
    expect(spend.reason).toMatch(/spend|money/i);
    // An indeterminate cost never auto-spends (conservative).
    expect(
      evaluatePolicy({ actionType: "external.send", amount: Number.NaN }, NO_RULES, DEFAULT_CAPS).requiresApproval,
    ).toBe(true);
  });
});

describe("evaluatePolicy ⇐ decideAutonomy (#727) — per-capability / per-channel opt-out", () => {
  it("a dialed-off CAPABILITY re-gates only its own actions (publish), nothing else", () => {
    const caps = withCapabilityOff("publish");
    const gated = evaluatePolicy({ actionType: "blog.publish" }, NO_RULES, caps);
    expect(gated.requiresApproval).toBe(true);
    expect(gated.reason).toMatch(/publish.*switched off|switched off.*publish/i);
    // A different capability is untouched — outreach still ships autonomously.
    expect(evaluatePolicy({ actionType: "outreach.send" }, NO_RULES, caps).requiresApproval).toBe(false);
    // Money is unaffected (still gated).
    expect(evaluatePolicy({ actionType: "billing.refund" }, NO_RULES, caps).requiresApproval).toBe(true);
  });

  it("a dialed-off CAPABILITY re-gates outreach sends; the others still ship", () => {
    const caps = withCapabilityOff("outreach");
    expect(evaluatePolicy({ actionType: "outreach.send" }, NO_RULES, caps).requiresApproval).toBe(true);
    expect(evaluatePolicy({ actionType: "blog.publish" }, NO_RULES, caps).requiresApproval).toBe(false);
  });

  it("a dialed-off CHANNEL re-gates only sends on that channel (when the actuator passes it)", () => {
    const caps = withChannelOff("email");
    // The email channel send re-gates…
    expect(
      evaluatePolicy({ actionType: OUTREACH_SEND_ACTION, channel: "email" }, NO_RULES, caps).requiresApproval,
    ).toBe(true);
    // …but the same send on a still-enabled channel stays autonomous.
    expect(
      evaluatePolicy({ actionType: OUTREACH_SEND_ACTION, channel: "sms" }, NO_RULES, caps).requiresApproval,
    ).toBe(false);
    // And with no channel hint the verb-inferred decision is unchanged (autonomous).
    expect(evaluatePolicy({ actionType: OUTREACH_SEND_ACTION }, NO_RULES, caps).requiresApproval).toBe(false);
  });

  it("an explicit workspace rule still wins over the autonomy default (re-gate or auto-approve)", () => {
    const reGate: PolicyRule[] = [{ actionType: "blog.publish", requiresApproval: true, maxAutoAmount: null }];
    expect(evaluatePolicy({ actionType: "blog.publish" }, reGate, DEFAULT_CAPS).requiresApproval).toBe(true);
    // A cautious workspace can also opt a money-free action back to autonomous explicitly — unchanged.
    const autoApprove: PolicyRule[] = [{ actionType: "blog.publish", requiresApproval: false, maxAutoAmount: null }];
    expect(evaluatePolicy({ actionType: "blog.publish" }, autoApprove, withCapabilityOff("publish")).requiresApproval).toBe(
      false,
    );
  });
});

describe("#727 always-on guards stay orthogonal to the autonomy decision", () => {
  it("kill-switch / suppression / anti-injection are guards, NOT opt-out toggles", () => {
    expect([...ALWAYS_ON_GUARDS]).toEqual(["kill_switch", "suppression_opt_out", "anti_injection"]);
    for (const g of ALWAYS_ON_GUARDS) expect(isAlwaysOnGuard(g)).toBe(true);
    // They are never an autonomy capability/channel, so dialing capabilities off can never touch them.
    expect(isAlwaysOnGuard("publish")).toBe(false);
    expect(isAlwaysOnGuard("outreach")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------
// End-to-end through the real-world ACTUATOR (#231) — the agent's `publish` tool. The actuator's #13
// gate is wired to `evaluatePolicy` exactly as production wires it (`realworld/default.ts`), so this
// exercises the full path: a default workspace publishes autonomously; dialing the publish capability OFF
// re-parks it for approval. Money-free publish is the canonical "capability ON, no money" case.
// ---------------------------------------------------------------------------------------------------

function fakeStore(): ArtifactStore & { records: ArtifactRecordInput[] } {
  const records: ArtifactRecordInput[] = [];
  return {
    records,
    async record(input) {
      records.push(input);
      return { id: `art-${records.length}` };
    },
  };
}

/** A #13 gate wired to `evaluatePolicy` with the given caps — the production shape (realworld/default.ts). */
function autonomyGate(caps: AutonomyCaps): ToolApprovalGate & { submitted: string[] } {
  const submitted: string[] = [];
  return {
    submitted,
    async requiresApproval(_workspaceId: string) {
      // Production passes only the actionType; the capability is INFERRED from the verb (`publish`).
      return evaluatePolicy({ actionType: REALWORLD_PUBLISH_ACTION }, NO_RULES, caps).requiresApproval;
    },
    async submit() {
      const id = `req-${submitted.length + 1}`;
      submitted.push(id);
      return { id };
    },
  };
}

function makeActuator(caps: AutonomyCaps, store: ArtifactStore, gate: ToolApprovalGate) {
  return new RealWorldActuatorService({
    publish: new DryRunPublishProvider(),
    artifacts: store,
    approvals: gate,
    connectedAccounts: async () => new Set<ServiceKind>(["hosting"]), // the publish prerequisite is met
  });
}

const PUBLISH = { workspaceId: "w1", slug: "launch", html: "<h1>hi</h1>", requesterMemberId: "m1" };

describe("real-world actuator (#231) honors #727 autonomy end-to-end", () => {
  it("PUBLISHES autonomously for a default workspace — no human approval parked", async () => {
    const store = fakeStore();
    const gate = autonomyGate(DEFAULT_CAPS);
    const out = await makeActuator(DEFAULT_CAPS, store, gate).publishPage(PUBLISH);
    expect(out.status).toBe("published");
    expect(gate.submitted).toHaveLength(0); // nothing parked — it shipped on its own
    expect(store.records.at(-1)?.status).toBe("published");
  });

  it("PARKS a #13 approval once the publish capability is dialed OFF", async () => {
    const caps = withCapabilityOff("publish");
    const store = fakeStore();
    const gate = autonomyGate(caps);
    const out = await makeActuator(caps, store, gate).publishPage(PUBLISH);
    expect(out.status).toBe("pending_approval");
    expect(gate.submitted).toHaveLength(1);
    expect(store.records.at(-1)?.status).toBe("pending_approval");
  });
});
