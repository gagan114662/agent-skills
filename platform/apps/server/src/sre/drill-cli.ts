/**
 * Game-day chaos drill CLI (#112, ADR-0112) — `pnpm --filter @reload/server sre:drill`.
 *
 * The scheduled CI drill runs this against a throwaway Postgres service container: seed an isolated
 * workspace, inject a Redis-down / PG-down / api-erroring signal, run one SRE tick, and assert the
 * on-call path fired — an incident opened and a triage launch was attempted. **Fails loudly** (exit 1)
 * if the alert pipeline is broken, so a regression is caught on a schedule, not during a real outage.
 *
 * It uses a COUNTING fake triage launcher (no real agent is spawned in CI) and real durable repos, so
 * the `sre_incidents` rows it opens are genuine. It cleans up its throwaway workspace afterwards.
 */
import { eq } from "drizzle-orm";
import { db, closeDb } from "../db/index.js";
import { closeRedis } from "../redis/index.js";
import { workspaces } from "../db/schema/index.js";
import { newId } from "../db/id.js";
import { createWorkspace } from "../db/repositories/workspaces.js";
import { sreIncidentStore } from "../db/repositories/sre.js";
import { SreEngine } from "./engine.js";
import { SRE_DEFAULTS } from "./caps.js";
import { chaosSignals, runChaosDrill } from "./drill.js";
import type { SessionLogger } from "../runtime/manager.js";

const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

async function main(): Promise<void> {
  const now = new Date();
  const slug = `sre-drill-${newId()}`;
  const ws = await createWorkspace({ slug, name: "SRE drill" });

  let launches = 0;
  const engine = new SreEngine({
    readSignals: async () => new Map(),
    listWorkspaceIds: async () => [ws.id],
    // Enable the loop for the throwaway workspace with chaos-relevant SLO targets.
    caps: () => ({
      ...SRE_DEFAULTS,
      enabled: true,
      services: [
        { service: "api", targets: [{ kind: "availability", target: 0.99 }, { kind: "latency_p95", target: 500 }] },
        { service: "redis", targets: [{ kind: "availability", target: 1 }] },
        { service: "db", targets: [{ kind: "availability", target: 1 }] },
      ],
    }),
    killSwitch: async () => false,
    incidents: sreIncidentStore, // real durable rows in the throwaway DB
    // Counting fake launcher — the drill proves triage WOULD launch without spending on a real agent.
    triage: {
      launch: async () => {
        launches += 1;
        return { id: `drill-triage-${newId()}` };
      },
    },
    triageTarget: {
      resolve: async () => ({ channelId: newId(), agentMemberId: newId(), createdByMemberId: newId() }),
    },
    bundle: { context: async () => ({ recentDeploys: [], traceHints: [], runbookLinks: [] }) },
    escalator: { escalate: async () => ({ id: newId() }) },
    notifier: { notify: async () => {} },
    postmortems: { write: async () => {} },
    logger: silentLogger,
    now: () => now,
  });

  try {
    const result = await runChaosDrill({
      engine,
      workspaceId: ws.id,
      signals: chaosSignals(),
      now,
      launchCount: () => launches,
    });

    for (const d of result.details) console.log(`  • ${d}`);

    if (result.ok) {
      console.log(
        `✓ sre:drill — alert fired (${result.incidentsOpened} incident(s) opened, ` +
          `${result.triageLaunches} triage launch(es))`,
      );
      process.exitCode = 0;
    } else {
      console.error(
        `✗ sre:drill — ON-CALL PATH BROKEN (incidents=${result.incidentsOpened}, ` +
          `triage=${result.triageLaunches}) — chaos induced no incident/triage`,
      );
      process.exitCode = 1;
    }
  } finally {
    // Clean up the throwaway workspace (cascades to its sre_incidents rows).
    await db.delete(workspaces).where(eq(workspaces.id, ws.id));
  }
}

main()
  .catch((err) => {
    console.error("✗ sre:drill — unexpected failure:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => {
    void Promise.allSettled([closeDb(), closeRedis()]);
  });
