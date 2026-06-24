import { afterEach, describe, expect, it, vi } from "vitest";
import { FlyInfraProvider } from "../../src/venture-deploy/fly-provider.js";
import { VercelInfraProvider } from "../../src/venture-deploy/vercel-provider.js";
import type { ProvisionTargetInput } from "../../src/venture-deploy/provider.js";

function res(status: number, body = ""): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

function input(over: Partial<ProvisionTargetInput> = {}): ProvisionTargetInput {
  return {
    workspaceId: "ws1",
    ventureId: "v1",
    slug: "acme-11111111",
    env: {},
    secrets: {},
    onLog: vi.fn(),
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("venture deploy provider retries (#965)", () => {
  it("retries a transient Vercel project-create 5xx before succeeding", async () => {
    vi.stubEnv("VERCEL_TOKEN", "vc-token");
    const fetchMock = vi.fn().mockResolvedValueOnce(res(503, "busy")).mockResolvedValueOnce(res(200));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new VercelInfraProvider().provisionTarget(input())).resolves.toMatchObject({
      projectId: "acme-11111111",
      prodUrl: "https://acme-11111111.vercel.app",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces a clear Vercel error after persistent transient failures", async () => {
    vi.stubEnv("VERCEL_TOKEN", "vc-token");
    const fetchMock = vi.fn(async () => res(503, "busy"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new VercelInfraProvider().provisionTarget(input())).rejects.toThrow(
      "vercel project create failed for acme-11111111: 503 busy",
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a transient Fly app-create 5xx before marking the target ready", async () => {
    vi.stubEnv("VENTURE_DEPLOY_FLY_TOKEN", "fly-token");
    vi.stubEnv("VENTURE_DEPLOY_FLY_ORG", "acme");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(502, "bad gateway"))
      .mockResolvedValueOnce(res(201))
      .mockResolvedValueOnce(res(201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new FlyInfraProvider().provisionTarget(input())).resolves.toMatchObject({
      projectId: "acme-11111111",
      prodUrl: "https://acme-11111111.fly.dev",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

