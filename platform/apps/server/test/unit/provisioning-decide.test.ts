import { describe, it, expect } from "vitest";
import { decideProvision } from "../../src/provisioning/decide.js";
import { resolveProvisioningCaps } from "../../src/provisioning/caps.js";
import { PROVISIONING_CUSTOMER_SPEND_ACTION, isMoneyAction } from "../../src/approvals/policy.js";

const OWNER = "ws-owner";
const OTHER = "ws-other";

const enabledCaps = (extra = {}) =>
  resolveProvisioningCaps({ enabled: true, ownerWorkspaceId: OWNER, ...extra });

/**
 * #267 — the pure routing brain. The two premortem properties live in these assertions:
 *  - money boundary: customer-spend is ALWAYS gated (even when the flag is off); platform-cost autonomous,
 *  - the decision is structural — provider/key derive from the capability id + caps, never from free text.
 */
describe("decideProvision", () => {
  it("unknown capability ⇒ unknown (fail closed)", () => {
    const d = decideProvision("nope", enabledCaps(), OWNER);
    expect(d.status).toBe("unknown");
  });

  it("customer-spend capability is ALWAYS money-gated, even with provisioning OFF", () => {
    const off = decideProvision("ads_spend", resolveProvisioningCaps(undefined), OWNER);
    expect(off.status).toBe("customer_spend");
    if (off.status !== "customer_spend") throw new Error("unreachable");
    expect(off.requiresApproval).toBe(true);
    expect(off.actionType).toBe(PROVISIONING_CUSTOMER_SPEND_ACTION);
    // and the action it names is in the MONEY set, so the #13 engine gates it.
    expect(isMoneyAction(off.actionType)).toBe(true);
  });

  it("customer-spend stays gated even when provisioning is fully enabled", () => {
    const d = decideProvision("email_send_tier", enabledCaps(), OWNER);
    expect(d.status).toBe("customer_spend");
  });

  it("platform-cost + provisioning off for the workspace ⇒ disabled (adapter falls back to mock)", () => {
    const d = decideProvision("keyword_data", resolveProvisioningCaps(undefined), OWNER);
    expect(d.status).toBe("disabled");
  });

  it("platform-cost enabled-but-out-of-scope workspace ⇒ disabled", () => {
    const d = decideProvision("keyword_data", enabledCaps(), OTHER);
    expect(d.status).toBe("disabled");
  });

  it("platform-cost + enabled + in scope ⇒ provisioned via mock by default, autonomous", () => {
    const d = decideProvision("keyword_data", enabledCaps(), OWNER);
    expect(d.status).toBe("provisioned");
    if (d.status !== "provisioned") throw new Error("unreachable");
    expect(d.requiresApproval).toBe(false);
    expect(d.provider).toBe("mock");
    expect(d.centralServiceKey).toBe("central:mock");
  });

  it("uses the config-mapped provider + its central vault key when set", () => {
    const d = decideProvision(
      "serp_data",
      enabledCaps({ providerByCapability: { serp_data: "dataforseo" } }),
      OWNER,
    );
    expect(d.status).toBe("provisioned");
    if (d.status !== "provisioned") throw new Error("unreachable");
    expect(d.provider).toBe("dataforseo");
    expect(d.centralServiceKey).toBe("central:dataforseo");
  });

  it("broadened (ownerWorkspaceOnly:false) provisions any tenant", () => {
    const d = decideProvision(
      "social_post",
      enabledCaps({ ownerWorkspaceOnly: false }),
      OTHER,
    );
    expect(d.status).toBe("provisioned");
  });
});
