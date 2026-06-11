import { describe, it, expect, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces, failureFingerprints, flywheelFixDispatches } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import {
  flywheelFingerprintStore,
  flywheelDispatchStore,
  listActiveWorkspaces,
} from "../../src/db/repositories/flywheel.js";
import {
  FlywheelEngine,
  type FixApprovalQueue,
  type FixLauncher,
  type IssueFiler,
} from "../../src/flywheel/engine.js";
import { FLYWHEEL_DEFAULTS, type FlywheelCaps } from "../../src/flywheel/caps.js";
import { makeRedactor } from "../../src/runtime/redact.js";
import type { FailureClass } from "../../src/flywheel/types.js";
import type { SessionLogger } from "../../src/runtime/manager.js";

const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

const app: FastifyInstance = buildApp();
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

interface World {
  workspaceId: string;
  channelId: string;
  agentMemberId: string;
}

/** Sign up a human in a fresh workspace, make a channel, register an agent (the fix-launch target). */
async function seed(): Promise<World> {
  const slug = `fw-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "U", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  const channel = await app.inject({
    method: "POST",
    url: `/workspaces/${me.workspaceId}/channels`,
    cookies: { rid: cookie },
    payload: { name: "agents" },
  });
  const agent = await app.inject({
    method: "POST",
    url: `/workspaces/${me.workspaceId}/agents`,
    cookies: { rid: cookie },
    payload: { name: "Fixer" },
  });
  return {
    workspaceId: me.workspaceId,
    channelId: channel.json().id,
    agentMemberId: agent.json().memberId,
  };
}

/** A fake GitHub filer recording create/comment/reopen, returning incrementing refs (no network). */
function fakeFiler() {
  const creates: Array<{ title: string; body: string }> = [];
  const comments: Array<{ ref: string; body: string }> = [];
  const reopens: string[] = [];
  let seq = 0;
  const filer: IssueFiler = {
    create: async ({ title, body }) => {
      seq += 1;
      creates.push({ title, body });
      return { ref: `github:acme/web#${seq}`, state: "open" };
    },
    comment: async ({ ref, body }) => {
      comments.push({ ref, body });
    },
    reopen: async ({ ref }) => {
      reopens.push(ref);
      return { state: "open" };
    },
  };
  return { filer, creates, comments, reopens };
}

/** A fake launcher recording fix-session launches and returning a synthetic id (no real process). */
function fakeLauncher() {
  const calls: Array<{ workspaceId: string; task: string }> = [];
  const launcher: FixLauncher = {
    launch: async ({ workspaceId, task }) => {
      calls.push({ workspaceId, task });
      return { id: newId() };
    },
  };
  return { launcher, calls };
}

/** A fake approval queue recording enqueues (the human path) and returning a synthetic id. */
function fakeApprovalQueue() {
  const calls: Array<{ workspaceId: string; reason: string }> = [];
  const queue: FixApprovalQueue = {
    enqueue: async ({ workspaceId, reason }) => {
      calls.push({ workspaceId, reason });
      return { id: newId() };
    },
  };
  return { queue, calls };
}

const SECRET = "s3cr3t-flywheel-token-value-xyz";

