import { describe, it, expect } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import {
  buildDefaultRegistry,
  ActionExecutionError,
  type EgressEnforcer,
} from "../../src/approvals/runtime.js";

const ctx = {
  workspaceId: "ws-1",
  requesterMemberId: "m-1",
  log: { error() {}, info() {}, warn() {} } as unknown as FastifyBaseLogger,
};

describe("external.send egress enforcement (#151)", () => {
  it("allows a send when the enforcer permits it (records nothing)", async () => {
    const enforcer: EgressEnforcer = { enforce: () => Promise.resolve(null) };
    const send = buildDefaultRegistry(enforcer).get("external.send")!;
    const out = await send.execute({ summary: "hi", target: "https://api.example.com" }, ctx);
    expect(out).toEqual({ recorded: true, target: "https://api.example.com", summary: "hi" });
  });

  it("blocks a send when the enforcer denies the target (and reports the reason)", async () => {
    const calls: unknown[] = [];
    const enforcer: EgressEnforcer = {
      enforce: (i) => {
        calls.push(i);
        return Promise.resolve("egress blocked: domain not allowed");
      },
    };
    const send = buildDefaultRegistry(enforcer).get("external.send")!;
    await expect(send.execute({ summary: "hi", target: "https://evil.com" }, ctx)).rejects.toThrow(
      ActionExecutionError,
    );
    expect(calls).toEqual([
      { workspaceId: "ws-1", target: "https://evil.com", actorMemberId: "m-1" },
    ]);
  });

  it("a targetless send is never egress-checked (no target to evaluate)", async () => {
    let called = false;
    const enforcer: EgressEnforcer = {
      enforce: () => {
        called = true;
        return Promise.resolve("should not run");
      },
    };
    const send = buildDefaultRegistry(enforcer).get("external.send")!;
    const out = await send.execute({ summary: "no target" }, ctx);
    expect(out).toEqual({ recorded: true, target: null, summary: "no target" });
    expect(called).toBe(false);
  });
});
