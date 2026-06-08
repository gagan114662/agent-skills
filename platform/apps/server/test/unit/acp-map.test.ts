import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { validateDef, type JsonSchema } from "../../src/protocols/jsonschema.js";
import {
  toAcpAgent,
  acpMessage,
  acpPartsToText,
  deriveRunStatus,
  toAcpRun,
} from "../../src/protocols/acp/map.js";

/**
 * ACP mappers (#12) + conformance: the Agent manifest / Run / Message we emit must validate against
 * the vendored published ACP schema.
 */
const acpSchema = JSON.parse(
  readFileSync(new URL("../fixtures/acp.schema.json", import.meta.url), "utf8"),
) as JsonSchema;

describe("ACP mappers", () => {
  it("maps a registry agent to a conformant manifest", () => {
    const agent = toAcpAgent({ name: "planner", framework: "crewai", deactivatedAt: null });
    expect(agent.name).toBe("planner");
    expect(agent.metadata?.framework).toBe("crewai");
    expect(agent.metadata?.status).toBe("active");
    expect(validateDef(acpSchema, "Agent", agent).valid).toBe(true);
  });

  it("flattens message parts to text and round-trips a conformant message", () => {
    const msg = acpMessage("user", "do the thing");
    expect(acpPartsToText(msg.parts)).toBe("do the thing");
    expect(validateDef(acpSchema, "Message", msg).valid).toBe(true);
  });

  it("derives run status from thread state", () => {
    expect(deriveRunStatus({ hasAgentReply: false })).toBe("created");
    expect(deriveRunStatus({ hasAgentReply: true })).toBe("completed");
    expect(deriveRunStatus({ hasAgentReply: true, cancelled: true })).toBe("cancelled");
  });

  it("builds a conformant Run whose output maps thread replies to ACP messages", () => {
    const run = toAcpRun({
      run_id: "msg_root",
      agent_name: "planner",
      session_id: "msg_root",
      status: "completed",
      output: [acpMessage("agent", "done")],
    });
    expect(run.run_id).toBe("msg_root");
    expect(run.output[0].role).toBe("agent");
    const res = validateDef(acpSchema, "Run", run);
    expect(res.errors).toEqual([]);
    expect(res.valid).toBe(true);
  });

  it("conformance is real — a malformed run is rejected", () => {
    const bad = { run_id: "x", agent_name: "p", status: "bogus", output: [] };
    expect(validateDef(acpSchema, "Run", bad).valid).toBe(false);
  });
});
