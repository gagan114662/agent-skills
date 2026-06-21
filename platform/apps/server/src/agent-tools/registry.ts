/**
 * The concrete execution tools (#464) — the first real "acts outside" verbs the fleet carries. Three tools
 * spanning every human-approval boundary, so the framework demonstrably gates each kind:
 *
 *   - `content.publish`      — take a drafted article LIVE on a public URL (PUBLIC boundary → `hosted.publish`).
 *   - `social.post`          — fan a drafted post OUT to connected networks (OUTBOUND boundary → `social.publish_post`).
 *   - `ads.launch_campaign`  — commit paid acquisition spend (MONEY boundary → `venture.ad_spend`).
 *
 * Each tool is pure data + one pure `prepare`. None can fire: `prepare` only validates and builds the
 * (injection-safe) parking payload; the {@link import("./service.js").ExecutionToolService} parks the #13
 * approval and the per-department service actuates it later, behind the owner's yes.
 *
 * Every routing payload carries IDS ONLY (slug / postId / networks / campaignId) — never the free-form body
 * (#200 §6: a poisoned draft can never redirect the executor). The human summary is built structurally and
 * run through {@link sanitizeArg} so an arg can never smuggle a control byte / directive into the queue.
 */
import {
  HOSTED_PUBLISH_ACTION,
  SOCIAL_PUBLISH_POST_ACTION,
  VENTURE_AD_SPEND_ACTION,
} from "../approvals/policy.js";
import type { ExecutionToolSpec, ToolPreparation } from "./types.js";

/** Strip control bytes and clamp — a validated id/slug can never inject a directive into the #13 queue. */
function sanitizeArg(value: string, max = 80): string {
  let out = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code >= 0x20 && code !== 0x7f) out += ch;
  }
  return out.trim().slice(0, max);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Slug-safe id: lowercase letters/digits/hyphens (a routing key the executor can trust). */
function normalizeSlug(value: string): string {
  return sanitizeArg(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

const contentPublish: ExecutionToolSpec = {
  name: "content.publish",
  label: "Publish content",
  description: "Take a drafted article live on a public URL.",
  department: "content",
  gatedAction: HOSTED_PUBLISH_ACTION,
  visibility: "public",
  prepare(args: unknown): ToolPreparation {
    const a = asRecord(args);
    if (!a) return { ok: false, error: "args must be an object" };
    if (!nonEmptyString(a.title)) return { ok: false, error: "title required" };
    if (!nonEmptyString(a.slug)) return { ok: false, error: "slug required" };
    const slug = normalizeSlug(a.slug);
    if (!slug) return { ok: false, error: "slug must contain a letter or digit" };
    return {
      ok: true,
      summary: `Publish the page "/${slug}" to a public URL`,
      payload: { source: "agent-tools", tool: "content.publish", slug },
      amount: null,
    };
  },
};

const socialPost: ExecutionToolSpec = {
  name: "social.post",
  label: "Post to social",
  description: "Fan a drafted post out to the connected social networks.",
  department: "social",
  gatedAction: SOCIAL_PUBLISH_POST_ACTION,
  visibility: "outbound",
  prepare(args: unknown): ToolPreparation {
    const a = asRecord(args);
    if (!a) return { ok: false, error: "args must be an object" };
    if (!nonEmptyString(a.postId)) return { ok: false, error: "postId required" };
    if (!Array.isArray(a.networks) || a.networks.length === 0) {
      return { ok: false, error: "at least one target network required" };
    }
    const networks = a.networks.filter(nonEmptyString).map((n) => sanitizeArg(n, 24));
    if (networks.length === 0) return { ok: false, error: "at least one valid network required" };
    const postId = sanitizeArg(a.postId);
    return {
      ok: true,
      summary: `Post to ${networks.join(", ")}`,
      payload: { source: "agent-tools", tool: "social.post", postId, networks },
      amount: null,
    };
  },
};

const adsLaunchCampaign: ExecutionToolSpec = {
  name: "ads.launch_campaign",
  label: "Launch ad campaign",
  description: "Commit a daily budget and start a paid acquisition campaign.",
  department: "ads",
  gatedAction: VENTURE_AD_SPEND_ACTION,
  visibility: "money",
  prepare(args: unknown): ToolPreparation {
    const a = asRecord(args);
    if (!a) return { ok: false, error: "args must be an object" };
    if (!nonEmptyString(a.campaignId)) return { ok: false, error: "campaignId required" };
    const budget = a.dailyBudget;
    if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) {
      return { ok: false, error: "dailyBudget must be a positive number" };
    }
    const campaignId = sanitizeArg(a.campaignId);
    return {
      ok: true,
      summary: `Launch campaign "${campaignId}" at ${budget}/day`,
      payload: { source: "agent-tools", tool: "ads.launch_campaign", campaignId },
      amount: budget,
    };
  },
};

/** The full execution-tool catalog, in stable order. Pure. */
export const EXECUTION_TOOLS: readonly ExecutionToolSpec[] = [contentPublish, socialPost, adsLaunchCampaign];

/** Look up a tool by name, or `undefined` when it is not a real execution tool (fail-closed). Pure. */
export function findExecutionTool(name: string): ExecutionToolSpec | undefined {
  return EXECUTION_TOOLS.find((t) => t.name === name);
}

/** Every execution tool an agent department carries (empty for a read/draft-only department). Pure. */
export function executionToolsForDepartment(department: string): ExecutionToolSpec[] {
  return EXECUTION_TOOLS.filter((t) => t.department === department);
}
