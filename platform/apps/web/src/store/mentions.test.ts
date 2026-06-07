import { describe, expect, it } from "vitest";
import { activeMentionQuery, applyMentionSelection } from "./mentions.js";

describe("activeMentionQuery", () => {
  it("returns the partial handle being typed at the caret", () => {
    expect(activeMentionQuery("hello @at", 9)).toBe("at");
  });

  it("returns an empty string right after a bare @ (show all)", () => {
    expect(activeMentionQuery("hello @", 7)).toBe("");
  });

  it("returns null when there is no active @ token", () => {
    expect(activeMentionQuery("hello world", 11)).toBeNull();
  });

  it("returns null once the token is closed by a space", () => {
    expect(activeMentionQuery("@bob done", 9)).toBeNull();
  });

  it("ignores an @ preceded by a word char (e.g. an email)", () => {
    expect(activeMentionQuery("user@host", 9)).toBeNull();
  });

  it("reads the token at a caret in the middle of the text", () => {
    expect(activeMentionQuery("hi @Alice", 6)).toBe("Al");
  });
});

describe("applyMentionSelection", () => {
  it("replaces the partial token with @displayName and a trailing space", () => {
    expect(applyMentionSelection("hi @al", 6, "Alice")).toEqual({
      text: "hi @Alice ",
      caret: 10,
    });
  });

  it("does not double the space when the next char is already a space", () => {
    expect(applyMentionSelection("hi @al world", 6, "Alice")).toEqual({
      text: "hi @Alice world",
      caret: 9,
    });
  });

  it("is a no-op when there is no active mention token", () => {
    expect(applyMentionSelection("hi there", 8, "Alice")).toEqual({
      text: "hi there",
      caret: 8,
    });
  });
});
