/**
 * Domain types for the short-form video generation agent (#740).
 *
 * The agent reads the workspace's campaign brief (the #588 single source of truth — ICP, positioning, voice,
 * approved brand claims) and turns a topic into a ready-to-shoot short-form video: a scripted, scene-by-scene
 * storyboard plus a rendered video asset. This file is the shared vocabulary; the pure builder lives in
 * `script.ts`, the render seam in `provider.ts`, persistence in `store.ts`, and orchestration in `service.ts`.
 *
 * The {@link VideoBrief} is intentionally a small, self-contained shape rather than an import of the #588
 * `CampaignBrief`: the caller (the marketing launch seam) reads the live brief and adapts it into this input,
 * so this module never takes a compile-time dependency on the campaign-brief module and stays parallel-merge
 * safe. Everything here is OWNER-authored DATA (#200 FM#6); `script.ts` sanitizes it before it reaches a
 * prompt, and only the brief's approved claims may appear in narration.
 */

/**
 * The slice of the campaign brief the video agent needs. Fed from the live #588 brief by the caller. A brief
 * with no usable content (see {@link import("./script.js").isBriefMissing}) makes generation a no-op — the
 * agent refuses to invent positioning or claims.
 */
export interface VideoBrief {
  /** Who the video is for — the ideal customer profile (from the brief's `icp`). */
  audience: string;
  /** One-line positioning: what we are and why it matters (from the brief's `positioning`). */
  positioning: string;
  /** Brand voice direction applied to the narration (from the brief's `voice`). */
  voice: string;
  /** The APPROVED claims the narration may make — the allowlist that stops the agent inventing metrics. */
  brandClaims: string[];
}

/** A request to generate one short-form video. */
export interface VideoRequest {
  /** The tenant this video belongs to (the IDOR boundary — every record is workspace-scoped). */
  workspaceId: string;
  /** What the video is about — a short topic line the agent builds the hook + scenes around. */
  topic: string;
  /** The live campaign brief slice the agent grounds the script in. */
  brief: VideoBrief;
  /** A short call-to-action for the closing scene (optional; a sensible default is used when absent). */
  callToAction?: string;
  /** The member who asked for the video (for the audit trail). */
  requestedByMemberId: string;
}

/** A single scene in the storyboard. */
export interface VideoScene {
  /** 1-based scene index. */
  index: number;
  /** The spoken / voiceover line for this scene. */
  narration: string;
  /** The on-screen text overlay (kept short — it has to fit a vertical frame). */
  onScreenText: string;
  /** A direction for the visual (b-roll, talking head, screen capture …). */
  visualCue: string;
  /** How long this scene runs, in seconds. The scene durations sum to the script's total. */
  durationSeconds: number;
}

/** The deterministic, brief-grounded script + storyboard the agent produces before any render. */
export interface VideoScript {
  /** The opening hook line — the first ~2 seconds that decide whether the viewer keeps watching. */
  hook: string;
  /** The ordered storyboard. */
  scenes: VideoScene[];
  /** The closing call-to-action line. */
  callToAction: string;
  /** A ready-to-post caption for the video. */
  caption: string;
  /** Suggested hashtags derived from the topic + audience. */
  hashtags: string[];
  /** The target aspect ratio (carried from config so the render spec is self-describing). */
  aspectRatio: string;
  /** Total video duration in seconds (sum of the scene durations). */
  totalDurationSeconds: number;
}

/** The spec handed to a {@link import("./provider.js").VideoProvider} to render an actual asset. */
export interface RenderSpec {
  workspaceId: string;
  topic: string;
  script: VideoScript;
}

/** A rendered video asset, returned by a provider. With the fake provider this is deterministic + offline. */
export interface RenderedVideo {
  /** The provider's asset id. */
  assetId: string;
  /** A URL/URI where the rendered video can be fetched. */
  url: string;
  /** A poster/thumbnail URL for the video. */
  thumbnailUrl: string;
  /** The container/format of the rendered file (e.g. `mp4`). */
  format: string;
  /** The rendered duration in seconds. */
  durationSeconds: number;
  /** The id of the provider that produced this asset (e.g. `fake`). */
  provider: string;
}

/** The terminal status of a generation attempt. */
export type VideoJobStatus =
  /** The feature is OFF — nothing was generated, nothing was persisted. */
  | "disabled"
  /** No usable brief — the agent refused to invent positioning/claims. */
  | "missing_brief"
  /** The provider failed; the script was kept so the agent's work is not lost (graceful fallback). */
  | "script_only"
  /** A video asset was rendered. */
  | "rendered";

/** A persisted record of one generation attempt — the audit trail of what the agent produced and why. */
export interface VideoJobRecord {
  id: string;
  workspaceId: string;
  requestedByMemberId: string;
  topic: string;
  status: VideoJobStatus;
  /** The generated script, or null for a `disabled`/`missing_brief` attempt. */
  script: VideoScript | null;
  /** The rendered asset, or null when nothing was rendered. */
  video: RenderedVideo | null;
  /** A short, human-readable reason when the attempt did not render (provider error / missing brief). */
  error: string | null;
  createdAt: Date;
}

/** What {@link import("./service.js").ShortFormVideoService.generate} returns to the caller. */
export interface VideoGenerationResult {
  status: VideoJobStatus;
  /** The persisted record, or null when nothing was persisted (the `disabled` path). */
  job: VideoJobRecord | null;
  /** The generated script when one was produced (`script_only` / `rendered`), else null. */
  script: VideoScript | null;
  /** The rendered asset on the `rendered` path, else null. */
  video: RenderedVideo | null;
  /** A short reason on a non-`rendered` outcome, else null. */
  reason: string | null;
}
