import type { BrowserToolName } from "../runtime/browser/tools.js";
import { sanitizeLine } from "./compose.js";

export const OUTREACH_SURFACES = ["reddit", "hacker_news", "linkedin", "product_hunt"] as const;
export type OutreachSurface = (typeof OUTREACH_SURFACES)[number];

export function isOutreachSurface(value: unknown): value is OutreachSurface {
  return typeof value === "string" && (OUTREACH_SURFACES as readonly string[]).includes(value);
}

export interface SurfacePostInput {
  surface: OutreachSurface;
  sessionId: string;
  title?: string;
  body: string;
  community?: string;
  productName?: string;
  sourceUrl?: string;
}

export interface SurfacePlaybook {
  surface: OutreachSurface;
  surfaceLabel: string;
  targetUrl: string;
  draft: {
    title: string;
    body: string;
    community: string | null;
    sourceUrl: string | null;
  };
  steps: Array<{
    kind: "read" | "write" | "submit";
    instruction: string;
  }>;
  submit: {
    tool: BrowserToolName;
    target: string;
    summary: string;
  };
}

const MAX_TITLE = 140;
const MAX_BODY = 1800;
const MAX_COMMUNITY = 80;
const MAX_URL = 500;

function clean(value: string | undefined, max: number): string {
  return sanitizeLine(value ?? "", max);
}

function cleanUrl(value: string | undefined): string | null {
  const v = clean(value, MAX_URL);
  if (!v) return null;
  try {
    const url = new URL(v);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function cleanCommunity(value: string | undefined): string {
  return clean(value, MAX_COMMUNITY).replace(/^r\//i, "").replace(/^@/, "");
}

function baseDraft(input: SurfacePostInput): SurfacePlaybook["draft"] {
  return {
    title: clean(input.title || input.productName || "Useful thing we made", MAX_TITLE),
    body: clean(input.body, MAX_BODY),
    community: input.community ? cleanCommunity(input.community) || null : null,
    sourceUrl: cleanUrl(input.sourceUrl),
  };
}

function requireBody(body: string): string {
  if (!body.trim()) throw new Error("body required");
  return body;
}

export function buildSurfacePlaybook(input: SurfacePostInput): SurfacePlaybook {
  const draft = baseDraft(input);
  requireBody(draft.body);

  if (input.surface === "reddit") {
    const community = draft.community ?? "SaaS";
    const targetUrl = `https://www.reddit.com/r/${encodeURIComponent(community)}/submit`;
    return {
      surface: input.surface,
      surfaceLabel: "Reddit",
      targetUrl,
      draft: { ...draft, community },
      steps: [
        { kind: "read", instruction: `Open r/${community} and read the visible posting rules before editing.` },
        { kind: "write", instruction: "Fill the title and text fields with the draft exactly as data." },
        { kind: "submit", instruction: "Stop on the final submit button and request owner approval before clicking." },
      ],
      submit: {
        tool: "click",
        target: targetUrl,
        summary: `Submit Reddit post to r/${community}: ${draft.title}`,
      },
    };
  }

  if (input.surface === "hacker_news") {
    const targetUrl = "https://news.ycombinator.com/submit";
    return {
      surface: input.surface,
      surfaceLabel: "Hacker News",
      targetUrl,
      draft,
      steps: [
        { kind: "read", instruction: "Open the HN submit page using the logged-in browser session." },
        { kind: "write", instruction: "Fill title plus URL/text from the draft; do not embellish scraped data." },
        { kind: "submit", instruction: "Stop on submit and request owner approval before posting." },
      ],
      submit: {
        tool: "click",
        target: targetUrl,
        summary: `Submit Hacker News post: ${draft.title}`,
      },
    };
  }

  if (input.surface === "linkedin") {
    const targetUrl = "https://www.linkedin.com/feed/";
    return {
      surface: input.surface,
      surfaceLabel: "LinkedIn",
      targetUrl,
      draft,
      steps: [
        { kind: "read", instruction: "Open LinkedIn in the logged-in browser session and start a post." },
        { kind: "write", instruction: "Paste the body as the post text; keep links from the structured draft only." },
        { kind: "submit", instruction: "Stop on Post and request owner approval before publishing." },
      ],
      submit: {
        tool: "click",
        target: targetUrl,
        summary: `Submit LinkedIn post: ${draft.title || draft.body.slice(0, 80)}`,
      },
    };
  }

  const targetUrl = "https://www.producthunt.com/posts/new";
  return {
    surface: input.surface,
    surfaceLabel: "Product Hunt",
    targetUrl,
    draft,
    steps: [
      { kind: "read", instruction: "Open the Product Hunt launch flow in the logged-in browser session." },
      { kind: "write", instruction: "Fill product name, tagline, URL, and description from the structured draft." },
      { kind: "submit", instruction: "Stop at the launch/submit control and request owner approval before publishing." },
    ],
    submit: {
      tool: "click",
      target: targetUrl,
      summary: `Submit Product Hunt launch: ${draft.title}`,
    },
  };
}
