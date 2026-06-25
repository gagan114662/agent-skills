import type { FastifyInstance } from "fastify";
import { getWorkspaceBySlug } from "../db/repositories/workspaces.js";
import { createDefaultTraceService } from "../trace/default.js";
import type { TraceService } from "../trace/service.js";
import { projectDogfoodFeed } from "../public-dogfood/project.js";

export interface PublicDogfoodRoutesOptions {
  enabledSlugs?: string[];
  limit?: number;
  traceService?: Pick<TraceService, "listRuns" | "getTrace">;
  resolveWorkspace?: (slug: string) => Promise<{ id: string; name: string } | undefined>;
}

function notFound(reply: { code(statusCode: number): unknown }) {
  reply.code(404);
  return { error: "dogfood feed not found" };
}

export async function publicDogfoodRoutes(
  app: FastifyInstance,
  opts: PublicDogfoodRoutesOptions = {},
): Promise<void> {
  const enabled = new Set((opts.enabledSlugs ?? []).map((slug) => slug.trim()).filter(Boolean));
  const traceService = opts.traceService ?? createDefaultTraceService();
  const resolveWorkspace = opts.resolveWorkspace ?? getWorkspaceBySlug;
  const limit = Math.max(1, Math.min(100, opts.limit ?? 30));

  app.get("/dogfood/:slug", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (!enabled.has(slug)) return notFound(reply);

    const ws = await resolveWorkspace(slug);
    if (!ws) return notFound(reply);

    const runs = await traceService.listRuns(ws.id, { limit });
    const traces = await Promise.all(runs.map((run) => traceService.getTrace(ws.id, run.id)));

    return projectDogfoodFeed({
      slug,
      workspaceName: ws.name,
      runs: traces.filter((trace): trace is NonNullable<typeof trace> => Boolean(trace)),
      limit,
    });
  });
}
