import { describe, expect, it } from "vitest";
import { resolvePublishReadiness } from "../../src/realworld/publish/status.js";

describe("real-world publish readiness (#872)", () => {
  it("surfaces dry-run as not live so customers are not told fake URLs are reachable", () => {
    expect(resolvePublishReadiness("dryrun")).toEqual({
      provider: "dryrun",
      live: false,
      dryRun: true,
    });
  });

  it("surfaces GitHub Pages as a live publish provider", () => {
    expect(resolvePublishReadiness("github_pages")).toEqual({
      provider: "github_pages",
      live: true,
      dryRun: false,
    });
  });
});
