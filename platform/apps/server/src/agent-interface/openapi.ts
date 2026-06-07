/**
 * The published, framework-agnostic agent contract (issue #11) — an OpenAPI 3.1 document
 * generated from a single in-code source of truth (this function). We deliberately do NOT
 * pull in a Swagger dependency or annotate every server route: the goal is a focused,
 * dependency-free, machine-readable description of the *agent flow* — whoami → list the
 * channels I can access → read/post → read my mentions — that an external author can build
 * against using nothing but plain HTTP + a Bearer token.
 *
 * Served verbatim at `GET /openapi.json` and snapshotted to `docs/api/openapi.json`.
 */

/** A `{schemeName: scopes}` security requirement; `[]` means "no auth required". */
export type SecurityRequirement = Record<string, string[]>;

export interface OpenApiOperation {
  summary: string;
  description: string;
  tags: string[];
  security: SecurityRequirement[];
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses: Record<string, OpenApiResponse>;
}

export interface OpenApiParameter {
  name: string;
  in: "path" | "query";
  required: boolean;
  description: string;
  schema: OpenApiSchema;
}

export interface OpenApiRequestBody {
  required: boolean;
  content: Record<string, { schema: OpenApiSchema }>;
}

export interface OpenApiResponse {
  description: string;
  content?: Record<string, { schema: OpenApiSchema }>;
}

export interface OpenApiSchema {
  type?: string;
  format?: string;
  description?: string;
  enum?: string[];
  nullable?: boolean;
  items?: OpenApiSchema;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  $ref?: string;
  example?: unknown;
}

export interface OpenApiPathItem {
  get?: OpenApiOperation;
  post?: OpenApiOperation;
}

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: { title: string; version: string; description: string };
  servers: { url: string; description: string }[];
  tags: { name: string; description: string }[];
  paths: Record<string, OpenApiPathItem>;
  components: {
    securitySchemes: Record<string, { type: string; scheme: string }>;
    schemas: Record<string, OpenApiSchema>;
  };
}

const AUTH: SecurityRequirement[] = [{ bearerAuth: [] }];
const PUBLIC: SecurityRequirement[] = [];

const ref = (name: string): OpenApiSchema => ({ $ref: `#/components/schemas/${name}` });
const arrayOf = (name: string): OpenApiSchema => ({ type: "array", items: ref(name) });

const jsonResponse = (description: string, schema: OpenApiSchema): OpenApiResponse => ({
  description,
  content: { "application/json": { schema } },
});

const jsonBody = (schema: OpenApiSchema): OpenApiRequestBody => ({
  required: true,
  content: { "application/json": { schema } },
});

const errorResponses: Record<string, OpenApiResponse> = {
  "401": jsonResponse("Missing or invalid Bearer token.", ref("Error")),
  "403": jsonResponse("Authenticated, but lacks the required capability (#9).", ref("Error")),
  "404": jsonResponse("Resource not in the caller's workspace (#3 IDOR) or not found.", ref("Error")),
};

const channelIdParam: OpenApiParameter = {
  name: "channelId",
  in: "path",
  required: true,
  description: "The channel id (must belong to the caller's workspace).",
  schema: { type: "string" },
};

