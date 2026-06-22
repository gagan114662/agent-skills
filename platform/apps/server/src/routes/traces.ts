import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { requireMemoryCapability } from "../auth/access.js";
import { createDefaultTraceService } from "../trace/default.js";
import type { TraceService } from "../trace/service.js";
import { selectNewEvents, sseComment, sseFrame, toTheaterEvent } from "../trace/theater.js";
import { createDefaultCostService } from "../observability/cost/index.js";
import { createDefaultRunLogService } from "../observability/logs/index.js";

/** Live-theater stream tuning (issue #624). Env-overridable; safe, bounded defaults otherwise. */
const POLL_MS = clampInt(process.env.TRACE_STREAM_POLL_MS, 1_000, 200, 15_000);
/** Max concurrently-followed runs in the fleet stream — keeps a poll tick's DB work bounded. */
const FLEET_RUN_LIMIT = clampInt(process.env.TRACE_STREAM_FLEET_LIMIT, 12, 1, 50);
/** On first sight of a run, the fleet stream replays at most this many trailing events (not full history). */
const FLEET_TAIL = clampInt(process.env.TRACE_STREAM_FLEET_TAIL, 40, 0, 500);

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Parse an ISO timestamp query param into a Date, or undefined for missing/unparseable input (issue #667). */
function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms);
}

/** Standard SSE response head — disables proxy buffering so frames flush as they are written. */
function writeSseHead(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
}

/**
 * Observation/replay trace read routes (issue #560) — the console-timeline + replay surface over an agent
 * run's append-only trace. Read-only on purpose: a trace is WRITTEN by the runtime/harness through the
 * service as a run executes (so secret redaction can never be bypassed at a public write door); these
 * routes only expose it. RBAC reuses the #16 memory ladder (`requireMemoryCapability` read) — a trace is
 * observability data governed like the memory graph. Every route is workspace-scoped (#3 IDOR). Payloads
 * are already redacted at the write site, so nothing here re-exposes a secret or internal chatter (#200).
 */
export async function tracesRoutes(app: FastifyInstance): Promise<void> {
  const service = createDefaultTraceService();
  const costService = createDefaultCostService();
  const logService = createDefaultRunLogService();

  // Every open SSE poll loop registers a stop fn here so a server shutdown tears them all down (no leak).
  const activeStreams = new Set<() => void>();
  app.addHook("onClose", async () => {
    for (const stop of activeStreams) stop();
    activeStreams.clear();
  });

  // list a workspace's trace runs, newest first (the console timeline). ?sessionId= and ?limit= filter.
  app.get("/workspaces/:wid/traces", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!(await requireMemoryCapability(id, wid, "read", reply))) return;
    const q = req.query as { sessionId?: string; limit?: string };
    const limit = q.limit ? Number.parseInt(q.limit, 10) : undefined;
    return service.listRuns(wid, {
      sessionId: q.sessionId,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
  });

  // workspace cost rollup (issue #667): token + estimated-cost totals, broken down per agent and per UTC day.
  // Static `/cost` segment wins over the `/:runId` param route below in Fastify's router (same as `/stream`).
  // ?since/?until are ISO timestamps (invalid values are ignored); ?limit caps the run scan.
  app.get("/workspaces/:wid/traces/cost", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!(await requireMemoryCapability(id, wid, "read", reply))) return;
    const q = req.query as { since?: string; until?: string; limit?: string };
    const since = parseDate(q.since);
    const until = parseDate(q.until);
    const limit = q.limit ? Number.parseInt(q.limit, 10) : undefined;
    return costService.getSummary(wid, {
      since,
      until,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
  });

  // per-run cost (issue #667): the run's token + cost totals plus a per-model breakdown.
  app.get("/workspaces/:wid/traces/:runId/cost", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, runId } = req.params as { wid: string; runId: string };
    if (!(await requireMemoryCapability(id, wid, "read", reply))) return;
    const cost = await costService.getRunCost(wid, runId);
    if (!cost) return reply.code(404).send({ error: "trace not found in this workspace" });
    return cost;
  });

  // the full trace for one run: header + every event in replay (seq) order.
  app.get("/workspaces/:wid/traces/:runId", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, runId } = req.params as { wid: string; runId: string };
    if (!(await requireMemoryCapability(id, wid, "read", reply))) return;
    const trace = await service.getTrace(wid, runId);
    if (!trace) return reply.code(404).send({ error: "trace not found in this workspace" });
    return trace;
  });

  // the replay: the run's decision path reconstructed turn-by-turn from the append-only log.
  app.get("/workspaces/:wid/traces/:runId/replay", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, runId } = req.params as { wid: string; runId: string };
    if (!(await requireMemoryCapability(id, wid, "read", reply))) return;
    const replay = await service.replay(wid, runId);
    if (!replay) return reply.code(404).send({ error: "trace not found in this workspace" });
    return replay;
  });

  // durable run log (issue #665): the run's persisted output lines, oldest-first, that survive a restart
  // (the runtime's in-memory buffer does not). ?afterSeq= tails incrementally; ?limit= bounds the page.
  // Returns 200 with an empty `lines` array for a run that has no persisted log yet (not a 404) — absence of
  // lines is a valid state, and the store is workspace-scoped so a foreign workspace simply sees nothing (#3).
  app.get("/workspaces/:wid/traces/:runId/logs", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, runId } = req.params as { wid: string; runId: string };
    if (!(await requireMemoryCapability(id, wid, "read", reply))) return;
    const q = req.query as { afterSeq?: string; limit?: string };
    const afterSeq = q.afterSeq ? Number.parseInt(q.afterSeq, 10) : undefined;
    const limit = q.limit ? Number.parseInt(q.limit, 10) : undefined;
    return logService.getLog(wid, runId, {
      afterSeq: Number.isFinite(afterSeq) ? afterSeq : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
  });

  // failing tool call (issue #666): the exact tool whose call sank the run — its name, redacted args, and
  // error — so a failed run names what broke instead of an opaque "failed". `failure` is null for a run that
  // never recorded a tool failure (e.g. a successful run).
  app.get("/workspaces/:wid/traces/:runId/failure", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, runId } = req.params as { wid: string; runId: string };
    if (!(await requireMemoryCapability(id, wid, "read", reply))) return;
    const failure = await logService.getFailure(wid, runId);
    return { runId, failure };
  });

  // LIVE THEATER (issue #624): stream ONE run's reasoning → action → artifact as it happens, over SSE.
  // On connect it replays the run so far (`event: run` header, then one `event: event` per trace event),
  // then — while the run is still open — polls for new events and pushes them live. A closed run streams
  // its full record and ends with `event: done` (so a finished run "replays" and a watcher's tab closes).
  app.get("/workspaces/:wid/traces/:runId/stream", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, runId } = req.params as { wid: string; runId: string };
    if (!(await requireMemoryCapability(id, wid, "read", reply))) return;
    const trace = await service.getTrace(wid, runId);
    if (!trace) return reply.code(404).send({ error: "trace not found in this workspace" });

    reply.hijack();
    writeSseHead(reply);
    await streamSingleRun(service, wid, runId, req, reply, activeStreams);
  });

  // LIVE FLEET THEATER (issue #624): one screen, the whole team. Streams recent + live events across the
  // workspace's most recent runs, each frame tagged with its `runId`, so a watcher sees every agent work
  // at once. New runs appear (`event: run`) and their events flow in as they happen.
  app.get("/workspaces/:wid/traces/stream", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!(await requireMemoryCapability(id, wid, "read", reply))) return;

    reply.hijack();
    writeSseHead(reply);
    streamFleet(service, wid, req, reply, activeStreams);
  });
}

