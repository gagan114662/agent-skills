import { describe, it, expect } from "vitest";
import { parseMentionTokens } from "../../src/messaging/mentions.js";

describe("parseMentionTokens", () => {
  it("extracts a single @handle", () => {
    expect(parseMentionTokens("hey @scout can you look?")).toEqual(["scout"]);
  });

  it("extracts multiple distinct handles in order of first appearance", () => {
    expect(parseMentionTokens("@alice and @bob, see this")).toEqual(["alice", "bob"]);
  });

  it("lowercases and de-duplicates repeated handles", () => {
    expect(parseMentionTokens("@Scout @scout @SCOUT")).toEqual(["scout"]);
  });

  it("supports dotted, dashed and underscored handles", () => {
    expect(parseMentionTokens("ping @code-bot @data_ops @a.b")).toEqual([
      "code-bot",
      "data_ops",
      "a.b",
    ]);
  });

  it("does NOT treat an email address as a mention (must not be preceded by a word char)", () => {
    expect(parseMentionTokens("mail me at user@host.com please")).toEqual([]);
  });

  it("handles handles at the very start of the body", () => {
    expect(parseMentionTokens("@lead ship it")).toEqual(["lead"]);
  });

  it("stops the handle at punctuation/whitespace boundaries", () => {
    expect(parseMentionTokens("(@alice), @bob! @carol?")).toEqual(["alice", "bob", "carol"]);
  });

  it("ignores a bare @ with no handle", () => {
    expect(parseMentionTokens("just an @ sign and email@ too")).toEqual([]);
  });

  it("returns the self token (self-exclusion is the resolver's job, not the parser's)", () => {
    expect(parseMentionTokens("note to self @me")).toEqual(["me"]);
  });

  it("returns an empty array for a body with no mentions", () => {
    expect(parseMentionTokens("plain message, nothing here")).toEqual([]);
  });

  it("never throws on odd input", () => {
    expect(parseMentionTokens("")).toEqual([]);
    expect(parseMentionTokens("@")).toEqual([]);
    expect(parseMentionTokens("@@@@")).toEqual([]);
  });
});
