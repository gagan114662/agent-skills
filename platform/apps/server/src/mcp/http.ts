import type { ServerResponse } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { resolveIdentityFromCredentials, SESSION_COOKIE } from "../auth/middleware.js";
import type { Identity } from "../auth/identity.js";
import { newId } from "../db/id.js";
import { createReloadMcpServer } from "./server.js";
import type { RealtimeSubscriptions } from "./realtime-subscriptions.js";
import type { BrowserSessionOpener } from "../runtime/browser/agent-bridge.js";
import type { BrowserCaps } from "../runtime/browser/caps.js";

/**
 * The MCP transport endpoint (#10, ADR-0010 decisions 3–4): a **stateful Streamable HTTP** server at
 * `POST|GET|DELETE /mcp`. Every request is authenticated with the existing agent Bearer token (#3,
 * the same resolver REST + the #5 gateway use) *before* the SDK transport handles it; the session is
 * bound to the identity captured at `initialize`, so a request bearing a different member's token is
 * rejected. Fastify hands the raw Node streams (`req.raw`/`reply.raw`) to the SDK transport after
 * `reply.hijack()`. All open sessions are closed on server shutdown.
 */

export interface McpRoutesOptions {
  /** Realtime source for resource-update pushes; injected in tests. Defaults to the Redis bus. */
  realtime?: RealtimeSubscriptions;
  /**
   * Optional #388 browser bridge. Default absent/disabled, so production does not expose computer-use
   * tools unless the deploy explicitly wires a manager + enabled caps.
   */
  browser?: {
    manager: BrowserSessionOpener;
    caps: BrowserCaps;
    target?: string;
  };
}

/** A live session: its transport plus the member it was opened for (session-binding guard). */
interface Session {
  transport: StreamableHTTPServerTransport;
  memberId: string;
}

/** Write a JSON-RPC error directly to a hijacked response. */
function writeRpcError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

export async function mcpRoutes(app: FastifyInstance, opts: McpRoutesOptions = {}): Promise<void> {
  const sessions = new Map<string, Session>();

  /** Resolve the Bearer/cookie credentials to an identity, or send 401 and return undefined. */
  async function authenticate(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Identity | undefined> {
    const identity = await resolveIdentityFromCredentials({
      authorization: req.headers.authorization,
      sessionToken: req.cookies?.[SESSION_COOKIE],
    });
    if (!identity) {
      await reply.code(401).send({ error: "unauthorized" });
      return undefined;
    }
    return identity;
  }

  // JSON-RPC requests (and the `initialize` handshake that opens a session).
  app.post("/mcp", async (req, reply) => {
    const identity = await authenticate(req, reply);
    if (!identity) return;
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    reply.hijack();
    try {
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (!session) return writeRpcError(reply.raw, 404, "unknown session");
        if (session.memberId !== identity.memberId) {
          return writeRpcError(reply.raw, 403, "session does not belong to this token");
        }
        await session.transport.handleRequest(req.raw, reply.raw, req.body);
        return;
      }
      if (isInitializeRequest(req.body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newId(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, { transport, memberId: identity.memberId });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        const server = createReloadMcpServer(identity, {
          logger: app.log,
          realtime: opts.realtime,
          browser: opts.browser
            ? {
                ...opts.browser,
                sessionId: `mcp-browser-${transport.sessionId ?? newId()}`,
              }
            : undefined,
        });
        await server.connect(transport);
        await transport.handleRequest(req.raw, reply.raw, req.body);
        return;
      }
      writeRpcError(reply.raw, 400, "no valid session id; send an initialize request first");
    } catch (err) {
      app.log.error({ err }, "mcp POST failed");
      writeRpcError(reply.raw, 500, "internal error");
    }
  });

  // GET opens the server→client SSE stream; DELETE tears the session down. Both require a session.
  async function handleExistingSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const identity = await authenticate(req, reply);
    if (!identity) return;
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      await reply.code(404).send({ error: "unknown session" });
      return;
    }
    if (session.memberId !== identity.memberId) {
      await reply.code(403).send({ error: "session does not belong to this token" });
      return;
    }
    reply.hijack();
    try {
      await session.transport.handleRequest(req.raw, reply.raw);
    } catch (err) {
      app.log.error({ err }, "mcp session request failed");
      writeRpcError(reply.raw, 500, "internal error");
    }
  }

  app.get("/mcp", handleExistingSession);
  app.delete("/mcp", handleExistingSession);

  // Drain all sessions on shutdown so no SSE stream or Redis subscriber leaks past server close.
  app.addHook("onClose", async () => {
    const open = [...sessions.values()];
    sessions.clear();
    for (const session of open) {
      try {
        await session.transport.close();
      } catch {
        /* best-effort */
      }
    }
  });
}
