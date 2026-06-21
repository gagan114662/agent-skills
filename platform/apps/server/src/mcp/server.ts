import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Identity } from "../auth/identity.js";
import {
  requireChannelCapability,
  requireTaskInWorkspace,
  requireMemoryCapability,
  effectiveCapability,
} from "../auth/access.js";
import { listChannels, isChannelMember } from "../db/repositories/channels.js";
import { getCapability } from "../db/repositories/permissions.js";
import {
  postMessage,
  listChannelMessages,
  listThreadReplies,
  getMessage,
} from "../db/repositories/messages.js";
import { listMentionsForMember } from "../db/repositories/mentions.js";
import { searchMessages } from "../db/repositories/search.js";
import { listTasks, updateStatus, assignTask } from "../db/repositories/tasks.js";
import { getWorkspaceMember } from "../db/repositories/members.js";
import {
  upsertMemory,
  getMemory,
  listMemories,
  getNeighbors,
} from "../db/repositories/memories.js";
import { dedupeKey } from "../memory/dedupe.js";
import { isStatus, canTransition } from "../tasks/status.js";
import { notify } from "../notifications/service.js";
import { resolveThreadRoot } from "../messaging/threads.js";
import { deliverPostedMessage, deliverThreadReply } from "../messaging/delivery.js";
import { captureReply } from "./reply-capture.js";
import {
  createOutboundEmailSubmitter,
  type OutboundEmailSubmitter,
} from "../email/agent-outbound.js";
import {
  redisRealtimeSubscriptions,
  type RealtimeSubscriptions,
  type Unsubscribe,
} from "./realtime-subscriptions.js";

/**
 * The Reload MCP server (#10, ADR-0010). `createReloadMcpServer(identity, deps)` returns an
 * `McpServer` (official `@modelcontextprotocol/sdk`) whose tools/resources are **thin adapters** over
 * the existing repositories + access helpers — no tool re-implements an access check, opens its own
 * permission query, or touches the schema. The server is bound to one resolved identity (#3): the
 * HTTP bridge constructs one per session after authenticating the Bearer token; the unit test
 * constructs one with a fake identity over an in-memory transport.
 *
 * Access decisions reuse the exact REST guards via a reply-capturing shim (`captureReply`), so the
 * MCP and REST front doors can never disagree about who may do what.
 */

/** Stable resource URIs the server advertises and pushes updates for. */
export const MENTIONS_URI = "reload://mentions";
const CHANNEL_MESSAGES_TEMPLATE = "reload://channels/{channelId}/messages";

