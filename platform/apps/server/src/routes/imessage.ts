import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import type { IMessageRelayService } from "../imessage/service.js";

export interface IMessageRoutesOptions {
  service: IMessageRelayService;
}

function statusCode(status: string): number {
  if (status === "disabled" || status === "not_configured") return 503;
  if (status === "too_long" || status === "failed") return 400;
  return 200;
}

export async function imessageRoutes(app: FastifyInstance, opts: IMessageRoutesOptions): Promise<void> {
  app.get("/me/imessage/status", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    return opts.service.status();
  });

  app.post("/me/imessage/test", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const body = (req.body ?? {}) as { text?: unknown };
    const text =
      typeof body.text === "string" && body.text.trim()
        ? body.text.trim()
        : "ipop test: your Codex-backed marketing room can reach iMessage.";
    const result = await opts.service.send({ text });
    return reply.code(statusCode(result.status)).send(result);
  });
}
