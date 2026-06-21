import { describe, it, expect } from "vitest";
import { detectDirectedHandles } from "../../../src/messaging/natural-address.js";

describe("detectDirectedHandles (#471 natural addressing)", () => {
  describe("directed forms DO match (the reported bug)", () => {
    it("picks up the reported 'QA test for scout:' form", () => {
      expect(detectDirectedHandles("QA test for scout: crawl the homepage and report")).toContain("scout");
    });

    it("matches a leading address before a comma", () => {
      expect(detectDirectedHandles("Scout, can you audit the blog?")).toEqual(["scout"]);
    });

    it("matches a leading address before a colon", () => {
      expect(detectDirectedHandles("quill: draft a post about onboarding")).toEqual(["quill"]);
    });

    it("matches an explicit directive verb + name", () => {
      expect(detectDirectedHandles("ask Scout to look at our Core Web Vitals")).toEqual(["scout"]);
      expect(detectDirectedHandles("hey quill can you write this up")).toEqual(["quill"]);
      expect(detectDirectedHandles("cc lens on the analytics question")).toEqual(["lens"]);
    });

    it("lowercases and de-duplicates", () => {
      expect(detectDirectedHandles("Scout, ask Scout to double check with SCOUT")).toEqual(["scout"]);
    });

    it("captures both a leading address and a later directive", () => {
      expect(detectDirectedHandles("Scout, then tell quill to write it")).toEqual(["scout", "quill"]);
    });
  });

  describe("ordinary prose does NOT match (no accidental launches)", () => {
    it("a name used as a verb/word in prose is not an address", () => {
      expect(detectDirectedHandles("we should scout out the competition this week")).toEqual([]);
    });

    it("a name mid-sentence without a directive is not an address", () => {
      expect(detectDirectedHandles("I think scout already covered the homepage")).toEqual([]);
    });

    it("'for the record' / non-name directive objects yield tokens that resolution will drop", () => {
      // 'for the' fires the directive pattern → token 'the'; harmless because 'the' is not a real member.
      expect(detectDirectedHandles("for the record, this is fine")).toEqual(["the"]);
    });

    it("returns [] for empty / plain bodies", () => {
      expect(detectDirectedHandles("")).toEqual([]);
      expect(detectDirectedHandles("plain message, nothing here")).toEqual([]);
    });

    it("never throws on odd input", () => {
      expect(detectDirectedHandles(":,:,:")).toEqual([]);
      expect(detectDirectedHandles("ask ")).toEqual([]);
    });
  });
});
