/**
 * Campaign brief service (#588) — the single source of truth every marketing agent reads at task start.
 *
 * Three operations:
 *   - {@link CampaignBriefService.get}     — read the current brief record (for the read endpoint / a UI).
 *   - {@link CampaignBriefService.update}  — apply an owner edit; sanitizes the patch, bumps the revision.
 *   - {@link CampaignBriefService.briefingForTask} — the AGENT seam: render the live brief into the briefing
 *     block an agent injects at task start, with the citation it echoes into its plan.
 *
 * "Changes propagate to in-flight planning" falls out of the single-source read: an agent calls
 * `briefingForTask` at the start of each task/planning step, so an edit landed by the owner is reflected on
 * the very next task an in-flight planner starts — no cache, no copy, no stale snapshot.
 *
 * Pure where it can be: all validation/sanitization lives in `brief.ts`; this class is the thin lifecycle
 * over an injected {@link BriefStore} + an injected clock (deterministic tests). It performs no send/spend
 * and grants no tools — editing a brief can never widen an agent's scope (#200, #13).
 */

import {
  normalizeBrief,
  renderBriefing,
  briefCitation,
  isBriefEmpty,
  type CampaignBrief,
  type CampaignBriefPatch,
} from "./brief.js";
import { type BriefRecord, type BriefStore } from "./store.js";

export interface CampaignBriefServiceDeps {
  store: BriefStore;
  /** Injectable clock so tests are deterministic. Defaults to wall-clock. */
  now?: () => Date;
}

/** The briefing an agent injects at task start: the live revision, the rendered DATA block, the citation. */
export interface TaskBriefing {
  /** The revision the briefing was rendered from — the version a plan built against this read cites. */
  revision: number;
  /**
   * The DATA-framed brief block to prepend to the task, or `null` when no brief is set yet (the caller then
   * leaves the task untouched — the fleet is unchanged until the owner writes a brief).
   */
  preamble: string | null;
  /** The one-line citation the agent echoes into its plan, or `null` when there is no brief to cite. */
  citation: string | null;
}

export class CampaignBriefService {
  private readonly store: BriefStore;
  private readonly now: () => Date;

  constructor(deps: CampaignBriefServiceDeps) {
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date());
  }

  /** Read the current brief record for a workspace (revision 0 / blank if never edited). */
  async get(workspaceId: string): Promise<BriefRecord> {
    return this.store.get(workspaceId);
  }

  /**
   * Apply an owner edit. The patch is sanitized + bounded (`normalizeBrief`), the revision is bumped, and
   * the editor + timestamp are recorded. Returns the saved record. A patch that changes nothing still bumps
   * the revision — an explicit "I reviewed the brief" event the audit can see; callers that want to suppress
   * a no-op edit can compare the returned brief to the prior one.
   */
  async update(
    workspaceId: string,
    patch: CampaignBriefPatch,
    editedByMemberId: string,
  ): Promise<BriefRecord> {
    const current = await this.store.get(workspaceId);
    const next = normalizeBrief(current.brief, patch);
    return this.store.save({
      workspaceId,
      brief: next,
      revision: current.revision + 1,
      updatedByMemberId: editedByMemberId,
      updatedAt: this.now(),
    });
  }

  /**
   * The AGENT seam: read the LIVE brief and render the briefing an agent injects at task start. Because this
   * reads the store each call, an owner edit between two of an agent's tasks shows up on the next one — the
   * propagation guarantee. Returns a null preamble/citation for an un-set brief so the task is untouched.
   */
  async briefingForTask(workspaceId: string): Promise<TaskBriefing> {
    const record = await this.store.get(workspaceId);
    const empty = isBriefEmpty(record.brief);
    return {
      revision: record.revision,
      preamble: renderBriefing(record.brief, record.revision),
      citation: empty ? null : briefCitation(record.revision),
    };
  }

  /**
   * Convenience for the launch seam (mirrors `enrichTaskWithContext`): prepend the live briefing to a task,
   * or return it unchanged when no brief is set. The task is kept verbatim below a `Task:` label so the
   * agent can always tell its instruction from the brief DATA.
   */
  async enrichTask(workspaceId: string, task: string): Promise<{ task: string; revision: number }> {
    const { preamble, revision } = await this.briefingForTask(workspaceId);
    if (!preamble) return { task, revision };
    return { task: `${preamble}\n\nTask: ${task}`, revision };
  }
}

export type { CampaignBrief, CampaignBriefPatch };
