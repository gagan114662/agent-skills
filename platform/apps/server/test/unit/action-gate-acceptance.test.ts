/**
 * Acceptance test for issue #670. The literal acceptance criterion:
 *
 *   "no public/irreversible action executes without a recorded approval."
 *
 * These tests drive the full guard → approve → consume pipeline through the public barrel exactly as an actuator
 * (an emailer, publisher, social poster, record deleter) would, and assert that NO public/irreversible action is
 * ever green-lit without a recorded human approval bound to that exact action.
 */

import { describe, it, expect } from "vitest";
import {
  ActionGateService,
  ActionGateError,
  InMemoryGateRequestStore,
  type ActionDescriptor,
  type ActionGateCaps,
} from "../../src/action-gate/index.js";

const WID = "ws-acceptance";
const AGENT = "member-agent";
const OWNER = "member-owner";

const CAPS: ActionGateCaps = {
  approvalTtlMs: 60_000,
  extraIrreversibleVerbs: [],
  extraPublicVerbs: [],
  extraSafeVerbs: [],
};

function makeService() {
  return new ActionGateService({ store: new InMemoryGateRequestStore(), caps: CAPS, now: () => new Date(1_000) });
}

/** A gallery of the public/irreversible actions the issue calls out, plus an uncertain one (fail-closed). */
const PUBLIC_OR_IRREVERSIBLE: Array<{ name: string; action: ActionDescriptor }> = [
  { name: "publish a page", action: { action: "page.publish", surface: "https://site.example/launch" } },
  { name: "send an email", action: { action: "email.send", surface: "subscribers", payload: { count: 4200 } } },
  { name: "post to social", action: { action: "social.publish_post", surface: "x.com" } },
  { name: "delete a record", action: { action: "record.delete", payload: { id: 5 } } },
  { name: "deploy to prod", action: { action: "deploy", surface: "prod" } },
  { name: "transfer money", action: { action: "billing.transfer", payload: { cents: 10_000 } } },
  { name: "unknown verb (fail-closed)", action: { action: "frobnicate", payload: { x: 1 } } },
];

describe("issue #670 acceptance — no public/irreversible action executes without a recorded approval", () => {
  for (const { name, action } of PUBLIC_OR_IRREVERSIBLE) {
    it(`[${name}] guardAction never green-lights it inline`, async () => {
      const service = makeService();
      const res = await service.guardAction({ workspaceId: WID, requesterMemberId: AGENT, action });
      expect(res.allowed).toBe(false);
      expect(res.request?.status).toBe("pending");
    });

    it(`[${name}] cannot be consumed until a human records an approval`, async () => {
      const service = makeService();
      const parked = await service.guardAction({ workspaceId: WID, requesterMemberId: AGENT, action });
      const id = parked.request!.id;

      // Before any approval: every attempt to consume throws — the action cannot execute.
      await expect(
        service.consumeApproval({ workspaceId: WID, requestId: id, requesterMemberId: AGENT, action }),
      ).rejects.toBeInstanceOf(ActionGateError);

      // After a recorded human approval: the action is green-lit exactly once, with the approval on record.
      await service.approve(WID, id, OWNER, { forbidSelfApproval: true });
      const executed = await service.consumeApproval({ workspaceId: WID, requestId: id, requesterMemberId: AGENT, action });
      expect(executed.status).toBe("executed");
      expect(executed.decidedByMemberId).toBe(OWNER);
    });
  }

  it("an internal, reversible action (a read) still runs autonomously — the gate adds no theater", async () => {
    const service = makeService();
    const res = await service.guardAction({ workspaceId: WID, requesterMemberId: AGENT, action: { action: "db.read" } });
    expect(res.allowed).toBe(true);
    expect(res.request).toBeNull();
  });

  it("a recorded approval is single-use and cannot be replayed for a different action", async () => {
    const service = makeService();
    const sendOne: ActionDescriptor = { action: "email.send", payload: { to: "a@x.z" } };
    const sendTwo: ActionDescriptor = { action: "email.send", payload: { to: "victim@x.z" } };

    const parked = await service.guardAction({ workspaceId: WID, requesterMemberId: AGENT, action: sendOne });
    await service.approve(WID, parked.request!.id, OWNER);

    // The same approval cannot authorize a DIFFERENT send …
    await expect(
      service.consumeApproval({ workspaceId: WID, requestId: parked.request!.id, requesterMemberId: AGENT, action: sendTwo }),
    ).rejects.toThrow(/different action/);

    // … and once used for its own action, it cannot be used again.
    await service.consumeApproval({ workspaceId: WID, requestId: parked.request!.id, requesterMemberId: AGENT, action: sendOne });
    await expect(
      service.consumeApproval({ workspaceId: WID, requestId: parked.request!.id, requesterMemberId: AGENT, action: sendOne }),
    ).rejects.toBeInstanceOf(ActionGateError);
  });
});
