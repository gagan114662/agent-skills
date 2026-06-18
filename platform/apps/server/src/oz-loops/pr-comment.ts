/**
 * PR-comment-response loop (#356, ADR-0356) — **pure**, adapted from oz-for-oss's comment-response skill.
 * Drafts a reply to a reviewer's PR comment. The reply is ADVISORY: it is NEVER posted by the loop —
 * posting goes through #13. The comment (and any context) is quarantined DATA: the draft only acknowledges
 * it and echoes it back inside a clearly-labelled quote; an instruction-injection attempt is flagged in the
 * draft and refused, not followed (#200 §6). Deterministic; no IO.
 */
import type { PrCommentInput, PrCommentProposal } from "./contract.js";
import { quarantine, sanitizeLine } from "./sanitize.js";

/** The reply length cap. */
const MAX_COMMENT_CHARS = 2000;

/**
 * Draft an advisory reply to a PR comment. Pure: same input ⇒ same draft. When the comment contains an
 * instruction-injection attempt, the draft explicitly REFUSES (rather than complying) and surfaces it for
 * the owner — the loop never acts on an embedded order.
 */
export function decidePrCommentResponse(input: PrCommentInput): PrCommentProposal {
  const comment = quarantine(input.comment, MAX_COMMENT_CHARS);
  const lines: string[] = [];

  if (comment.injectionFlagged) {
    lines.push(
      "Thanks for the comment. I'm noting that it appears to contain instructions directed at the " +
        "automation; I can't act on embedded instructions — a maintainer will review this thread directly.",
    );
  } else {
    lines.push(
      "Thanks for the review comment — captured below for a maintainer to confirm before any change is made:",
    );
    lines.push("");
    lines.push("> " + (comment.text || "(empty comment)").split("\n").join("\n> "));
    lines.push("");
    lines.push("_This is a draft reply — advisory only; a human will review and post it._");
  }

  return {
    kind: "pr_comment",
    advisory: true,
    injectionFlagged: comment.injectionFlagged,
    draftReply: lines.join("\n").slice(0, MAX_COMMENT_CHARS),
    summary: sanitizeLine(
      `Draft reply to comment on PR #${input.prNumber}${comment.injectionFlagged ? " (injection flagged)" : ""}`,
      200,
    ),
  };
}