describe("self-healing flywheel (real Postgres): failure → fingerprint → issue → fix → closure", () => {
  it(
    "fingerprints+dedups+redacts, drafts ONE issue, auto-dispatches a fix, gates on the kill switch, " +
      "and reopens+queues (escalated) on recurrence after fix",
    async () => {
      const w = await seed();
      const wDisabled = await seed(); // flywheel disabled here — must stay untouched (isolation)

      const filer = fakeFiler();
      const launcher = fakeLauncher();
      const approvals = fakeApprovalQueue();
      const enabled = new Set([w.workspaceId]);
      const autoAllowed = new Set<FailureClass>(["harness_crash"]);
      const killSwitchOn = new Set<string>();

      const caps: FlywheelCaps = { ...FLYWHEEL_DEFAULTS, enabled: true };
      const engine = new FlywheelEngine({
        fingerprints: flywheelFingerprintStore,
        dispatches: flywheelDispatchStore,
        filer: filer.filer,
        launcher: launcher.launcher,
        approvalQueue: approvals.queue,
        caps: (workspaceId) =>
          enabled.has(workspaceId) ? caps : { ...FLYWHEEL_DEFAULTS, enabled: false },
        killSwitch: async (workspaceId) => killSwitchOn.has(workspaceId),
        budgetExhausted: async () => false,
        autoDispatchAllowed: async (_wid, cls) => autoAllowed.has(cls),
        redact: (text, secrets) => makeRedactor(secrets)(text),
        activeWorkspaces: listActiveWorkspaces,
        logger: silentLogger,
        now: () => new Date(),
      });

      // The failure message embeds a secret value (must never reach the persisted bundle / issue body).
      const failure = {
        workspaceId: w.workspaceId,
        failureClass: "harness_crash" as const,
        message: `harness crashed: auth rejected token ${SECRET} for session 3f2504e0-4f89-41d3-9a0c-0305e82c3301`,
        detail: "Error: 401 Unauthorized",
        traceId: "trace-abc",
        channelId: w.channelId,
        agentMemberId: w.agentMemberId,
        secrets: { TOKEN: SECRET },
      };

      // (1) record once → one fingerprint, redacted sample bundle (the safety invariant).
      const first = await engine.record(failure);
      expect(first.occurrenceCount).toBe(1);
      expect(first.sampleContext).not.toContain(SECRET);
      expect(first.sampleContext).toContain("‹redacted›");

      // (2) record the SAME failure again (different volatile uuid) → dedup: one row, count 2.
      await engine.record({
        ...failure,
        message: `harness crashed: auth rejected token ${SECRET} for session 7c9e6679-7425-40de-944b-e07fc1f90ae7`,
      });
      const rows = await db
        .select()
        .from(failureFingerprints)
        .where(eq(failureFingerprints.workspaceId, w.workspaceId));
      expect(rows).toHaveLength(1);
      expect(rows[0].occurrenceCount).toBe(2);
      const fpId = rows[0].id;

      // disabled workspace also gets a failure — it must never be issued/dispatched.
      await engine.record({ ...failure, workspaceId: wDisabled.workspaceId });

      // (3) kill switch engaged → the tick is skipped (no GitHub, no launch).
      killSwitchOn.add(w.workspaceId);
      const skipped = await engine.tickWorkspace(w.workspaceId, new Date());
      expect(skipped.skipped).toBe("kill_switch");
      expect(filer.creates).toHaveLength(0);
      expect(launcher.calls).toHaveLength(0);
      killSwitchOn.delete(w.workspaceId);

      // (4) a real tick → ONE issue drafted, fix AUTO-dispatched (class is #95-allowed), fingerprint linked.
      await engine.tickWorkspace(w.workspaceId, new Date());
      expect(filer.creates).toHaveLength(1);
      expect(filer.creates[0].body).not.toContain(SECRET); // redaction reaches the issue body
      expect(launcher.calls).toHaveLength(1);
      const afterDispatch = await flywheelFingerprintStore.get(w.workspaceId, fpId);
      expect(afterDispatch?.status).toBe("fixing");
      expect(afterDispatch?.issueRef).toBe("github:acme/web#1");
      expect(afterDispatch?.fixSessionId).toBeTruthy();
      const autoDispatches = await db
        .select()
        .from(flywheelFixDispatches)
        .where(
          and(
            eq(flywheelFixDispatches.workspaceId, w.workspaceId),
            eq(flywheelFixDispatches.mode, "auto"),
          ),
        );
      expect(autoDispatches).toHaveLength(1);

      // isolation: the disabled workspace was never touched.
      const disabledTick = await engine.tickWorkspace(wDisabled.workspaceId, new Date());
      expect(disabledTick.skipped).toBe("disabled");
      const disabledRow = await db
        .select()
        .from(failureFingerprints)
        .where(eq(failureFingerprints.workspaceId, wDisabled.workspaceId));
      expect(disabledRow[0].issueRef).toBeNull();

      // (5) loop closure: a merged fix links the fingerprint (status fixed).
      const fixed = await engine.markFixed(w.workspaceId, fpId, "merged:acme/web#9");
      expect(fixed?.status).toBe("fixed");

      // (6) the SAME failure recurs AFTER the fix (same shape, new volatile uuid → same signature) →
      // recurred + excluded + escalated (#106 verifier).
      const recurred = await engine.record({
        ...failure,
        message: `harness crashed: auth rejected token ${SECRET} for session 99999999-9999-4999-8999-999999999999`,
      });
      expect(recurred.status).toBe("recurred");
      expect(recurred.excludedFromAutoDispatch).toBe(true);
      expect(recurred.escalated).toBe(true);

      // (7) next tick → issue REOPENED and the fix QUEUED for a human (NOT auto, despite class allowed).
      await engine.tickWorkspace(w.workspaceId, new Date());
      expect(filer.reopens).toContain("github:acme/web#1");
      expect(approvals.calls).toHaveLength(1);
      expect(approvals.calls[0].reason).toBe("recurred_after_fix");
      expect(launcher.calls).toHaveLength(1); // still just the one auto-launch from step (4)
      const queued = await db
        .select()
        .from(flywheelFixDispatches)
        .where(
          and(
            eq(flywheelFixDispatches.workspaceId, w.workspaceId),
            eq(flywheelFixDispatches.mode, "queued"),
          ),
        );
      expect(queued).toHaveLength(1);
    },
  );
});
