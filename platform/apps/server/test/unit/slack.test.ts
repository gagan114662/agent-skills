import { describe, it, expect } from "vitest";
import {
  signSlackRequest,
  verifySlackSignature,
  SlackVerificationError,
} from "../../src/slack/verify.js";
import { slackMentionToPlatformMessage } from "../../src/slack/mention-parse.js";
import {
  buildApprovalBlocks,
  parseApprovalActionValue,
  SLACK_APPROVE_ACTION,
  SLACK_REJECT_ACTION,
} from "../../src/slack/blocks.js";
import { buildSlackDigest } from "../../src/slack/digest.js";
import { resolveSlackCaps } from "../../src/slack/caps.js";

/**
 * Pure Slack-native modules (#170) — no DB, no network, so signature/replay, mention translation,
 * Block Kit shaping, digest copy, and the default-OFF caps are all real and hermetic.
 */

const SECRET = "slack_signing_secret_value_123";
const BODY = JSON.stringify({ type: "event_callback", event: { type: "app_mention" } });
const NOW = new Date("2026-06-12T00:00:00.000Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

describe("verifySlackSignature (#170 — Slack v0 scheme, pure)", () => {
  it("verifies a request signed with the same secret + a fresh timestamp", () => {
    const sig = signSlackRequest(BODY, SECRET, NOW_SEC);
    expect(() =>
      verifySlackSignature(BODY, String(NOW_SEC), sig, SECRET, { now: NOW, toleranceSec: 300 }),
    ).not.toThrow();
  });

  it("rejects a tampered body (signature no longer matches)", () => {
    const sig = signSlackRequest(BODY, SECRET, NOW_SEC);
    expect(() =>
      verifySlackSignature(BODY + " ", String(NOW_SEC), sig, SECRET, { now: NOW }),
    ).toThrow(SlackVerificationError);
  });

  it("rejects a wrong secret", () => {
    const sig = signSlackRequest(BODY, "other_secret", NOW_SEC);
    expect(() => verifySlackSignature(BODY, String(NOW_SEC), sig, SECRET, { now: NOW })).toThrow(
      SlackVerificationError,
    );
  });

  it("rejects a timestamp outside the tolerance window (replay)", () => {
    const oldSec = NOW_SEC - 4000;
    const sig = signSlackRequest(BODY, SECRET, oldSec);
    expect(() =>
      verifySlackSignature(BODY, String(oldSec), sig, SECRET, { now: NOW, toleranceSec: 300 }),
    ).toThrow(/tolerance/);
  });

  it("rejects missing headers + empty secret", () => {
    const sig = signSlackRequest(BODY, SECRET, NOW_SEC);
    expect(() => verifySlackSignature(BODY, undefined, sig, SECRET, { now: NOW })).toThrow(
      SlackVerificationError,
    );
    expect(() => verifySlackSignature(BODY, String(NOW_SEC), undefined, SECRET, { now: NOW })).toThrow(
      SlackVerificationError,
    );
    expect(() => verifySlackSignature(BODY, String(NOW_SEC), sig, "", { now: NOW })).toThrow(
      SlackVerificationError,
    );
  });
});

describe("slackMentionToPlatformMessage (#170 — bot mention → @handle)", () => {
  it("strips the bot mention and turns the first word into an @handle", () => {
    expect(slackMentionToPlatformMessage("<@U0BOT> scout audit acme.com")).toBe(
      "@scout audit acme.com",
    );
  });

  it("keeps an already-@ handle as-is", () => {
    expect(slackMentionToPlatformMessage("<@U0BOT> @scout go")).toBe("@scout go");
  });

  it("handles a mention with a display-name pipe + extra whitespace", () => {
    expect(slackMentionToPlatformMessage("<@U0BOT|ipop>   ada   ship it ")).toBe("@ada ship it");
  });

  it("returns null when nothing actionable remains", () => {
    expect(slackMentionToPlatformMessage("<@U0BOT>")).toBeNull();
    expect(slackMentionToPlatformMessage("   ")).toBeNull();
  });
});

describe("buildApprovalBlocks + parseApprovalActionValue (#170 — round-trip identity)", () => {
  it("embeds rid+wid in both buttons and round-trips them", () => {
    const blocks = buildApprovalBlocks({ requestId: "req-1", workspaceId: "ws-1", summary: "Post a tweet" });
    const actions = blocks.find((b) => b.type === "actions") as {
      elements: Array<{ action_id: string; value: string }>;
    };
    expect(actions.elements.map((e) => e.action_id)).toEqual([
      SLACK_APPROVE_ACTION,
      SLACK_REJECT_ACTION,
    ]);
    for (const el of actions.elements) {
      expect(parseApprovalActionValue(el.value)).toEqual({ requestId: "req-1", workspaceId: "ws-1" });
    }
  });

  it("returns null on a malformed action value", () => {
    expect(parseApprovalActionValue("not json")).toBeNull();
    expect(parseApprovalActionValue(JSON.stringify({ rid: "x" }))).toBeNull();
    expect(parseApprovalActionValue(42)).toBeNull();
  });
});

describe("buildSlackDigest (#170 — house voice, pure)", () => {
  it("summarizes activity, pending, and spend", () => {
    const digest = buildSlackDigest({
      brandName: "ipop",
      sessionsLaunched: 3,
      tasksCompleted: 5,
      pendingApprovals: ["Post a tweet for Acme"],
      spendCents: 1234,
    });
    expect(digest.text).toContain("3 sessions");
    expect(digest.text).toContain("$12.34");
    const flat = JSON.stringify(digest.blocks);
    expect(flat).toContain("Post a tweet for Acme");
    expect(flat).toContain("$12.34");
  });

  it("uses the calm variant on a quiet day", () => {
    const digest = buildSlackDigest({
      brandName: "ipop",
      sessionsLaunched: 0,
      tasksCompleted: 0,
      pendingApprovals: [],
      spendCents: 0,
    });
    expect(JSON.stringify(digest.blocks)).toContain("Quiet day");
  });
});

describe("resolveSlackCaps (#170 — default OFF)", () => {
  it("defaults both flags off when unset", () => {
    expect(resolveSlackCaps(undefined)).toEqual({ enabled: false, digestEnabled: false });
    expect(resolveSlackCaps({})).toEqual({ enabled: false, digestEnabled: false });
  });

  it("honors explicit opt-in", () => {
    expect(resolveSlackCaps({ enabled: true, digestEnabled: true })).toEqual({
      enabled: true,
      digestEnabled: true,
    });
  });
});
