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

const workspaceIdParam: OpenApiParameter = {
  name: "workspaceId",
  in: "path",
  required: true,
  description: "The caller's workspace id.",
  schema: { type: "string" },
};

const approvalIdParam: OpenApiParameter = {
  name: "approvalId",
  in: "path",
  required: true,
  description: "The approval request id (must belong to the caller's workspace).",
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
      { name: "governance", description: "Human approval gates for sensitive agent actions (#13)." },
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
      "/workspaces/{workspaceId}/approvals": {
        get: {
          summary: "List approval requests (audit log)",
          description:
            "The workspace's approval requests, newest first (#13). Filter with `?status=` " +
            "(pending|approved|rejected|expired|auto_approved) or `?requestedBy=<memberId>`. " +
            "Workspace-scoped (#3) — only the caller's workspace is ever visible.",
          tags: ["governance"],
          security: AUTH,
          parameters: [
            workspaceIdParam,
            { name: "status", in: "query", required: false, description: "Filter by status.", schema: { type: "string", enum: ["pending", "approved", "rejected", "expired", "auto_approved"] } },
            { name: "requestedBy", in: "query", required: false, description: "Filter by requesting member id.", schema: { type: "string" } },
          ],
          responses: {
            "200": jsonResponse("The workspace's approval requests.", arrayOf("ApprovalRequest")),
            ...errorResponses,
          },
        },
        post: {
          summary: "Request approval for a sensitive action",
          description:
            "Submit an action (the preview a human approves). The policy engine decides: a gated " +
            "action is recorded `pending` and NOT executed (humans are notified); an ungated action " +
            "is `auto_approved` and executed immediately. Either way an audit row is returned (#13).",
          tags: ["governance"],
          security: AUTH,
          parameters: [workspaceIdParam],
          requestBody: jsonBody({
            type: "object",
            required: ["actionKind", "summary"],
            properties: {
              actionKind: { type: "string", enum: ["external_send", "spend", "channel_post", "custom"] },
              summary: { type: "string", description: "Human-readable description of the action." },
              amountCents: { type: "integer", description: "For `spend`: amount in minor units." },
              currency: { type: "string", description: "For `spend`: ISO 4217 code (audit only)." },
              channelId: { type: "string", description: "For `channel_post`: the target channel (must be in-workspace)." },
              destination: { type: "string", description: "For `external_send`: where data is going (audit only)." },
            },
          }),
          responses: {
            "201": jsonResponse("The persisted approval request (pending or auto_approved).", ref("ApprovalRequest")),
            ...errorResponses,
          },
        },
      },
      "/workspaces/{workspaceId}/approvals/{approvalId}": {
        get: {
          summary: "Read one approval request",
          description: "A single approval request + its decision — the preview/audit read (#13).",
          tags: ["governance"],
          security: AUTH,
          parameters: [workspaceIdParam, approvalIdParam],
          responses: {
            "200": jsonResponse("The approval request.", ref("ApprovalRequest")),
            ...errorResponses,
          },
        },
      },
      "/workspaces/{workspaceId}/governance-policy": {
        get: {
          summary: "Read the workspace governance policy",
          description:
            "The policy that decides what needs approval — external sends, spend threshold, guarded " +
            "channels, always-gated kinds, and the request TTL. Defaults apply when unset (#13).",
          tags: ["governance"],
          security: AUTH,
          parameters: [workspaceIdParam],
          responses: {
            "200": jsonResponse("The workspace governance policy.", ref("GovernancePolicy")),
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
        ApprovalRequest: {
          type: "object",
          required: ["id", "workspaceId", "requestedByMemberId", "actionKind", "actionSummary", "status", "createdAt"],
          properties: {
            id: { type: "string" },
            workspaceId: { type: "string" },
            requestedByMemberId: { type: "string" },
            actionKind: { type: "string", enum: ["external_send", "spend", "channel_post", "custom"] },
            actionSummary: { type: "string", description: "The human-readable preview." },
            action: { type: "object", description: "The opaque action descriptor (amount/destination/etc.)." },
            channelId: { type: "string", nullable: true },
            status: {
              type: "string",
              enum: ["pending", "approved", "rejected", "expired", "auto_approved"],
              description: "pending → approved|rejected|expired; auto_approved is the ungated terminal.",
            },
            policyReason: { type: "string", nullable: true, description: "Why the policy gated (or auto-approved) the action." },
            decidedByMemberId: { type: "string", nullable: true },
            decisionReason: { type: "string", nullable: true },
            outcome: { type: "string", nullable: true, description: "The executor's result after an approved/auto action ran." },
            createdAt: { type: "string", format: "date-time" },
            decidedAt: { type: "string", format: "date-time", nullable: true },
            executedAt: { type: "string", format: "date-time", nullable: true },
            expiresAt: { type: "string", format: "date-time", nullable: true },
          },
        },
        GovernancePolicy: {
          type: "object",
          required: ["externalSendRequiresApproval", "spendThresholdCents", "guardedChannelIds", "requireApprovalFor", "defaultTtlMs"],
          properties: {
            externalSendRequiresApproval: { type: "boolean", description: "Every external_send needs approval." },
            spendThresholdCents: { type: "integer", description: "A spend strictly above this needs approval." },
            guardedChannelIds: { type: "array", items: { type: "string" }, description: "channel_post into one of these needs approval." },
            requireApprovalFor: {
              type: "array",
              items: { type: "string", enum: ["external_send", "spend", "channel_post", "custom"] },
              description: "Action kinds that always need approval.",
            },
            defaultTtlMs: { type: "integer", description: "TTL applied to a new pending request." },
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
