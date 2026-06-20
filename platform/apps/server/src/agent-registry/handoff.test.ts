import { describe, it, expect } from "vitest";
import {
  extractFleetMentions,
  encodeHandoffGoal,
  parseHandoffChain,
  HANDOFF_CHAIN_PREFIX,
} from "./handoff.js";

const FLEET = ["scout", "echo", "quill", "postmark", "bid", "lens", "mark", "comet"] as const;

describe("agent-registry/handoff — extractFleetMentions", () => {
  it("finds a known fleet @handle in the body", () => {
    expect(extractFleetMentions("@quill please draft this", FLEET)).toEqual(["quill"]);
  });

  it("ignores @tokens that are not fleet handles", () => {
    expect(extractFleetMentions("hey @nobody and @quill", FLEET)).toEqual(["quill"]);
  });

  it("matches case-insensitively and lowercases the result", () => {
    expect(extractFleetMentions("@Quill @ECHO", FLEET)).toEqual(["quill", "echo"]);
  });

  it("dedupes repeated mentions, preserving first-seen order", () => {
    expect(extractFleetMentions("@echo @quill @echo", FLEET)).toEqual(["echo", "quill"]);
  });

  it("returns [] when there are no fleet mentions", () => {
    expect(extractFleetMentions("no mentions here", FLEET)).toEqual([]);
    expect(extractFleetMentions("@stranger only", FLEET)).toEqual([]);
  });

  it("matches a handle up to a separator the charset excludes (comma)", () => {
    // The charset is [A-Za-z0-9._-]; a comma ends the token, a trailing dot does not.
    expect(extractFleetMentions("ping @comet, hi", FLEET)).toEqual(["comet"]);
  });

  it("a trailing '.' is part of the captured token so it no longer matches a bare handle", () => {
    // `@bid.` captures `bid.` which is not a known fleet handle → dropped (charset includes '.').
    expect(extractFleetMentions("see @bid.", FLEET)).toEqual([]);
    expect(extractFleetMentions("see @bid here", FLEET)).toEqual(["bid"]);
  });

  it("does not match an @handle without the @", () => {
    expect(extractFleetMentions("quill should do it", FLEET)).toEqual([]);
  });
});

describe("agent-registry/handoff — encode/parse round-trip", () => {
  it("encodes a chain as a structural marker prefix on the task", () => {
    const goal = encodeHandoffGoal(["scout", "quill"], "draft the post");
    expect(goal).toBe(`${HANDOFF_CHAIN_PREFIX}scout>quill] draft the post`);
  });

  it("returns the task unchanged for an empty chain (byte-identical to today)", () => {
    expect(encodeHandoffGoal([], "draft the post")).toBe("draft the post");
  });

  it("round-trips encode → parse", () => {
    const chain = ["scout", "quill", "echo"];
    const goal = encodeHandoffGoal(chain, "do the work");
    expect(parseHandoffChain(goal)).toEqual(chain);
  });

  it("parseHandoffChain returns [] when the marker is absent", () => {
    expect(parseHandoffChain("plain task with no marker")).toEqual([]);
  });

  it("parseHandoffChain returns [] on a malformed marker", () => {
    expect(parseHandoffChain("[handoff-chain: ] task")).toEqual([]);
    expect(parseHandoffChain("[handoff-chain scout>quill] task")).toEqual([]);
    expect(parseHandoffChain("[handoff-chain: scout> quill] task")).toEqual([]);
  });

  it("parseHandoffChain rejects ill-formed handle tokens in the marker", () => {
    expect(parseHandoffChain("[handoff-chain: scout>has space] task")).toEqual([]);
    expect(parseHandoffChain("[handoff-chain: scout>bad!handle] task")).toEqual([]);
  });

  it("only reads the marker from the start of the task", () => {
    expect(parseHandoffChain(`prefix ${HANDOFF_CHAIN_PREFIX}scout] task`)).toEqual([]);
  });
});
