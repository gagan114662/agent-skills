/**
 * Objective, machine-checked channel specs (#dogfood-harness). Pure. These are the hard, countable rules an
 * asset must satisfy to be *usable* on its channel at all — the floor beneath taste. A spec `error` makes an
 * asset spec-INVALID: no amount of grader optimism can clear the award bar with a Google ad whose headline
 * overflows 30 characters, because the ad platform will simply reject it.
 *
 * Limits are the real published channel limits (Google RSA, Meta, RFC-ish email, X) so the harness catches
 * exactly what a human media buyer would catch. `warn` findings are best-practice (truncation, glanceability)
 * and shape craft/rewrite notes without failing the asset.
 */
import type { AssetKind, CampaignAsset, SpecViolation } from "./types.js";

/** All numeric channel limits in one place so tests and docs cite a single source. */
export const SPEC = {
  googleAd: { headlineMax: 30, headlineMin: 3, headlineIdeal: 5, descriptionMax: 90, descriptionMin: 2, descriptionCap: 4 },
  metaAd: { primaryTextIdeal: 125, headlineMax: 40, linkDescIdeal: 30 },
  email: { subjectMax: 60, subjectIdeal: 50 },
  socialX: { max: 280 },
  linkedin: { hookVisible: 210 },
  video: { wordsMin: 45, wordsMax: 100 },
  blog: { wordsMin: 700, wordsHardMin: 200 },
  hero: { headlineIdeal: 60 },
  ooh: { wordsIdeal: 7, wordsMax: 10 },
} as const;

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

const field = (a: CampaignAsset, k: string): string => (a.fields?.[k] ?? "").trim();
const list = (a: CampaignAsset, k: string): string[] => (a.lists?.[k] ?? []).map((s) => s.trim()).filter(Boolean);
const body = (a: CampaignAsset): string => (a.text ?? "").trim();

function err(rule: string, message: string): SpecViolation {
  return { severity: "error", rule, message };
}
function warn(rule: string, message: string): SpecViolation {
  return { severity: "warn", rule, message };
}

/** Validate a Google Responsive Search Ad: 3–15 headlines ≤30 chars, 2–4 descriptions ≤90 chars. */
function validateGoogleAd(a: CampaignAsset): SpecViolation[] {
  const v: SpecViolation[] = [];
  const headlines = list(a, "headlines");
  const descriptions = list(a, "descriptions");
  if (headlines.length < SPEC.googleAd.headlineMin) {
    v.push(err("google.headline.count", `RSA needs ≥${SPEC.googleAd.headlineMin} headlines, found ${headlines.length}.`));
  } else if (headlines.length < SPEC.googleAd.headlineIdeal) {
    v.push(warn("google.headline.count", `Only ${headlines.length} headlines; Google rewards ${SPEC.googleAd.headlineIdeal}–15 for optimization.`));
  }
  headlines.forEach((h, i) => {
    if (h.length > SPEC.googleAd.headlineMax) {
      v.push(err("google.headline.length", `Headline ${i + 1} is ${h.length} chars (max ${SPEC.googleAd.headlineMax}): "${h}"`));
    }
  });
  if (descriptions.length < SPEC.googleAd.descriptionMin) {
    v.push(err("google.description.count", `RSA needs ≥${SPEC.googleAd.descriptionMin} descriptions, found ${descriptions.length}.`));
  }
  descriptions.forEach((d, i) => {
    if (d.length > SPEC.googleAd.descriptionMax) {
      v.push(err("google.description.length", `Description ${i + 1} is ${d.length} chars (max ${SPEC.googleAd.descriptionMax}): "${d}"`));
    }
  });
  return v;
}

function validateMetaAd(a: CampaignAsset): SpecViolation[] {
  const v: SpecViolation[] = [];
  const primary = field(a, "primaryText") || body(a);
  const headline = field(a, "headline");
  const visual = field(a, "visual") || field(a, "visualConcept");
  if (!primary) v.push(err("meta.primaryText", "Meta ad has no primary text."));
  else if (primary.length > SPEC.metaAd.primaryTextIdeal)
    v.push(warn("meta.primaryText", `Primary text ${primary.length} chars; Meta truncates ~${SPEC.metaAd.primaryTextIdeal}.`));
  if (!headline) v.push(err("meta.headline", "Meta ad has no headline."));
  else if (headline.length > SPEC.metaAd.headlineMax)
    v.push(err("meta.headline", `Headline ${headline.length} chars (max ${SPEC.metaAd.headlineMax}): "${headline}"`));
  if (!visual) v.push(err("meta.visual", "Meta ad has no visual concept direction (mission requires visual concept directions)."));
  return v;
}

function validateEmail(a: CampaignAsset): SpecViolation[] {
  const v: SpecViolation[] = [];
  const subject = field(a, "subject");
  const preheader = field(a, "preheader");
  const cta = field(a, "cta");
  if (!subject) v.push(err("email.subject", "Email has no subject line."));
  else if (subject.length > SPEC.email.subjectMax)
    v.push(warn("email.subject", `Subject ${subject.length} chars; clients truncate ~${SPEC.email.subjectIdeal}.`));
  if (!preheader) v.push(warn("email.preheader", "Email has no preheader — the inbox preview is wasted."));
  if (!body(a)) v.push(err("email.body", "Email has no body."));
  if (!cta) v.push(warn("email.cta", "Email has no explicit single CTA."));
  return v;
}

