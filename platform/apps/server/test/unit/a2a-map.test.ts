import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { validateDef, type JsonSchema } from "../../src/protocols/jsonschema.js";
import {
  buildAgentCard,
  toA2ATask,
  a2aMessage,
  a2aStateFromStatus,
  partsToText,
  A2A_STATE_BY_STATUS,
} from "../../src/protocols/a2a/map.js";
import type { TaskStatus } from "../../src/tasks/status.js";

/**
 * A2A mappers (#12) + conformance: the AgentCard / Task / Message we emit must validate against the
 * vendored published A2A schema. Pure inputs in, schema-valid wire objects out.
 */
const a2aSchema = JSON.parse(
  readFileSync(new URL("../fixtures/a2a.schema.json", import.meta.url), "utf8"),
) as JsonSchema;

describe("A2A mappers", () => {
  it("maps every internal task status to a valid A2A state", () => {
    const statuses: TaskStatus[] = [
      "backlog",
      "todo",
      "in_progress",
      "blocked",
      "done",
      "canceled",
    ];
    for (const s of statuses) {
      expect(validateDef(a2aSchema, "TaskState", a2aStateFromStatus(s)).valid).toBe(true);
    }
    expect(A2A_STATE_BY_STATUS.in_progress).toBe("working");
    expect(A2A_STATE_BY_STATUS.done).toBe("completed");
    expect(A2A_STATE_BY_STATUS.canceled).toBe("canceled");
  });

  it("flattens mixed parts to text (handoff context)", () => {
    expect(
      partsToText([
        { kind: "text", text: "hello" },
        { kind: "data", data: { a: 1 } },
      ]),
    ).toBe('hello\n{"a":1}');
  });

  it("builds a conformant AgentCard advertising bearer auth + a handoff skill (the handshake)", () => {
    const card = buildAgentCard(
      { name: "planner", framework: "langgraph" },
      { baseUrl: "http://localhost:3000", agentId: "agt_123" },
    );
    expect(card.protocolVersion).toBe("0.3.0");
    expect(card.url).toBe("http://localhost:3000/a2a/agents/agt_123");
    expect(card.securitySchemes?.bearerAuth).toEqual({ type: "http", scheme: "bearer" });
    expect(card.skills.some((s) => s.id === "handoff")).toBe(true);
    // framework surfaces as a routing tag
    expect(card.skills[0].tags).toContain("langgraph");
    expect(validateDef(a2aSchema, "AgentCard", card).valid).toBe(true);
  });

  it("builds a conformant Task with preserved history, and a conformant Message", () => {
    const msg = a2aMessage({ messageId: "m1", role: "user", text: "take this over", taskId: "t1" });
    expect(validateDef(a2aSchema, "Message", msg).valid).toBe(true);

    const task = toA2ATask({
      id: "t1",
      status: "backlog",
      history: [msg],
      timestamp: "2026-06-08T00:00:00.000Z",
    });
    expect(task.kind).toBe("task");
    expect(task.contextId).toBe("t1"); // defaults to the task id
    expect(task.status.state).toBe("submitted");
    const res = validateDef(a2aSchema, "Task", task);
    expect(res.errors).toEqual([]);
    expect(res.valid).toBe(true);
  });

  it("conformance is real — a malformed task is rejected", () => {
    const bad = { kind: "task", id: "t1", status: { state: "not-a-state" } };
    expect(validateDef(a2aSchema, "Task", bad).valid).toBe(false); // bad state + missing contextId
  });
});