export interface McpServerDeps {
  /** Logger for best-effort delivery side-effects (#5/#6/#8). */
  logger: FastifyBaseLogger;
  /** Realtime source for resource-update pushes; injected so tests run Redis-free. */
  realtime?: RealtimeSubscriptions;
  /**
   * The #463 outbound-email submitter — queues a real email behind owner approval. Injected so the
   * hermetic unit test runs DB-free; defaults to the repository-backed submitter bound to this identity.
   */
  outboundEmail?: OutboundEmailSubmitter;
}

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/** A successful tool result: the data as pretty JSON text. */
function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/** A failed tool result (`isError`), carrying the access guard's own message where available. */
function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Build the configured MCP server for `identity`. */
export function createReloadMcpServer(identity: Identity, deps: McpServerDeps): McpServer {
  const log = deps.logger;
  const realtime = deps.realtime ?? redisRealtimeSubscriptions;
  const submitOutboundEmail = deps.outboundEmail ?? createOutboundEmailSubmitter(identity, log);
  const wid = identity.workspaceId;

  const mcp = new McpServer(
    { name: "reload", version: "1.0.0" },
    {
      instructions:
        "Reload — Slack for AI agents. You are connected as a workspace member. Use list_channels " +
        "to see what you can access, post_message/reply_thread to participate, search to find " +
        "messages, list_tasks/update_task for work, and read_memory/write_memory for shared memory. " +
        "Subscribe to the reload://mentions resource to be notified the moment you are @mentioned. " +
        "Every action is scoped to your workspace and respects your capabilities (read/write).",
    },
  );

  // --- tools -------------------------------------------------------------

  mcp.registerTool(
    "list_channels",
    {
      title: "List channels",
      description:
        "List the channels in your workspace you can access (effective capability ≥ read), each " +
        "annotated with your capability so you know whether you may post.",
      inputSchema: {},
    },
    async () => {
      const all = await listChannels(wid);
      const accessible = [];
      for (const ch of all) {
        const isMember = await isChannelMember(ch.id, identity.memberId);
        const explicit = await getCapability(wid, identity.memberId, "channel", ch.id);
        const capability = effectiveCapability(explicit, isMember);
        if (capability) {
          accessible.push({
            id: ch.id,
            name: ch.name,
            kind: ch.kind,
            isArchived: ch.isArchived,
            capability,
          });
        }
      }
      return ok(accessible);
    },
  );

  mcp.registerTool(
    "read_messages",
    {
      title: "Read messages",
      description:
        "Read a channel's messages (requires read on the channel). Pass threadRootId to read a " +
        "thread's replies instead; limit tails the most recent N.",
      inputSchema: {
        channelId: z.string().describe("The channel id (must be in your workspace)."),
        limit: z.number().int().positive().max(500).optional().describe("Tail the most recent N."),
        threadRootId: z
          .string()
          .optional()
          .describe("If set, return the replies under this thread root instead of the channel feed."),
      },
    },
    async ({ channelId, limit, threadRootId }) => {
      const cap = captureReply();
      const ch = await requireChannelCapability(identity, channelId, "read", cap.reply);
      if (!ch) return fail(cap.denial()?.body.error ?? "access denied");
      let messages;
      if (threadRootId) {
        const root = await getMessage(threadRootId);
        if (!root || root.channelId !== channelId) {
          return fail("thread root not found in this channel");
        }
        messages = await listThreadReplies(root.id);
      } else {
        messages = await listChannelMessages(channelId);
      }
      if (limit && messages.length > limit) messages = messages.slice(-limit);
      return ok(messages);
    },
  );

  mcp.registerTool(
    "post_message",
    {
      title: "Post a message",
      description:
        "Post a message to a channel (requires write). @handle tokens in the body create mentions. " +
        "Set parentMessageId to post within a thread. Delivers live to the web UI and notifies " +
        "mentioned members.",
      inputSchema: {
        channelId: z.string().describe("The channel id (must be in your workspace)."),
        body: z.string().min(1).describe("The message text. May contain @handle mentions."),
        parentMessageId: z.string().optional().describe("Reply target (flattened to the thread root)."),
      },
    },
    async ({ channelId, body, parentMessageId }) => {
      const cap = captureReply();
      const ch = await requireChannelCapability(identity, channelId, "write", cap.reply);
      if (!ch) return fail(cap.denial()?.body.error ?? "access denied");
      if (ch.isArchived) return fail("channel is archived");
      let parentId: string | undefined;
      let rootAuthorMemberId: string | undefined;
      if (parentMessageId) {
        const root = await resolveThreadRoot(parentMessageId, channelId);
        if (!root) return fail("parent message not found in this channel");
        parentId = root.id;
        rootAuthorMemberId = root.authorMemberId;
      }
      const message = await postMessage({
        workspaceId: wid,
        channelId,
        authorMemberId: identity.memberId,
        body,
        parentMessageId: parentId,
      });
      if (rootAuthorMemberId) {
        await deliverThreadReply(log, identity, ch, message, rootAuthorMemberId);
      } else {
        await deliverPostedMessage(log, identity, ch, message);
      }
      return ok(message);
    },
  );

  mcp.registerTool(
    "reply_thread",
    {
      title: "Reply in a thread",
      description:
        "Reply to a message within its thread (requires write). The reply always attaches to the " +
        "thread root. Set alsoSendToChannel to also surface it in the main channel feed.",
      inputSchema: {
        channelId: z.string().describe("The channel id (must be in your workspace)."),
        messageId: z.string().describe("The message to reply to (its thread root is used)."),
        body: z.string().min(1).describe("The reply text. May contain @handle mentions."),
        alsoSendToChannel: z
          .boolean()
          .optional()
          .describe("Also surface the reply in the channel feed (default false)."),
      },
    },
    async ({ channelId, messageId, body, alsoSendToChannel }) => {
      const cap = captureReply();
      const ch = await requireChannelCapability(identity, channelId, "write", cap.reply);
      if (!ch) return fail(cap.denial()?.body.error ?? "access denied");
      if (ch.isArchived) return fail("channel is archived");
      const root = await resolveThreadRoot(messageId, channelId);
      if (!root) return fail("parent message not found in this channel");
      const message = await postMessage({
        workspaceId: wid,
        channelId,
        authorMemberId: identity.memberId,
        body,
        parentMessageId: root.id,
        alsoSentToChannel: alsoSendToChannel ?? false,
      });
      await deliverThreadReply(log, identity, ch, message, root.authorMemberId);
      return ok(message);
    },
  );

  mcp.registerTool(
    "search",
    {
      title: "Search messages",
      description:
        "Full-text search over messages you can read (permission-scoped). Ranked by relevance then " +
        "recency. Optionally scope to one channel.",
      inputSchema: {
        query: z.string().min(1).describe("The search query (supports quotes, OR, -term)."),
        limit: z.number().int().positive().max(100).optional().describe("Max hits (default 20)."),
        channelId: z.string().optional().describe("Restrict to this channel."),
      },
    },
    async ({ query, limit, channelId }) => {
      const results = await searchMessages({
        workspaceId: wid,
        callerMemberId: identity.memberId,
        q: query,
        limit: limit ?? 20,
        offset: 0,
        channelId,
      });
      return ok(results);
    },
  );

  mcp.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description: "List your workspace's tasks. Optionally filter by status and/or assignee.",
      inputSchema: {
        status: z.string().optional().describe("Filter by lifecycle status."),
        assigneeMemberId: z.string().optional().describe("Filter to tasks assigned to this member."),
      },
    },
    async ({ status, assigneeMemberId }) => {
      if (status && !isStatus(status)) return fail("invalid status filter");
      const tasks = await listTasks(wid, {
        status: status && isStatus(status) ? status : undefined,
        assigneeMemberId,
      });
      return ok(tasks);
    },
  );

  mcp.registerTool(
    "update_task",
    {
      title: "Update a task",
      description:
        "Transition a task's status (validated) and/or (re)assign it. The task must be in your " +
        "workspace. Assigning notifies the new assignee.",
      inputSchema: {
        taskId: z.string().describe("The task id (must be in your workspace)."),
        status: z.string().optional().describe("New lifecycle status (validated transition)."),
        assigneeMemberId: z
          .string()
          .nullable()
          .optional()
          .describe("New assignee member id, or null to unassign."),
      },
    },
    async ({ taskId, status, assigneeMemberId }) => {
      const cap = captureReply();
      const task = await requireTaskInWorkspace(identity, taskId, cap.reply);
      if (!task) return fail(cap.denial()?.body.error ?? "task not found");
      let updated = task;
      if (status !== undefined) {
        if (!isStatus(status)) return fail("invalid status");
        if (!canTransition(task.status, status)) {
          return fail(`cannot transition from ${task.status} to ${status}`);
        }
        updated = await updateStatus(taskId, status, identity.memberId);
      }
      if (assigneeMemberId !== undefined) {
        if (assigneeMemberId) {
          const member = await getWorkspaceMember(assigneeMemberId, wid);
          if (!member) return fail("assignee not found in this workspace");
        }
        const prevAssignee = updated.assigneeMemberId;
        updated = await assignTask(taskId, assigneeMemberId ?? null, identity.memberId);
        if (assigneeMemberId && assigneeMemberId !== prevAssignee) {
          await notify(log, {
            workspaceId: wid,
            recipientMemberId: assigneeMemberId,
            type: "assignment",
            actorMemberId: identity.memberId,
            taskId,
            excerpt: updated.title,
          });
        }
      }
      return ok(updated);
    },
  );

  mcp.registerTool(
    "read_memory",
    {
      title: "Read shared memory",
      description:
        "Read the workspace's shared memory graph (requires read on memory). Pass id for one node " +
        "plus its neighbors; otherwise filter by type and/or entity.",
      inputSchema: {
        id: z.string().optional().describe("A specific memory node id (returns it + neighbors)."),
        type: z.string().optional().describe("Filter nodes by type."),
        entity: z.string().optional().describe("Filter nodes by entity."),
      },
    },
    async ({ id, type, entity }) => {
      const cap = captureReply();
      if (!(await requireMemoryCapability(identity, wid, "read", cap.reply))) {
        return fail(cap.denial()?.body.error ?? "access denied");
      }
      if (id) {
        const node = await getMemory(wid, id);
        if (!node) return fail("memory not found");
        const neighbors = await getNeighbors(wid, id);
        return ok({ memory: node, ...neighbors });
      }
      return ok(await listMemories(wid, { type, entity }));
    },
  );

  mcp.registerTool(
    "write_memory",
    {
      title: "Write shared memory",
      description:
        "Create a typed node in the workspace's shared memory graph (requires write on memory). " +
        "Deduplicated: an identical node is merged rather than duplicated.",
      inputSchema: {
        type: z.string().min(1).describe("The node type (e.g. decision, fact, preference)."),
        text: z.string().min(1).describe("The node text."),
        entity: z.string().optional().describe("An optional entity this node is about."),
      },
    },
    async ({ type, text, entity }) => {
      const cap = captureReply();
      if (!(await requireMemoryCapability(identity, wid, "write", cap.reply))) {
        return fail(cap.denial()?.body.error ?? "access denied");
      }
      const ent = entity ?? null;
      const r = await upsertMemory({
        workspaceId: wid,
        type,
        content: { text },
        entity: ent,
        dedupeKey: dedupeKey(type, text, ent),
        sourceType: "manual",
        createdByMemberId: identity.memberId,
      });
      return ok({ ...(await getMemory(wid, r.id)), created: r.created });
    },
  );

  mcp.registerTool(
    "send_outbound_email",
    {
      title: "Send an outbound email",
      description:
        "Reach a real person OUTSIDE your workspace — a prospect, customer, or partner — by email. " +
        "This does not send right away: it queues the exact recipient, subject, and body for an owner " +
        "to approve in the decision queue, and the email is delivered for real only once they approve. " +
        "Use this to actually follow up and ship, instead of leaving a draft for someone to copy out.",
      inputSchema: {
        to: z.string().describe("The recipient's email address (a single address)."),
        subject: z.string().min(1).describe("The subject line."),
        body: z.string().min(1).describe("The email body."),
      },
    },
    async ({ to, subject, body }) => {
      const result = await submitOutboundEmail({ to, subject, body });
      if (!result.ok) return fail(result.error);
      return ok({
        status: "pending_approval",
        requestId: result.requestId,
        summary: result.summary,
        message:
          "Queued for owner approval. The email will be sent for real once a human approves it in the " +
          "decision queue — nothing leaves until then.",
      });
    },
  );

  // --- resources (read + subscribe) -------------------------------------

  mcp.registerResource(
    "mentions",
    MENTIONS_URI,
    {
      title: "Your @mentions",
      description: "Every message that @mentioned you in your workspace, newest first. Subscribable.",
      mimeType: "application/json",
    },
    async (uri) => {
      const mentions = await listMentionsForMember(wid, identity.memberId);
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(mentions, null, 2) }],
      };
    },
  );

  mcp.registerResource(
    "channel-messages",
    new ResourceTemplate(CHANNEL_MESSAGES_TEMPLATE, { list: undefined }),
    {
      title: "Channel messages",
      description: "A channel's messages (requires read on the channel). Subscribable.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const channelId = String(variables.channelId);
      const cap = captureReply();
      const ch = await requireChannelCapability(identity, channelId, "read", cap.reply);
      if (!ch) throw new Error(cap.denial()?.body.error ?? "access denied");
      const messages = await listChannelMessages(channelId);
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(messages, null, 2) }],
      };
    },
  );

  // --- resource subscriptions (#10): bridge onto the #5 realtime bus ----
  // McpServer registers only resources.listChanged; we add `subscribe` and the subscribe/unsubscribe
  // handlers ourselves, turning a realtime event into `notifications/resources/updated`.
  const server = mcp.server;
  server.registerCapabilities({ resources: { subscribe: true } });

  const subscriptions = new Map<string, Unsubscribe>();
  const dispose = (): void => {
    for (const off of subscriptions.values()) {
      try {
        off();
      } catch {
        /* best-effort teardown */
      }
    }
    subscriptions.clear();
  };

  server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    const uri = request.params.uri;
    if (subscriptions.has(uri)) return {};
    const notifyUpdated = (): void => {
      void server.sendResourceUpdated({ uri }).catch(() => {
        /* the client may have disconnected mid-push */
      });
    };
    if (uri === MENTIONS_URI) {
      subscriptions.set(uri, realtime.subscribeMentions(wid, identity.memberId, notifyUpdated));
      return {};
    }
    const match = /^reload:\/\/channels\/([^/]+)\/messages$/.exec(uri);
    if (match) {
      const channelId = match[1]!;
      const cap = captureReply();
      const ch = await requireChannelCapability(identity, channelId, "read", cap.reply);
      if (!ch) throw new Error(cap.denial()?.body.error ?? "access denied");
      subscriptions.set(uri, realtime.subscribeChannel(channelId, notifyUpdated));
      return {};
    }
    throw new Error(`cannot subscribe to unknown resource: ${uri}`);
  });

  server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    const off = subscriptions.get(request.params.uri);
    if (off) {
      off();
      subscriptions.delete(request.params.uri);
    }
    return {};
  });

  const prevOnClose = server.onclose;
  server.onclose = (): void => {
    dispose();
    prevOnClose?.();
  };

  return mcp;
}
