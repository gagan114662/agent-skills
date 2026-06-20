/**
 * Channel auto-scroll decisions (#419) — pure-layer tests. Prove the feed follows the conversation when the
 * reader is at the bottom (or sent the message), and surfaces an unread pill instead of yanking a reader who
 * scrolled up into history.
 */
import { describe, expect, it } from "vitest";
import {
  NEAR_BOTTOM_PX,
  distanceFromBottom,
  isNearBottom,
  decideOnNewMessages,
} from "./message-scroll.js";

describe("isNearBottom", () => {
  it("is true when pinned to the bottom", () => {
    expect(isNearBottom({ scrollTop: 880, scrollHeight: 1000, clientHeight: 120 })).toBe(true);
  });

  it("is true within the threshold of the bottom", () => {
    // distance = 1000 - 800 - 120 = 80 ≤ 120
    expect(isNearBottom({ scrollTop: 800, scrollHeight: 1000, clientHeight: 120 })).toBe(true);
  });

  it("is false when scrolled up beyond the threshold", () => {
    // distance = 1000 - 0 - 120 = 880 > 120
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 1000, clientHeight: 120 })).toBe(false);
  });

  it("is true when the content does not overflow (everything fits)", () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 600 })).toBe(true);
  });

  it("respects a custom threshold", () => {
    const m = { scrollTop: 800, scrollHeight: 1000, clientHeight: 120 }; // distance 80
    expect(isNearBottom(m, 50)).toBe(false);
    expect(isNearBottom(m, 100)).toBe(true);
  });

  it("exposes a sane default threshold", () => {
    expect(NEAR_BOTTOM_PX).toBeGreaterThan(0);
  });

  it("computes the raw distance from the bottom", () => {
    expect(distanceFromBottom({ scrollTop: 200, scrollHeight: 1000, clientHeight: 120 })).toBe(680);
  });
});

describe("decideOnNewMessages", () => {
  it("does nothing when no messages were added", () => {
    expect(decideOnNewMessages({ added: 0, wasNearBottom: false, authoredBySelf: false })).toBe("none");
  });

  it("follows to the newest message when the reader was at the bottom", () => {
    expect(decideOnNewMessages({ added: 1, wasNearBottom: true, authoredBySelf: false })).toBe("scroll");
  });

  it("always follows the user's own send, even if they were scrolled up", () => {
    expect(decideOnNewMessages({ added: 1, wasNearBottom: false, authoredBySelf: true })).toBe("scroll");
  });

  it("notifies (does not yank) a reader who scrolled up to read history", () => {
    expect(decideOnNewMessages({ added: 2, wasNearBottom: false, authoredBySelf: false })).toBe("notify");
  });
});
