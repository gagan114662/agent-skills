import { describe, expect, it } from "vitest";
import { resolveApiBaseUrl, resolveWsUrl } from "./config.js";

describe("api config", () => {
  it("falls back to api.ipop.ai on the live ipop.ai split deployment when no build env is set", () => {
    expect(resolveApiBaseUrl({ configuredBaseUrl: "", hostname: "ipop.ai" })).toBe("https://api.ipop.ai");
    expect(resolveApiBaseUrl({ configuredBaseUrl: "", hostname: "www.ipop.ai" })).toBe("https://api.ipop.ai");
  });

  it("keeps same-origin API paths for local and preview hosts when no build env is set", () => {
    expect(resolveApiBaseUrl({ configuredBaseUrl: "", hostname: "localhost" })).toBe("");
    expect(resolveApiBaseUrl({ configuredBaseUrl: "", hostname: "agent-skills-sigma.vercel.app" })).toBe("");
  });

  it("prefers an explicit build-time API base URL and trims trailing slashes", () => {
    expect(resolveApiBaseUrl({ configuredBaseUrl: "https://staging-api.example.com///", hostname: "ipop.ai" })).toBe(
      "https://staging-api.example.com",
    );
  });

  it("derives websocket URLs from the resolved API base URL", () => {
    expect(resolveWsUrl("/ws", { configuredBaseUrl: "", hostname: "ipop.ai", protocol: "https:", host: "ipop.ai" })).toBe(
      "wss://api.ipop.ai/ws",
    );
    expect(
      resolveWsUrl("/ws", {
        configuredBaseUrl: "",
        hostname: "localhost",
        protocol: "http:",
        host: "localhost:5173",
      }),
    ).toBe("ws://localhost:5173/ws");
  });
});
