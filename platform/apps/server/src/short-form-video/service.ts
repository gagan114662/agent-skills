/**
 * Short-form video generation agent service (#740) — the thin lifecycle that ties the pure script builder,
 * the render seam, and the store together. It performs the work the issue describes: read the live campaign
 * brief, script a brief-grounded short-form video, render it through the provider, and persist the result.
 *
 * Four outcomes, each a terminal {@link VideoJobStatus}:
 *   - `disabled`      — the master switch is OFF (the default). Nothing is generated, NOTHING is persisted,
 *                       the provider is never touched. A deployment that sets no env keeps today's behaviour.
 *   - `missing_brief` — the brief carries no usable positioning/voice/claims, so the agent refuses to invent
 *                       them (#588 / #200 FM#2). The provider is never called.
 *   - `script_only`   — the script was built but the provider failed; the script is kept so the agent's work
 *                       is not lost (graceful fallback). The error reason is recorded.
 *   - `rendered`      — a video asset was produced.
 *
 * Pure where it can be: all scripting/sanitization lives in `script.ts`; this class is the lifecycle over an
 * injected {@link VideoJobStore}, {@link VideoProvider}, config, clock, and id factory (deterministic tests).
 * It grants no tools and performs no send/spend — producing a draft video never widens an agent's scope; any
 * outbound publish stays behind the existing approval gate (#13).
 */

import type { ShortFormVideoConfig } from "./config.js";
import { buildScript, isBriefMissing } from "./script.js";
import { FakeVideoProvider, type VideoProvider } from "./provider.js";
import { InMemoryVideoJobStore, type VideoJobStore } from "./store.js";
import type {
  RenderedVideo,
  VideoGenerationResult,
  VideoJobRecord,
  VideoJobStatus,
  VideoRequest,
  VideoScript,
} from "./types.js";

export interface ShortFormVideoServiceDeps {
  config: ShortFormVideoConfig;
  /** The render seam. Defaults to the deterministic offline {@link FakeVideoProvider}. */
  provider?: VideoProvider;
  /** Persistence seam. Defaults to an {@link InMemoryVideoJobStore} (production injects the Postgres store). */
  store?: VideoJobStore;
  /** Injectable clock so tests are deterministic. Defaults to wall-clock. */
  now?: () => Date;
  /** Injectable id factory so tests are deterministic. Defaults to a time+counter id. */
  newId?: () => string;
}

export class ShortFormVideoService {
  private readonly config: ShortFormVideoConfig;
  private readonly provider: VideoProvider;
  private readonly store: VideoJobStore;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private seq = 0;

  constructor(deps: ShortFormVideoServiceDeps) {
    this.config = deps.config;
    this.provider = deps.provider ?? new FakeVideoProvider();
    this.store = deps.store ?? new InMemoryVideoJobStore();
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => `sfv_${this.now().getTime().toString(36)}_${(this.seq++).toString(36)}`);
  }

  /**
   * Generate one short-form video for a request. See the class doc for the four outcomes. Only the
   * `script_only` and `rendered` paths call the provider; `disabled` short-circuits before any persistence.
   */
  async generate(request: VideoRequest): Promise<VideoGenerationResult> {
    // Master switch OFF (the default): do nothing, persist nothing, never touch the provider.
    if (!this.config.enabled) {
      return {
        status: "disabled",
        job: null,
        script: null,
        video: null,
        reason: "short-form video generation is disabled (set SHORTFORM_VIDEO_ENABLED=1)",
      };
    }

    // No usable brief: the agent refuses to invent positioning/claims. Record the refusal, skip the provider.
    if (isBriefMissing(request.brief)) {
      const job = await this.persist(request, "missing_brief", null, null, "no usable campaign brief");
      return { status: "missing_brief", job, script: null, video: null, reason: job.error };
    }

    // Build the deterministic, brief-grounded script (pure — no IO).
    const script = buildScript(request, this.config);

    // Render through the provider; on failure keep the script (graceful fallback) rather than losing the work.
    let video: RenderedVideo | null = null;
    let status: VideoJobStatus = "rendered";
    let error: string | null = null;
    try {
      video = await this.provider.render({ workspaceId: request.workspaceId, topic: request.topic, script });
    } catch (err) {
      status = "script_only";
      error = `provider ${this.provider.id} failed: ${errorMessage(err)}`;
    }

    const job = await this.persist(request, status, script, video, error);
    return { status, job, script, video, reason: error };
  }

  /** Read one persisted job, workspace-scoped (the #3 IDOR boundary). */
  async get(workspaceId: string, id: string): Promise<VideoJobRecord | null> {
    return this.store.get(workspaceId, id);
  }

  /** List a workspace's recent jobs, newest first. */
  async list(workspaceId: string, limit?: number): Promise<VideoJobRecord[]> {
    return this.store.listByWorkspace(workspaceId, limit);
  }

  private async persist(
    request: VideoRequest,
    status: VideoJobStatus,
    script: VideoScript | null,
    video: RenderedVideo | null,
    error: string | null,
  ): Promise<VideoJobRecord> {
    return this.store.save({
      id: this.newId(),
      workspaceId: request.workspaceId,
      requestedByMemberId: request.requestedByMemberId,
      topic: request.topic,
      status,
      script,
      video,
      error,
      createdAt: this.now(),
    });
  }
}

/** Extract a short, safe message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