/**
 * Drive a single-run SSE stream: emit the run header, replay existing events from the cursor, then either
 * end (closed run) or poll for new events until the run closes or the client disconnects. Resolves once
 * the response has ended (so a closed run is fully injectable in tests; an open run resolves on close).
 */
async function streamSingleRun(
  service: TraceService,
  wid: string,
  runId: string,
  req: FastifyRequest,
  reply: FastifyReply,
  activeStreams: Set<() => void>,
): Promise<void> {
  const res = reply.raw;
  let cursor = 0;
  let closedSent = false;

  const initial = await service.getTrace(wid, runId);
  if (initial) {
    res.write(sseFrame("run", initial.run));
    const { events, cursor: next } = selectNewEvents(initial.events, cursor);
    for (const e of events) res.write(sseFrame("event", toTheaterEvent(e)));
    cursor = next;
    if (initial.run.status === "closed") {
      res.write(sseFrame("done", { runId, eventCount: initial.run.eventCount }));
      res.end();
      closedSent = true;
    }
  } else {
    res.write(sseFrame("done", { runId, eventCount: 0 }));
    res.end();
    closedSent = true;
  }
  if (closedSent) return;

  await new Promise<void>((resolve) => {
    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      activeStreams.delete(stop);
      if (!res.writableEnded) res.end();
      resolve();
    };
    const tick = async (): Promise<void> => {
      try {
        const trace = await service.getTrace(wid, runId);
        if (!trace) return stop();
        const { events, cursor: next } = selectNewEvents(trace.events, cursor);
        for (const e of events) res.write(sseFrame("event", toTheaterEvent(e)));
        cursor = next;
        if (trace.run.status === "closed") {
          res.write(sseFrame("done", { runId, eventCount: trace.run.eventCount }));
          return stop();
        }
        res.write(sseComment());
      } catch {
        stop();
      }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    activeStreams.add(stop);
    req.raw.on("close", stop);
  });
}

/**
 * Drive the fleet SSE stream: each tick, list the workspace's most recent runs, announce any newly-seen
 * run, and push its new events (replaying only a bounded trailing window the first time a run is seen, so
 * a long history never floods the watcher). Runs until the client disconnects.
 */
function streamFleet(
  service: TraceService,
  wid: string,
  req: FastifyRequest,
  reply: FastifyReply,
  activeStreams: Set<() => void>,
): void {
  const res = reply.raw;
  const cursors = new Map<string, number>();
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    activeStreams.delete(stop);
    if (!res.writableEnded) res.end();
  };
  const tick = async (): Promise<void> => {
    try {
      const runs = await service.listRuns(wid, { limit: FLEET_RUN_LIMIT });
      for (const run of runs) {
        const trace = await service.getTrace(wid, run.id);
        if (!trace) continue;
        let cursor = cursors.get(run.id);
        if (cursor === undefined) {
          // First sight of this run: announce it and start near the tail, not at the dawn of history.
          res.write(sseFrame("run", run));
          const maxSeq = trace.events.reduce((m, e) => Math.max(m, e.seq), 0);
          cursor = Math.max(0, maxSeq - FLEET_TAIL);
        }
        const { events, cursor: next } = selectNewEvents(trace.events, cursor);
        for (const e of events) res.write(sseFrame("event", toTheaterEvent(e)));
        cursors.set(run.id, next);
      }
      res.write(sseComment());
    } catch {
      stop();
    }
  };
  const timer = setInterval(() => void tick(), POLL_MS);
  activeStreams.add(stop);
  req.raw.on("close", stop);
  void tick();
}
