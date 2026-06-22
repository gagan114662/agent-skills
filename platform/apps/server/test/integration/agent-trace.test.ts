import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { createDefaultTraceService } from "../../src/trace/default.js";
import { setServiceCredentials } from "../../src/db/repositories/external-credentials.js";
import { REDACTION_MASK } from "../../src/runtime/redact.js";
import { SENSITIVE_KEY_MASK } from "../../src/trace/redact.js";

/**
 * Issue #560 acceptance against real Postgres — the unified observation/replay trace:
 *   1. an agent run's trace records every model request/response, tool call+result and approval decision,
 *      append-only, in gap-free order, with token/cost rolled up onto the run
 *   2. a replay reconstructs the decision path turn-by-turn
 *   3. secrets are redacted before persist — known secret VALUES (from the #192 vault) and sensitive KEYS
 *   4. the trace is readable over the console REST surface (header, full events, replay)
 *   5. cross-workspace access is rejected (the #3 IDOR guard) — service AND routes
 */

let app: FastifyInstance;
const slugs: string[] = [];

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await closeDb();
});

interface Owner {
  cookie: string;
  workspaceId: string;
  memberId: string;
}

async function newOwner(): Promise<Owner> {
  const slug = `trace-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "Owner", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  return { cookie, workspaceId: me.workspaceId, memberId: me.memberId };
}

describe("unified observation/replay trace (#560)", () => {
  it("records a run append-only, redacts secrets, replays the decision path, and is workspace-scoped", async () => {
    const owner = await newOwner();
    const svc = createDefaultTraceService();

    // a known secret VALUE the runtime would have injected as env (sealed into the #192 vault).
    const SECRET = "sk-live-TRACE-SECRET-9981";
    await setServiceCredentials({
      workspaceId: owner.workspaceId,
      serviceKey: "openai",
      secrets: { OPENAI_API_KEY: SECRET },
      connectedByMemberId: owner.memberId,
    });

    const { id: runId } = await svc.openRun({
      workspaceId: owner.workspaceId,
      agentMemberId: owner.memberId,
      label: "demo run",
    });

    // turn 0: request (with the secret embedded + a sensitive header key) → response → tool call+result
    await svc.recordModelRequest(owner.workspaceId, runId, {
      turn: 0,
      label: "claude-opus",
      payload: {
        system: "you are an agent",
        messages: [{ role: "user", content: `use ${SECRET} to call the api` }],
        headers: { authorization: `Bearer ${SECRET}` },
        tools: ["search"],
      },
      usage: { inputTokens: 120 },
    });
    await svc.recordModelResponse(owner.workspaceId, runId, {
      turn: 0,
      label: "claude-opus",
      payload: { reasoning: "I'll search first", text: "searching" },
      usage: { outputTokens: 40, costMicros: 1500 },
    });
    await svc.recordToolCall(owner.workspaceId, runId, {
      turn: 0,
      label: "search",
      payload: { query: "pricing" },
    });
    await svc.recordToolResult(owner.workspaceId, runId, {
      turn: 0,
      label: "search",
      payload: { hits: 3 },
    });
    // turn 1: an approval-gate decision
    await svc.recordApprovalDecision(owner.workspaceId, runId, {
      turn: 1,
      label: "approved",
      payload: { gate: "spend", verdict: "approved", amount: 500 },
    });
    await svc.closeRun(owner.workspaceId, runId);

    // 1. append-only, gap-free order + rollup
    const trace = await svc.getTrace(owner.workspaceId, runId);
    expect(trace).toBeDefined();
    expect(trace!.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(trace!.events.map((e) => e.type)).toEqual([
      "model_request",
      "model_response",
      "tool_call",
      "tool_result",
      "approval_decision",
    ]);
    expect(trace!.run.status).toBe("closed");
    expect(trace!.run.eventCount).toBe(5);
    expect(trace!.run.inputTokens).toBe(120);
    expect(trace!.run.outputTokens).toBe(40);
    expect(trace!.run.costMicros).toBe(1500);

    // 3. redaction — the secret VALUE never persisted; the sensitive KEY masked
    const stored = JSON.stringify(trace!.events[0].payload);
    expect(stored).not.toContain(SECRET);
    expect(stored).toContain(REDACTION_MASK);
    expect(
      (trace!.events[0].payload as { headers: Record<string, string> }).headers.authorization,
    ).toBe(SENSITIVE_KEY_MASK);

    // 2. replay reconstructs the decision path
    const replay = await svc.replay(owner.workspaceId, runId);
    expect(replay!.turns).toHaveLength(2);
    expect(replay!.turns[0].request!.seq).toBe(0);
    expect(replay!.turns[0].response!.seq).toBe(1);
    expect(replay!.turns[0].toolCalls).toHaveLength(1);
    expect(replay!.turns[0].toolCalls[0].result!.seq).toBe(3);
    expect(replay!.turns[1].approvals).toHaveLength(1);
    expect(replay!.orphans).toHaveLength(0);

    // 4. readable over the console REST surface
    const list = await app.inject({
      method: "GET",
      url: `/workspaces/${owner.workspaceId}/traces`,
      cookies: { rid: owner.cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().some((r: { id: string }) => r.id === runId)).toBe(true);

    const full = await app.inject({
      method: "GET",
      url: `/workspaces/${owner.workspaceId}/traces/${runId}`,
      cookies: { rid: owner.cookie },
    });
    expect(full.statusCode).toBe(200);
    expect(full.json().events).toHaveLength(5);
    expect(JSON.stringify(full.json())).not.toContain(SECRET);

    const replayResp = await app.inject({
      method: "GET",
      url: `/workspaces/${owner.workspaceId}/traces/${runId}/replay`,
      cookies: { rid: owner.cookie },
    });
    expect(replayResp.statusCode).toBe(200);
    expect(replayResp.json().turns).toHaveLength(2);

    // 5. cross-workspace is rejected — service returns undefined, route 404s
    const other = await newOwner();
    expect(await svc.getTrace(other.workspaceId, runId)).toBeUndefined();
    const foreign = await app.inject({
      method: "GET",
      url: `/workspaces/${other.workspaceId}/traces/${runId}`,
      cookies: { rid: other.cookie },
    });
    expect(foreign.statusCode).toBe(404);
  });
});
