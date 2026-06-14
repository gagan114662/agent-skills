import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import { DecisionMakerService, AccountNotAvailableError } from "../decision-maker/service.js";
import { NoResolvableBuyerError } from "../decision-maker/resolve.js";
import {
  isBuyerRole,
  isPublicSourceKind,
  type AccountContact,
  type PublicSource,
  type TargetAccount,
} from "../decision-maker/types.js";

/**
 * Decision-maker resolver routes (#223, ADR-0223) under `/workspaces/:wid/decision-maker`. Thin adapters
 * over {@link DecisionMakerService} — identity + the #19 `assertWorkspace` IDOR boundary, then a single
 * service call. The resolve route accepts a target account directly (the documented #222 input contract),
 * so the resolver composes + tests in isolation before the discovery queue lands.
 *
 * These routes only RESOLVE + READ + persist a brief. There is no send/spend endpoint here — outreach is
 * a separate, #13-gated concern (the hard separation from the read agent, #200).
 */
export interface DecisionMakerRoutesOptions {
  service: DecisionMakerService;
}

/** Parse + sanitize the untrusted request body into a {@link TargetAccount}, or return null if invalid. */
function parseAccount(body: unknown): TargetAccount | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.id !== "string" || typeof b.name !== "string") return null;
  if (!Array.isArray(b.contacts) || !Array.isArray(b.sources)) return null;

  const contacts: AccountContact[] = [];
  for (const raw of b.contacts) {
    if (typeof raw !== "object" || raw === null) return null;
    const c = raw as Record<string, unknown>;
    if (typeof c.id !== "string" || typeof c.name !== "string") return null;
    if (!isBuyerRole(c.role)) return null;
    contacts.push({
      id: c.id,
      name: c.name,
      title: typeof c.title === "string" ? c.title : "",
      role: c.role,
    });
  }

  const sources: PublicSource[] = [];
  for (const raw of b.sources) {
    if (typeof raw !== "object" || raw === null) return null;
    const s = raw as Record<string, unknown>;
    if (typeof s.id !== "string" || typeof s.contactId !== "string" || typeof s.url !== "string") {
      return null;
    }
    if (!isPublicSourceKind(s.kind)) return null;
    sources.push({
      id: s.id,
      contactId: s.contactId,
      kind: s.kind,
      url: s.url,
      fetchedText: typeof s.fetchedText === "string" ? s.fetchedText : undefined,
      fetchedAt: typeof s.fetchedAt === "string" ? s.fetchedAt : undefined,
    });
  }

  return {
    id: b.id,
    name: b.name,
    domain: typeof b.domain === "string" ? b.domain : "",
    painArea: typeof b.painArea === "string" ? b.painArea : "",
    contacts,
    sources,
    ideaId: typeof b.ideaId === "string" ? b.ideaId : null,
  };
}

export async function decisionMakerRoutes(
  app: FastifyInstance,
  opts: DecisionMakerRoutesOptions,
): Promise<void> {
  const { service } = opts;

  /**
   * Resolve a target account (the #222 input contract, in the body) into a persisted buyer brief: the
   * resolved buyer, a falsifiable rationale, what they care about, and grounded angle hooks. 201 + brief.
   */
  app.post("/workspaces/:wid/decision-maker/resolve", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;

    const account = parseAccount(req.body);
    if (!account) {
      return reply
        .code(400)
        .send({ error: "body must be a target account: { id, name, contacts[], sources[] }" });
    }
    try {
      const brief = await service.resolveAccount(wid, account);
      return reply.code(201).send(brief);
    } catch (err) {
      if (err instanceof NoResolvableBuyerError) {
        return reply.code(422).send({ error: err.message });
      }
      throw err;
    }
  });

  /** Resolve by #222 account id (when the discovery queue is wired). 201 + brief, or 422 if unavailable. */
  app.post("/workspaces/:wid/decision-maker/accounts/:aid/resolve", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, aid } = req.params as { wid: string; aid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    try {
      const brief = await service.resolveById(wid, aid);
      return reply.code(201).send(brief);
    } catch (err) {
      if (err instanceof AccountNotAvailableError) {
        return reply.code(422).send({ error: err.message });
      }
      if (err instanceof NoResolvableBuyerError) {
        return reply.code(422).send({ error: err.message });
      }
      throw err;
    }
  });

  /** List the workspace's buyer briefs, newest first. */
  app.get("/workspaces/:wid/decision-maker/briefs", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return service.listBriefs(wid);
  });

  /** Fetch one buyer brief by id. 404 if it isn't in this workspace. */
  app.get("/workspaces/:wid/decision-maker/briefs/:bid", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, bid } = req.params as { wid: string; bid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const brief = await service.getBrief(wid, bid);
    if (!brief) return reply.code(404).send({ error: "buyer brief not found" });
    return brief;
  });
}
