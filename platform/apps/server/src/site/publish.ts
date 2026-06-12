/**
 * The publish gate for the marketing site (#153) — a **pure** descriptor builder over the #13
 * `external.send` action, exactly like `marketing/external-send.ts`. Publishing a page is just another
 * thing that "leaves the building": it is sensitive-by-default (no workspace rule needed → gated),
 * submitted through the unchanged `POST /workspaces/:wid/actions` path, and recorded-only after a human
 * approves. This module changes NEITHER `approvals/policy.ts` NOR the executor — so every publish is
 * #13-gated with zero core change, and every existing approval test is untouched.
 */
import type { SiteSection } from "./content.js";

/** The publish kind carried in the action payload (the executor validates it as an external send). */
export const CONTENT_PUBLISH_KIND = "content.publish" as const;

export interface ContentPublishInput {
  section: SiteSection;
  slug: string;
  title: string;
  /** The fleet agent that authored the draft (credited in the review-queue line). */
  agent: string;
}

/** The #13 action a content publish becomes: always `external.send`, gated by default. */
export interface ContentPublishDescriptor {
  actionType: "external.send";
  amount: null;
  payload: { kind: typeof CONTENT_PUBLISH_KIND; summary: string; target: string };
}

/** Map a content section to its public URL prefix (the `stories`/`guides` plurals the site routes use). */
function urlPrefix(section: SiteSection): string {
  switch (section) {
    case "compare":
      return "compare";
    case "stories":
      return "stories";
    case "guides":
      return "guides";
    case "changelog":
      return "changelog";
  }
}

/**
 * Build the `external.send` descriptor that gates publishing a piece of marketing content. The `target`
 * is the public path the page will live at, and `summary` is the review-queue line a human reads before
 * approving. `external.send` is sensitive-by-default, so this is ALWAYS a pending human approval.
 */
export function buildContentPublish(input: ContentPublishInput): ContentPublishDescriptor {
  const target = `/${urlPrefix(input.section)}/${input.slug}`;
  return {
    actionType: "external.send",
    amount: null,
    payload: {
      kind: CONTENT_PUBLISH_KIND,
      summary: `Publish ${input.section}: “${input.title}” (drafted by ${input.agent})`,
      target,
    },
  };
}
