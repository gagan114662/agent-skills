/**
 * Short-form video generation agent config (#740). Deliberately **self-contained**: every knob is read
 * straight from the process environment so this feature adds NO edit to the shared `config/schema.ts` barrel,
 * keeping the change set free of parallel-merge conflicts with sibling branches (the #588/#637/#670 convention).
 *
 * Default **OFF** (`enabled: false`), the conservative choice for a parallel-merge world: a deployment that
 * sets nothing keeps today's behaviour exactly — the agent renders nothing and the pipeline is a no-op until
 * the owner flips the master switch (`SHORTFORM_VIDEO_ENABLED=1`). The only provider shipped here is the
 * deterministic {@link import("./provider.js").FakeVideoProvider}, so even once enabled NO external network
 * call happens until a real provider is wired in a later change — turning the feature on is safe by itself.
 *
 * The numeric knobs are sized so that once enabled they are immediately sensible for vertical short-form
 * video (a 9:16 reel up to 60s split across at most 6 scenes).
 */

/** The resolved config for the short-form video agent. Plain data — built once from the environment. */
export interface ShortFormVideoConfig {
  /** Master switch. When false, the service does nothing and never touches the provider or the store. */
  readonly enabled: boolean;
  /** The provider binding to use. Only `fake` ships today; a real id is wired in a later change. */
  readonly provider: "fake";
  /** The target aspect ratio for the rendered video (vertical short-form by default). */
  readonly aspectRatio: string;
  /** The maximum total video duration in seconds. The script's scene budget is clamped to fit. */
  readonly maxDurationSeconds: number;
  /** The maximum number of scenes a generated script may contain. */
  readonly maxScenes: number;
}

/** The default config: OFF, fake provider, sensible vertical short-form numbers. */
export const SHORTFORM_VIDEO_DEFAULTS: ShortFormVideoConfig = {
  enabled: false,
  provider: "fake",
  aspectRatio: "9:16",
  maxDurationSeconds: 60,
  maxScenes: 6,
};

/** Parse a boolean-ish env flag: `1`/`true`/`yes`/`on` (case-insensitive) ⇒ true; everything else ⇒ false. */
function envFlag(raw: string | undefined): boolean {
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** Parse a positive integer; a missing/invalid/non-positive value keeps `fallback`. */
function envPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
}

/**
 * Resolve the short-form video config from the environment (defaults applied). Pure given its `env`
 * argument, so a test can drive every branch by passing a synthetic env without touching `process.env`.
 */
export function resolveShortFormVideoConfig(
  env: NodeJS.ProcessEnv = process.env,
): ShortFormVideoConfig {
  const d = SHORTFORM_VIDEO_DEFAULTS;
  const aspect = env.SHORTFORM_VIDEO_ASPECT_RATIO?.trim();
  return {
    enabled: envFlag(env.SHORTFORM_VIDEO_ENABLED),
    provider: "fake",
    aspectRatio: aspect && /^\d{1,2}:\d{1,2}$/.test(aspect) ? aspect : d.aspectRatio,
    maxDurationSeconds: envPositiveInt(env.SHORTFORM_VIDEO_MAX_DURATION_SECONDS, d.maxDurationSeconds),
    maxScenes: envPositiveInt(env.SHORTFORM_VIDEO_MAX_SCENES, d.maxScenes),
  };
}
