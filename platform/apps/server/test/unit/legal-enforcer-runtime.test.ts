import { describe, it, expect } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import {
  buildDefaultRegistry,
  ActionExecutionError,
  noopComplianceEnforcer,
  type ComplianceEnforcer,
  type EgressEnforcer,
} from "../../src/approvals/runtime.js";

const ctx = {
  workspaceId: "ws-1",
  requesterMemberId: "m-1",
  log: { error() {}, info() {}, warn() {} } as unknown as FastifyBaseLogger,
};

const allowEgress: EgressEnforcer = { enforce: () => Promise.resolve(null) };

describe("external.send compliance enforcement (#196 criterion 2)", () => {
  it("the default compliance enforcer is a no-op (existing behavior unchanged)", async () => {
    const send = buildDefaultRegistry(allowEgress, noopComplianceEnforcer).get("external.send")!;
    const out = await send.execute({ kind: "email.send", summary: "hi", target: "user@x.com" }, ctx);
    expect(out).toEqual({ recorded: true, target: "user@x.com", summary: "hi" });
  });

  it("blocks a send the compliance enforcer rejects (and reports the reason)", async () => {
    const calls: unknown[] = [];
    const compliance: ComplianceEnforcer = {
      enforce: (i) => {
        calls.push(i);
        return Promise.resolve("recipient is on the suppression list");
      },
    };
    const send = buildDefaultRegistry(allowEgress, compliance).get("external.send")!;
    await expect(
      send.execute({ kind: "email.send", summary: "hi", target: "user@x.com", compliance: { footer: { unsubscribe: true } } }, ctx),
    ).rejects.toThrow(ActionExecutionError);
    expect(calls).toEqual([
      {
        workspaceId: "ws-1",
        kind: "email.send",
        target: "user@x.com",
        actorMemberId: "m-1",
        envelope: { footer: { unsubscribe: true } },
      },
    ]);
  });

  it("passes the kind + null target through for a targetless send", async () => {
    const seen: unknown[] = [];
    const compliance: ComplianceEnforcer = {
      enforce: (i) => {
        seen.push(i);
        return Promise.resolve(null);
      },
    };
    const send = buildDefaultRegistry(allowEgress, compliance).get("external.send")!;
    const out = await send.execute({ kind: "social.post", summary: "post" }, ctx);
    expect(out).toEqual({ recorded: true, target: null, summary: "post" });
    expect(seen).toEqual([{ workspaceId: "ws-1", kind: "social.post", target: null, actorMemberId: "m-1", envelope: undefined }]);
  });

  it("runs the egress check before the compliance check (egress block short-circuits)", async () => {
    let complianceRan = false;
    const denyEgress: EgressEnforcer = { enforce: () => Promise.resolve("egress blocked") };
    const compliance: ComplianceEnforcer = {
      enforce: () => {
        complianceRan = true;
        return Promise.resolve(null);
      },
    };
    const send = buildDefaultRegistry(denyEgress, compliance).get("external.send")!;
    await expect(send.execute({ kind: "email.send", summary: "x", target: "u@x.com" }, ctx)).rejects.toThrow(
      ActionExecutionError,
    );
    expect(complianceRan).toBe(false);
  });
});
