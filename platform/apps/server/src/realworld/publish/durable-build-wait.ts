import { loadConfig } from "../../config/loader.js";
import { dbDurableRunStore } from "../../db/repositories/durable-runs.js";
import { resolveDurableWorkflowCaps } from "../../durable-workflow/caps.js";
import { createPublishBuildWait, type PublishBuildWait } from "../../durable-workflow/publish-wait.js";

/**
 * The production durable build-wait (#338) for the GitHub Pages publish provider: the Postgres-backed run
 * store + owner-first caps resolved from the base config layer (the durable flag is a deployment marker,
 * workspace-agnostic; the per-workspace gate is `enabledFor(input.workspaceId)` at publish time). Default
 * OFF ⇒ `enabledFor` returns false ⇒ the provider's legacy in-process poll runs unchanged.
 */
export function defaultPublishBuildWait(): PublishBuildWait {
  const caps = resolveDurableWorkflowCaps(loadConfig().durableWorkflow);
  return createPublishBuildWait({ store: dbDurableRunStore, caps });
}
