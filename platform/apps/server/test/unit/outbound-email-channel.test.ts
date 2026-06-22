import { describe, it, expect } from "vitest";
import { evaluateOutboundEmail } from "../../src/outbound-email/channel.js";
import { InMemoryContactPolicyStore } from "../../src/outbound-email/suppression.js";
import {
  InMemoryTemplateApprovalRegistry,
  fingerprintTemplate,
} from "../../src/outbound-email/template-approval.js";
import type { SenderAuthInput } from "../../src/email/deliverability.js";

const NOW = 3_000_000;
const TEMPLATE = { id: "outreach-v1", subject: "Quick question", body: "Hi there — worth a chat?" };

const ALIGNED_AUTH: SenderAuthInput = {
  spf: { published: true, includesEsp: true },
  dkim: { published: true, verified: true },
  dmarc: { published: true, policy: "reject" },
};
const PASSING_HEADER = "spf=pass; dkim=pass; dmarc=pass";

/** A fully-cleared baseline: approved template, authenticated sender, consented recipients, headroom. */
function baseline() {
  const contactPolicy = new InMemoryContactPolicyStore();
  for (const e of ["a@example.com", "b@example.com"]) {
    contactPolicy.recordConsent(e, { basis: "opt_in", at: NOW - 1000 });
  }
  const templateRegistry = new InMemoryTemplateApprovalRegistry();
  templateRegistry.approve(fingerprintTemplate(TEMPLATE), { approvedBy: "owner", at: NOW });
  return {
    template: TEMPLATE,
    templateRegistry,
    contactPolicy,
    recipients: ["a@example.com", "b@example.com"],
    sender: { auth: ALIGNED_AUTH, authResultsHeader: PASSING_HEADER },
    caps: { warmup: { grantable: 100, reason: "warm" }, rate: { grantable: 100, reason: "rate ok" } },
    now: NOW,
  };
}

describe("evaluateOutboundEmail (unified channel gate)", () => {
  it("clears a fully-compliant send", () => {
    const d = evaluateOutboundEmail(baseline());
    expect(d.ok).toBe(true);
    expect(d.blockedReasons).toEqual([]);
    expect(d.granted.sort()).toEqual(["a@example.com", "b@example.com"]);
    expect(d.dropped).toEqual([]);
  });

  it("blocks the entire send when the template is not approved", () => {
    const req = baseline();
    req.templateRegistry = new InMemoryTemplateApprovalRegistry(); // nothing approved
    const d = evaluateOutboundEmail(req);
    expect(d.ok).toBe(false);
    expect(d.template.approved).toBe(false);
    expect(d.blockedReasons.join(" ")).toMatch(/template.*approval/i);
    expect(d.granted).toEqual([]); // never sends an unapproved template
  });

  it("blocks the send when the sender is not deliverable (no Authentication-Results receipt)", () => {
    const req = baseline();
    req.sender = { auth: ALIGNED_AUTH, authResultsHeader: null };
    const d = evaluateOutboundEmail(req);
    expect(d.ok).toBe(false);
    expect(d.deliverability.deliverable).toBe(false);
    expect(d.blockedReasons.join(" ")).toMatch(/deliverab/i);
  });

  it("ALWAYS drops suppressed/non-consented recipients and only grants the rest", () => {
    const req = baseline();
    req.contactPolicy.suppress("a@example.com", { reason: "unsubscribe", at: NOW });
    req.recipients = ["a@example.com", "b@example.com", "no-consent@example.com"];
    const d = evaluateOutboundEmail(req);
    expect(d.ok).toBe(true); // b@ is still contactable
    expect(d.granted).toEqual(["b@example.com"]);
    const droppedEmails = d.dropped.map((x) => x.email).sort();
    expect(droppedEmails).toEqual(["a@example.com", "no-consent@example.com"]);
  });

  it("blocks the send when every recipient is suppressed/non-consented", () => {
    const req = baseline();
    req.contactPolicy.suppress("a@example.com", { reason: "complaint", at: NOW });
    req.contactPolicy.suppress("b@example.com", { reason: "bounce", at: NOW });
    const d = evaluateOutboundEmail(req);
    expect(d.ok).toBe(false);
    expect(d.granted).toEqual([]);
    expect(d.blockedReasons.join(" ")).toMatch(/no .*recipient/i);
  });

  it("truncates granted recipients to the send budget (warmup/rate caps)", () => {
    const req = baseline();
    req.recipients = ["a@example.com", "b@example.com"];
    req.caps = { warmup: { grantable: 1, reason: "warmup day 0" }, rate: { grantable: 100, reason: "rate ok" } };
    const d = evaluateOutboundEmail(req);
    expect(d.ok).toBe(true);
    expect(d.sendBudget.grantable).toBe(1);
    expect(d.granted.length).toBe(1); // only 1 of 2 fits under the cap
  });

  it("blocks when the send budget is exhausted (cap grants zero)", () => {
    const req = baseline();
    req.caps = { warmup: { grantable: 0, reason: "warmup exhausted" }, rate: { grantable: 100, reason: "rate ok" } };
    const d = evaluateOutboundEmail(req);
    expect(d.ok).toBe(false);
    expect(d.granted).toEqual([]);
    expect(d.blockedReasons.join(" ")).toMatch(/cap|budget|warmup/i);
  });
});
