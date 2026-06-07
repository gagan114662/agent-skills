import { describe, it, expect } from "vitest";
import { buildOpenApiDocument } from "../../src/agent-interface/openapi.js";

/**
 * The published agent contract (#11) is generated from a single in-code source of truth
 * (`buildOpenApiDocument`) — no Swagger dependency. These hermetic checks assert the
 * document is a valid OpenAPI 3.1 spec covering the documented agent flow:
 * whoami → list channels → read/post → read mentions.
 */
describe("buildOpenApiDocument (agent OpenAPI contract)", () => {
  const doc = buildOpenApiDocument();

  it("is an OpenAPI 3.1 document with info + a Bearer security scheme", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toMatch(/reload/i);
    expect(typeof doc.info.version).toBe("string");
    expect(doc.components.securitySchemes.bearerAuth).toEqual({
      type: "http",
      scheme: "bearer",
    });
  });

  it("documents every step of the agent flow", () => {
    // whoami
    expect(doc.paths["/me"].get).toBeDefined();
    // list channels I can access (the one new convenience endpoint)
    expect(doc.paths["/me/channels"].get).toBeDefined();
    // read + post messages
    expect(doc.paths["/channels/{channelId}/messages"].get).toBeDefined();
    expect(doc.paths["/channels/{channelId}/messages"].post).toBeDefined();
    // read mentions
    expect(doc.paths["/me/mentions"].get).toBeDefined();
    expect(doc.paths["/me/mentions/count"].get).toBeDefined();
  });

  it("defines the core schemas, including the capability annotation on a channel", () => {
    expect(doc.components.schemas.Identity).toBeDefined();
    expect(doc.components.schemas.Message).toBeDefined();
    expect(doc.components.schemas.Mention).toBeDefined();
    // /me/channels annotates each channel with the caller's effective capability (#9)
    expect(doc.components.schemas.Channel.properties.capability).toBeDefined();
  });

  it("requires bearer auth on the agent endpoints (whoami) and not on the spec itself", () => {
    expect(doc.paths["/me"].get.security).toEqual([{ bearerAuth: [] }]);
    // the spec document carries no tenant data and is the only public route
    expect(doc.paths["/openapi.json"].get.security).toEqual([]);
  });

  it("serializes to JSON (it is what GET /openapi.json returns)", () => {
    expect(() => JSON.stringify(doc)).not.toThrow();
  });
});
