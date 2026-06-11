/**
 * Production wiring for the reliability surface (#148, ADR-0148). Builds the {@link PagerService} and
 * the {@link IncidentCoordinator} (which IS the SRE `SreNotifier`) over real repos. To avoid a circular
 * import with `sre/default.ts`, the SRE-specific seams it cannot own — the fallback notifier, the
 * ops-channel poster, and the channel-post function — are passed IN by the caller (`sre/default.ts`).
 *
 * Everything stays default-OFF: the coordinator delegates to `fallback` when `reliability.enabled` is
 * false, and the pager defaults to the structured-log transport (no SMTP ⇒ sends nowhere).
 */
import { loadConfig } from "../config/loader.js";
import type { SessionLogger } from "../runtime/manager.js";
import type { SreNotifier } from "../sre/engine.js";
import { resolveReliabilityCaps } from "./caps.js";
import { IncidentCoordinator } from "./coordinator.js";
import { PagerService, type PageSource } from "./pager/service.js";
import { selectPagerTransport } from "./pager/transport.js";
import {
  ensureOverlay,
  setOverlayChannel,
  setInvestigationNote,
  recordOverlayPaged,
  countPagesSince,
  recordPage,
  getWorkspaceOwnerContact,
} from "../db/repositories/reliability.js";
import { createChannel } from "../db/repositories/channels.js";
import { listRecentDeploysForWorkspace } from "../db/repositories/deployments.js";
import { flywheelFingerprintStore } from "../db/repositories/flywheel.js";
import {
  collectSaturation,
  classifySaturation,
  DEFAULT_SATURATION_THRESHOLDS,
} from "../observability/saturation.js";
import { getPool } from "../db/index.js";
import { getRedis } from "../redis/index.js";
import type { SaturationSignal } from "./investigation/correlate.js";

/** Build the shared {@link PagerService} (used by the coordinator AND the uptime monitor). */
export function createPagerService(logger: SessionLogger): PagerService {
  return new PagerService({
    ownerContact: getWorkspaceOwnerContact,
    caps: (workspaceId) => resolveReliabilityCaps(loadConfig(workspaceId).reliability),
    recentPageCount: countPagesSince,
    recordPage,
    // Email-first, but the default transport is a no-op log: no SMTP client is wired (the seam is the
    // plug), and #58 data-privacy mode would force the log transport anyway.
    transport: selectPagerTransport({ logger }),
  });
}

/** Best-effort live saturation sample → the investigation's saturation signal (null on any error). */
async function gatherSaturation(): Promise<SaturationSignal | null> {
  try {
    const sample = await collectSaturation({
      // queue depth needs the #71 admission snapshot (not in scope here); pg-pool / redis / event-loop
      // pressure is what matters for an api/db/redis incident and is read directly.
      queueDepth: () => 0,
      pgPoolStats: () => {
        const p = getPool();
        return { total: p.totalCount, idle: p.idleCount, waiting: p.waitingCount };
      },
      redisPing: async () => {
        try {
          const redis = getRedis();
          if (redis.status !== "ready") await redis.connect().catch(() => undefined);
          return (await redis.ping()) === "PONG" ? 0 : null;
        } catch {
          return null;
        }
      },
    });
    const status = classifySaturation(sample, DEFAULT_SATURATION_THRESHOLDS);
    return { status: status.level, resource: status.reasons[0] };
  } catch {
    return null;
  }
}

export interface ReliabilityNotifierDeps {
  /** Today's #112 notifier — the coordinator delegates to it when reliability is off. */
  fallback: SreNotifier;
  /** Resolve the agent member to post the war-room timeline as (null ⇒ skip the chat surface). */
  poster(workspaceId: string): Promise<{ agentMemberId: string } | null>;
  /** Post a system message into a channel (wraps the runtime `channelPoster.post`). */
  channelPost(input: {
    workspaceId: string;
    channelId: string;
    agentMemberId: string;
    body: string;
  }): Promise<void>;
  logger: SessionLogger;
  /** Optional shared pager (the uptime CLI builds its own); defaults to a fresh one. */
  pager?: PagerService;
}

/**
 * Build the reliability `SreNotifier`. This is what `sre/default.ts` injects as the engine's notifier:
 * for an opted-in workspace it runs the incident.io-class surface; otherwise it delegates to `fallback`.
 */
export function createReliabilityNotifier(deps: ReliabilityNotifierDeps): IncidentCoordinator {
  const pagerService = deps.pager ?? createPagerService(deps.logger);
  return new IncidentCoordinator({
    caps: (workspaceId) => resolveReliabilityCaps(loadConfig(workspaceId).reliability),
    fallback: deps.fallback,
    overlay: {
      ensure: ensureOverlay,
      setChannel: setOverlayChannel,
      setNote: setInvestigationNote,
      recordPaged: recordOverlayPaged,
    },
    channels: {
      create: (workspaceId, name) =>
        createChannel({ workspaceId, kind: "public", name }).then((c) => ({ id: c.id })),
      post: deps.channelPost,
      poster: deps.poster,
    },
    investigation: {
      gather: async (workspaceId) => ({
        recentDeploys: (await listRecentDeploysForWorkspace(workspaceId)).map((d) => ({
          id: d.id,
          target: d.provider ?? d.framework ?? "deploy",
          status: d.status,
          at: d.createdAt,
        })),
        fingerprints: (await flywheelFingerprintStore.listForConsole(workspaceId)).map((f) => ({
          signature: f.signature,
          failureClass: f.failureClass,
          occurrenceCount: f.occurrenceCount,
          status: f.status,
        })),
        saturation: await gatherSaturation(),
      }),
    },
    pager: {
      page: (input) => pagerService.page({ ...input, source: "sre" as PageSource }),
    },
    logger: deps.logger,
  });
}
