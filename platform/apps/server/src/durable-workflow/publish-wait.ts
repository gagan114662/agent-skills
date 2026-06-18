import { DurableRunner } from "./runner.js";
import {
  backoffPolicyFromCaps,
  isDurableWorkflowEnabledForWorkspace,
  type DurableWorkflowCaps,
} from "./caps.js";
import type { DurableRunStore } from "./store.js";
import type { StepOutcome } from "./types.js";

/**
 * The durable build-wait seam (#338) — the narrow port surface the GitHub Pages publish provider depends
 * on, so it never imports the engine directly (and a unit test can inject a fake). `enabledFor` is the
 * owner-first flag check; `run` drives the build-status poll through the durable engine — suspending +
 * backing off between attempts and persisting the run, instead of the provider's old 120s in-process
 * `while (Date.now() < deadline) { …; await sleep }` blocking poll.
 */
export interface PublishBuildWaitArgs {
  workspaceId: string;
  /** Idempotency anchor for the run (e.g. `owner/repo`) — a re-publish RESUMES the wait, never forks it. */
  key: string;
  /** ONE poll: resolve to the live URL when the build is ready, or null while still building. */
  poll: () => Promise<string | null>;
  /** The deterministic fallback URL if the wait exhausts its budget (the page is committed regardless). */
  fallbackUrl: string;
  onLog: (line: string) => void;
}

export interface PublishBuildWait {
  /** Owner-first flag gate: route this workspace through the durable engine? */
  enabledFor(workspaceId: string): boolean;
  /** Drive the poll to a live URL (or the deterministic fallback) via the durable engine. */
  run(args: PublishBuildWaitArgs): Promise<string>;
}

export interface CreatePublishBuildWaitDeps {
  store: DurableRunStore;
  caps: DurableWorkflowCaps;
  /** Injected clock/sleep for deterministic tests; defaults to real time inside the runner. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Build the durable {@link PublishBuildWait} backing the GitHub Pages publish provider. The poll closure
 * returns a {@link StepOutcome}: `done` (built — the live URL) or `pending` (still building → suspend +
 * backoff). On a non-success terminal status (timeout/exhausted) the wait falls back to the deterministic
 * `https://<owner>.github.io/<repo>/` URL — same fallback the legacy loop used — so the publish never
 * hangs and never lies (the URL is real because the page bytes were already committed upstream).
 */
export function createPublishBuildWait(deps: CreatePublishBuildWaitDeps): PublishBuildWait {
  const runner = new DurableRunner({ store: deps.store, now: deps.now, sleep: deps.sleep });
  const policy = backoffPolicyFromCaps(deps.caps);

  return {
    enabledFor(workspaceId: string): boolean {
      return isDurableWorkflowEnabledForWorkspace(deps.caps, workspaceId);
    },

    async run(args: PublishBuildWaitArgs): Promise<string> {
      const handler = {
        async step(): Promise<StepOutcome<string>> {
          const url = await args.poll();
          return url ? { type: "done", result: url } : { type: "pending" };
        },
      };
      const record = await runner.runToCompletion<Record<string, never>, string>(
        {
          workspaceId: args.workspaceId,
          workflowKey: "github_pages_build_wait",
          idempotencyKey: `github_pages:${args.key}`,
          timeoutMs: deps.caps.defaultTimeoutMs,
          initialState: {},
        },
        handler,
        policy,
      );
      if (record.status === "succeeded" && typeof record.result === "string") {
        return record.result;
      }
      args.onLog(
        `  [github_pages] durable build wait ended ${record.status} — using deterministic Pages URL`,
      );
      return args.fallbackUrl;
    },
  };
}