function validateSocial(kind: AssetKind, a: CampaignAsset): SpecViolation[] {
  const v: SpecViolation[] = [];
  const text = body(a);
  if (!text && kind !== "social-tiktok") v.push(err("social.body", `${kind} has no post text.`));
  if (kind === "social-x" && text.length > SPEC.socialX.max)
    v.push(err("social.x.length", `X post is ${text.length} chars (max ${SPEC.socialX.max}).`));
  if (kind === "social-linkedin") {
    const firstLine = text.split("\n")[0] ?? "";
    if (firstLine.length > SPEC.linkedin.hookVisible)
      v.push(warn("social.linkedin.hook", `First line ${firstLine.length} chars; LinkedIn hides past ~${SPEC.linkedin.hookVisible} behind "…more".`));
  }
  if (kind === "social-instagram" && list(a, "hashtags").length === 0)
    v.push(warn("social.instagram.hashtags", "Instagram post has no hashtags."));
  if (kind === "social-tiktok") {
    if (!field(a, "hook")) v.push(err("social.tiktok.hook", "TikTok script has no opening hook (first 2s decide retention)."));
    if (list(a, "shots").length === 0 && !text) v.push(err("social.tiktok.script", "TikTok asset has no beats/script."));
  }
  return v;
}

function validateVideo(a: CampaignAsset): SpecViolation[] {
  const v: SpecViolation[] = [];
  const words = wordCount(body(a));
  if (words === 0) v.push(err("video.narration", "Video script has no narration/VO."));
  else if (words < SPEC.video.wordsMin || words > SPEC.video.wordsMax)
    v.push(warn("video.length", `Narration is ${words} words; a 30s spot is ~${SPEC.video.wordsMin}–${SPEC.video.wordsMax}.`));
  if (list(a, "shots").length === 0) v.push(err("video.shots", "Video script has no shot list (mission requires a shot list)."));
  return v;
}

function validateBlog(a: CampaignAsset): SpecViolation[] {
  const v: SpecViolation[] = [];
  const words = wordCount(body(a));
  const headline = field(a, "headline") || a.title;
  if (words < SPEC.blog.wordsHardMin) v.push(err("blog.length", `Blog is ${words} words — not long-form.`));
  else if (words < SPEC.blog.wordsMin) v.push(warn("blog.length", `Blog is ${words} words; long-form aims ≥${SPEC.blog.wordsMin}.`));
  if (!headline) v.push(err("blog.headline", "Blog has no headline."));
  return v;
}

function validateHero(a: CampaignAsset): SpecViolation[] {
  const v: SpecViolation[] = [];
  const headline = field(a, "headline");
  const cta = field(a, "cta");
  if (!headline) v.push(err("hero.headline", "Landing hero has no headline."));
  else if (headline.length > SPEC.hero.headlineIdeal)
    v.push(warn("hero.headline", `Hero headline ${headline.length} chars; keep it scannable (≤${SPEC.hero.headlineIdeal}).`));
  if (!field(a, "subhead")) v.push(warn("hero.subhead", "Landing hero has no subhead."));
  if (!cta) v.push(err("hero.cta", "Landing hero has no CTA."));
  return v;
}

function validateOoh(a: CampaignAsset): SpecViolation[] {
  const v: SpecViolation[] = [];
  const headline = field(a, "headline") || body(a);
  const concept = field(a, "concept") || field(a, "visual");
  const words = wordCount(headline);
  if (!headline) v.push(err("ooh.headline", "OOH/print concept has no primary line."));
  else if (words > SPEC.ooh.wordsMax) v.push(err("ooh.glanceability", `OOH line is ${words} words; a driver reads ≤${SPEC.ooh.wordsIdeal}.`));
  else if (words > SPEC.ooh.wordsIdeal) v.push(warn("ooh.glanceability", `OOH line is ${words} words; aim ≤${SPEC.ooh.wordsIdeal} for glanceability.`));
  if (!concept) v.push(warn("ooh.concept", "OOH/print has no visual concept direction."));
  return v;
}

/** Validate one asset against its channel spec. Pure and deterministic. */
export function validateAsset(a: CampaignAsset): SpecViolation[] {
  switch (a.kind) {
    case "google-search-ad":
      return validateGoogleAd(a);
    case "meta-ad":
      return validateMetaAd(a);
    case "email":
      return validateEmail(a);
    case "social-x":
    case "social-linkedin":
    case "social-instagram":
    case "social-tiktok":
      return validateSocial(a.kind, a);
    case "video-script":
      return validateVideo(a);
    case "blog":
      return validateBlog(a);
    case "landing-hero":
      return validateHero(a);
    case "ooh-print":
      return validateOoh(a);
    default:
      return [];
  }
}

/** Gather every text fragment of an asset (fields + lists + body) for slop / claim scanning. */
export function assetCorpus(a: CampaignAsset): string {
  return [
    a.title,
    a.text ?? "",
    ...Object.values(a.fields ?? {}),
    ...Object.values(a.lists ?? {}).flat(),
  ]
    .filter(Boolean)
    .join("\n");
}
