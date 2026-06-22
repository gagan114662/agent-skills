/**
 * The PURE core of the short-form video agent (#740): turn a topic + the live campaign brief into a
 * deterministic, brief-grounded {@link VideoScript} (hook → storyboard → CTA → caption). No IO, no clock, no
 * randomness — the same (request, config) always renders the same script, so a test can assert that editing
 * the brief MEASURABLY changes the output, and the fake provider downstream stays fully deterministic.
 *
 * #200 DEFENSE (FM#6 / FM#2): the topic and brief are OWNER-authored DATA, never instructions. Every value is
 * sanitized (control chars stripped, whitespace collapsed, length-bounded) before it reaches a script line,
 * and the narration may only repeat the brief's APPROVED claims — the agent never invents a metric or a
 * positioning of its own. A brief with no usable content yields {@link isBriefMissing} ⇒ the caller refuses
 * to generate at all rather than improvising.
 */

import type { ShortFormVideoConfig } from "./config.js";
import type { VideoBrief, VideoRequest, VideoScene, VideoScript } from "./types.js";

/** Max characters for a single narration / overlay / caption line. Short-form is terse. */
const MAX_LINE_CHARS = 200;
/** Max characters for the topic the script is built around. */
const MAX_TOPIC_CHARS = 160;
/** Minimum seconds a single scene is allowed to run — keeps the storyboard watchable. */
const MIN_SCENE_SECONDS = 2;

/**
 * Neutralize one owner-typed value into a safe script line: strip control characters, collapse whitespace,
 * trim, length-bound. Mirrors `campaign-brief/brief.ts:sanitizeBriefValue` — defense-in-depth so raw input
 * never reaches a prompt or an overlay.
 */
export function sanitizeLine(text: string, maxChars: number = MAX_LINE_CHARS): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- intentionally stripping control chars from typed input
      .replace(/[\x00-\x1f\x7f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxChars)
  );
}

/**
 * True when the brief carries nothing the agent can ground a script in — no positioning, no voice, and no
 * approved claims. On a missing brief the agent refuses to generate (it would otherwise have to invent the
 * product's positioning and claims, exactly what #588 + #200 FM#2 forbid).
 */
export function isBriefMissing(brief: VideoBrief | null | undefined): boolean {
  if (!brief) return true;
  const hasPositioning = sanitizeLine(brief.positioning ?? "").length > 0;
  const hasVoice = sanitizeLine(brief.voice ?? "").length > 0;
  const hasClaims = (brief.brandClaims ?? []).some((c) => sanitizeLine(c).length > 0);
  return !hasPositioning && !hasVoice && !hasClaims;
}

/** Sanitize, drop blanks + duplicates, and cap the approved-claims list (order preserved). */
function cleanClaims(raw: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const s = sanitizeLine(r);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= 8) break;
  }
  return out;
}

/** Split `total` seconds across `count` scenes as evenly as possible, every scene ≥ {@link MIN_SCENE_SECONDS}. */
function distributeDuration(total: number, count: number): number[] {
  if (count <= 0) return [];
  const safeTotal = Math.max(total, count * MIN_SCENE_SECONDS);
  const base = Math.floor(safeTotal / count);
  let remainder = safeTotal - base * count;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    // Hand the leftover seconds to the earliest scenes so the hook gets a touch more room. Deterministic.
    const extra = remainder > 0 ? 1 : 0;
    if (remainder > 0) remainder -= 1;
    out.push(base + extra);
  }
  return out;
}

/** Derive up to four lowercase hashtags from the audience + topic words. Deterministic + de-duplicated. */
function deriveHashtags(topic: string, audience: string): string[] {
  const words = `${audience} ${topic}`
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(`#${w}`);
    if (out.length >= 4) break;
  }
  return out;
}

/**
 * Build the deterministic script + storyboard for one request. Pure: given the same `(request, config)` it
 * always returns the same {@link VideoScript}. The scene count is the approved-claims count (one claim per
 * scene) plus a hook and a CTA scene, clamped to the config's `maxScenes`; the duration is split across them.
 *
 * The caller is expected to have checked {@link isBriefMissing} first — `buildScript` assumes a usable brief.
 */
export function buildScript(request: VideoRequest, config: ShortFormVideoConfig): VideoScript {
  const topic = sanitizeLine(request.topic, MAX_TOPIC_CHARS) || "our product";
  const audience = sanitizeLine(request.brief.audience) || "you";
  const positioning = sanitizeLine(request.brief.positioning) || topic;
  const voice = sanitizeLine(request.brief.voice) || "clear and direct";
  const claims = cleanClaims(request.brief.brandClaims);
  const cta = sanitizeLine(request.callToAction ?? "") || "Follow for more — link in bio.";

  const hook = `${topic}: here's why it matters for ${audience}.`;

  // One body scene per approved claim, bounded by the config's scene budget (reserving room for hook + CTA).
  const bodyBudget = Math.max(1, config.maxScenes - 2);
  const bodyClaims = claims.length > 0 ? claims.slice(0, bodyBudget) : [positioning];

  const sceneSeeds: Array<{ narration: string; onScreenText: string; visualCue: string }> = [];
  // Scene 1 — the hook, grounded in positioning + voice.
  sceneSeeds.push({
    narration: `${hook} ${positioning}.`,
    onScreenText: topic,
    visualCue: `Open on a bold, scroll-stopping visual. Tone: ${voice}.`,
  });
  // Body scenes — one approved claim each (never an invented one).
  bodyClaims.forEach((claim, i) => {
    sceneSeeds.push({
      narration: claim,
      onScreenText: claim.slice(0, 60),
      visualCue: `B-roll illustrating point ${i + 1}. Keep it concrete.`,
    });
  });
  // Final scene — the call to action.
  sceneSeeds.push({
    narration: cta,
    onScreenText: cta.slice(0, 60),
    visualCue: "Close on the logo + CTA card. Hold for 1s.",
  });

  const durations = distributeDuration(
    Math.min(config.maxDurationSeconds, Math.max(config.maxScenes, sceneSeeds.length) * 10),
    sceneSeeds.length,
  );
  const scenes: VideoScene[] = sceneSeeds.map((seed, i) => ({
    index: i + 1,
    narration: sanitizeLine(seed.narration),
    onScreenText: sanitizeLine(seed.onScreenText, 60),
    visualCue: sanitizeLine(seed.visualCue),
    durationSeconds: durations[i] ?? MIN_SCENE_SECONDS,
  }));

  const totalDurationSeconds = scenes.reduce((sum, s) => sum + s.durationSeconds, 0);
  const caption = sanitizeLine(`${topic} — ${positioning}. ${cta}`);
  const hashtags = deriveHashtags(topic, audience);

  return {
    hook: sanitizeLine(hook),
    scenes,
    callToAction: cta,
    caption,
    hashtags,
    aspectRatio: config.aspectRatio,
    totalDurationSeconds,
  };
}