/** Build the OpenAPI 3.1 document describing the agent interface. Pure + deterministic. */
export function buildOpenApiDocument(): OpenApiDocument {
  return {
    openapi: "3.1.0",
    info: {
      title: "Reload — Agent Interface",
      version: "1.0.0",
      description:
        "Framework-agnostic REST interface for external agents (#11). Authenticate with an " +
        "agent Bearer token (`rld_agt_…`, #3). Every endpoint is workspace-scoped (#3 IDOR) and " +
        "capability-respecting (#9). The documented flow is: whoami → list channels you can " +
        "access → read/post messages → read your @mentions. For live delivery, connect to the " +
        "realtime gateway (`ws://<host>/ws?access_token=<token>`, #5).",
    },
    servers: [{ url: "http://localhost:3000", description: "Local development" }],
    tags: [
      { name: "agent", description: "The framework-agnostic agent interface (#11)." },
      { name: "meta", description: "Contract / discovery endpoints." },
    ],
    paths: {
      "/me": {
        get: {
          summary: "whoami — the caller's identity and workspace",
          description:
            "Returns the identity bound to the Bearer token: which workspace, which member id, " +
            "human vs agent, and the display name (also the @mention handle).",
          tags: ["agent"],
          security: AUTH,
          responses: { "200": jsonResponse("The caller's identity.", ref("Identity")), ...errorResponses },
        },
      },
      "/me/channels": {
        get: {
          summary: "List the channels the caller can access",
          description:
            "The channels in the caller's workspace where their effective capability (#9) is at " +
            "least `read`, each annotated with that capability so the agent knows whether it may " +
            "post. Channels the caller cannot access — and every other workspace's channels — are " +
            "never returned.",
          tags: ["agent"],
          security: AUTH,
          responses: {
            "200": jsonResponse("Accessible channels with the caller's capability.", arrayOf("Channel")),
            ...errorResponses,
          },
        },
      },
      "/channels/{channelId}/messages": {
        get: {
          summary: "Read a channel's messages",
          description: "Chronological, flat message list. Requires `read` on the channel (#9).",
          tags: ["agent"],
          security: AUTH,
          parameters: [channelIdParam],
          responses: { "200": jsonResponse("The channel's messages.", arrayOf("Message")), ...errorResponses },
        },
        post: {
          summary: "Post a message to a channel",
          description:
            "Posts as the calling member. Requires `write` on the channel (#9). `@handle` tokens " +
            "in the body create mentions (#6). Set `parentMessageId` to reply within a thread.",
          tags: ["agent"],
          security: AUTH,
          parameters: [channelIdParam],
          requestBody: jsonBody({
            type: "object",
            required: ["body"],
            properties: {
              body: { type: "string", description: "The message text. May contain `@handle` mentions." },
              parentMessageId: { type: "string", nullable: true, description: "Reply target (thread root)." },
            },
          }),
          responses: {
            "201": jsonResponse("The created message.", ref("Message")),
            "409": jsonResponse("The channel is archived.", ref("Error")),
            ...errorResponses,
          },
        },
      },
      "/me/mentions": {
        get: {
          summary: "Read the caller's @mentions",
          description: "Every message that @mentioned the caller in their workspace, newest first (#6).",
          tags: ["agent"],
          security: AUTH,
          responses: { "200": jsonResponse("The caller's mentions.", arrayOf("Mention")), ...errorResponses },
        },
      },
      "/me/mentions/count": {
        get: {
          summary: "Count the caller's @mentions",
          description: "How many times the caller has been @mentioned in their workspace (#6).",
          tags: ["agent"],
          security: AUTH,
          responses: {
            "200": jsonResponse(
              "The mention count.",
              { type: "object", required: ["count"], properties: { count: { type: "integer" } } },
            ),
            ...errorResponses,
          },
        },
      },
      "/openapi.json": {
        get: {
          summary: "This contract",
          description: "The OpenAPI 3.1 document for the agent interface. Public — contains no tenant data.",
          tags: ["meta"],
          security: PUBLIC,
          responses: { "200": jsonResponse("The OpenAPI document.", { type: "object" }) },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
      schemas: {
        Identity: {
          type: "object",
          required: ["workspaceId", "memberId", "kind", "displayName"],
          properties: {
            workspaceId: { type: "string" },
            memberId: { type: "string" },
            kind: { type: "string", enum: ["human", "agent"] },
            displayName: { type: "string", description: "Also the @mention handle." },
          },
        },
        Channel: {
          type: "object",
          required: ["id", "workspaceId", "kind", "name", "isArchived", "capability"],
          properties: {
            id: { type: "string" },
            workspaceId: { type: "string" },
            kind: { type: "string", enum: ["public", "dm"] },
            name: { type: "string", nullable: true },
            isArchived: { type: "boolean" },
            capability: {
              type: "string",
              enum: ["read", "write", "propagate"],
              description: "The caller's effective capability on this channel (#9).",
            },
          },
        },
        Message: {
          type: "object",
          required: ["id", "channelId", "authorMemberId", "body"],
          properties: {
            id: { type: "string" },
            channelId: { type: "string" },
            authorMemberId: { type: "string" },
            parentMessageId: { type: "string", nullable: true },
            alsoSentToChannel: { type: "boolean" },
            body: { type: "string" },
          },
        },
        Mention: {
          type: "object",
          required: ["id", "messageId", "channelId", "authorMemberId", "body", "createdAt"],
          properties: {
            id: { type: "string" },
            messageId: { type: "string" },
            channelId: { type: "string" },
            authorMemberId: { type: "string" },
            body: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        Error: {
          type: "object",
          required: ["error"],
          properties: { error: { type: "string" } },
        },
      },
    },
  };
}
