import { describe, it, expect } from "vitest";
import { loadEnv } from "../../src/env.js";

/** #83: SANDBOX_REPO_URL/SANDBOX_REPO_REVISION must reach the server config (not smoke-only). */
describe("loadEnv — sandbox git source (#83)", () => {
  it("parses SANDBOX_REPO_URL + SANDBOX_REPO_REVISION into agent.sandboxSource", () => {
    const env = loadEnv({
      SANDBOX_REPO_URL: "https://github.com/acme/app.git",
      SANDBOX_REPO_REVISION: "main",
    } as NodeJS.ProcessEnv);
    expect(env.agent.sandboxSource).toEqual({
      url: "https://github.com/acme/app.git",
      revision: "main",
    });
  });

  it("omits the revision when only the URL is set", () => {
    const env = loadEnv({ SANDBOX_REPO_URL: "https://github.com/acme/app.git" } as NodeJS.ProcessEnv);
    expect(env.agent.sandboxSource).toEqual({ url: "https://github.com/acme/app.git" });
  });

  it("is undefined when no repo is configured (empty sandbox — unchanged default)", () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    expect(env.agent.sandboxSource).toBeUndefined();
  });
});
