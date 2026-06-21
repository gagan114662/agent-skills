import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { createDefaultExecutionToolService } from "../agent-tools/default.js";

/**
 * Agent execution-tool routes (#464) — the runtime surface where an agent (or the console acting for one)
 * invokes a real-world action. Every invocation is parked behind a #13 human-approval; nothing fires here.
 *
 *  - `GET  /me/agent-tools` — the catalog of execution tools the fleet carries (optionally `?department=`),
 *    so a caller can discover what an "acts outside" agent can request. Read-only.
 *  - `POST /me/agent-tools/:name/invoke` — request an action (body = the tool's args). On success it parks a
 *    PENDING approval and returns 202 with the `approvalRequestId` — the action runs only after the owner
 *    approves it in the decision queue. 400 invalid args, 404 unknown tool, 409 tools disabled.
 *
 * Human/agent-auth + workspace-scoped (#3, the `rid` session cookie identifies the workspace).
 */
export async function agentToolRoutes(app: FastifyInstance): Promise<void> {
  const service = createDefaultExecutionToolService(app.log);

  // The execution-tool catalog — what an "acts outside" agent can request. Never a secret.
  app.get("/me/agent-tools", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { department } = req.query as { department?: string };
    return {
      tools: service.listTools(department).map((t) => ({
        name: t.name,
        label: t.label,
        description: t.description,
        department: t.department,
        gatedAction: t.gatedAction,
        visibility: t.visibility,
      })),
    };
  });

  // Request a real-world action. Parks a PENDING #13 approval (202) — it never fires without the owner's yes.
  app.post("/me/agent-tools/:name/invoke", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { name } = req.params as { name: string };
    const args = (req.body as { args?: unknown })?.args ?? req.body ?? {};
    const result = await service.invoke({
      workspaceId: id.workspaceId,
      requesterMemberId: id.memberId,
      toolName: name,
      args,
    });
    switch (result.status) {
      case "disabled":
        return reply.code(409).send({ error: "execution tools are not enabled for this workspace" });
      case "unknown_tool":
        return reply.code(404).send({ error: `no such execution tool: ${result.toolName}` });
      case "rejected":
        return reply.code(400).send({ error: result.reason });
      case "pending_approval":
        return reply.code(202).send({
          status: result.status,
          approvalRequestId: result.approvalRequestId,
          gatedAction: result.gatedAction,
          boundary: result.boundary,
          summary: result.summary,
        });
    }
  });
}
