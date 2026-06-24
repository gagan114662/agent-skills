import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { WebSocketServer, WebSocket } from "ws";
import { getRedis } from "../redis/index.js";
import type { Identity } from "../auth/identity.js";
import { resolveIdentityFromCredentials } from "../auth/middleware.js";
import { getChannel, isChannelMember } from "../db/repositories/channels.js";
import { extractWsCredentials } from "./auth.js";
import { encodeEvent, parseClientCommand, type PresenceStatus } from "./protocol.js";
import {
  CHANNEL_PATTERN,
  PRESENCE_PATTERN,
  MENTION_PATTERN,
  NOTIFY_PATTERN,
  CLOUD_WS_PATTERN,
  channelIdFromKey,
  cloudWorkspaceIdFromKey,
  presenceHashKey,
  publishPresence,
  publishWorkspacePresence,
  RealtimeRedisTimeoutError,
  withRealtimeRedisTimeout,
  workspaceIdFromPresenceKey,
  workspaceIdFromMentionKey,
  workspaceIdFromNotifyKey,
} from "./bus.js";
import { resolveCloudWorkspaceCapability } from "../auth/access.js";
import { recordRedisPubSubTimeout } from "../observability/metrics.js";
import type { ServerEvent } from "./protocol.js";

const WS_PATH = "/ws";

/** A live socket plus the channels it's subscribed to + cloud workspaces it watches (#55). */
interface Conn {
  ws: WebSocket;
  identity: Identity;
  channels: Set<string>;
  watching: Set<string>;
}

/**
 * Attach the realtime WebSocket gateway (#5) to the Fastify HTTP server.
 *
 * - Authenticates each `/ws` upgrade with the same identity model as REST (#3).
 * - Subscribe is gated by #4 channel membership; events are workspace-scoped.
 * - Cross-instance fan-out is via Redis pub/sub: REST publishes on write, and each
 *   process `PSUBSCRIBE`s once (lazily, on the first connection — so REST/inject tests
 *   and the no-Redis CI job never open a Redis socket).
 */
export function attachRealtime(app: FastifyInstance): void {
  const wss = new WebSocketServer({ noServer: true });

  // Local routing tables for this process.
  const byChannel = new Map<string, Set<Conn>>();
  const byWorkspace = new Map<string, Set<Conn>>();
  // Member-targeted routing for mentions (#6), keyed `${workspaceId}:${memberId}` — a mention
  // reaches only the mentioned member's sockets, regardless of channel subscription.
  const byMember = new Map<string, Set<Conn>>();
  // How many local sockets a member has open, keyed `${workspaceId}:${memberId}` — drives
  // presence online/offline on first-connect / last-disconnect.
  const memberSocketCount = new Map<string, number>();
  // Watchers of a shared cloud workspace (#55), keyed by cloud workspace id.
  const byCloudWorkspace = new Map<string, Set<Conn>>();
  // How many watches a member holds on a cloud workspace, keyed `${cloudWorkspaceId}:${memberId}` —
  // drives shared-workspace presence joined/left on first-watch / last-unwatch.
  const cloudWatchCount = new Map<string, number>();

  let subscriber: Redis | undefined;
  let subscriberReady: Promise<void> | undefined;

  function addTo(map: Map<string, Set<Conn>>, key: string, conn: Conn): void {
    let set = map.get(key);
    if (!set) map.set(key, (set = new Set()));
    set.add(conn);
  }
  function removeFrom(map: Map<string, Set<Conn>>, key: string, conn: Conn): void {
    const set = map.get(key);
    if (!set) return;
    set.delete(conn);
    if (set.size === 0) map.delete(key);
  }
  function forward(set: Set<Conn> | undefined, payload: string): void {
    if (!set) return;
    for (const { ws } of set) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  /** Lazily create the dedicated subscriber connection and PSUBSCRIBE for fan-out. */
  function ensureSubscriber(): Promise<void> {
    if (!subscriberReady) {
      subscriberReady = (async () => {
        const sub = getRedis().duplicate();
        const subscribe = sub.psubscribe(
          CHANNEL_PATTERN,
          PRESENCE_PATTERN,
          MENTION_PATTERN,
          NOTIFY_PATTERN,
          CLOUD_WS_PATTERN,
        );
        subscribe.catch(() => undefined);
        try {
          await withRealtimeRedisTimeout("psubscribe", subscribe);
        } catch (err) {
          sub.disconnect();
          subscriber = undefined;
          subscriberReady = undefined;
          if (err instanceof RealtimeRedisTimeoutError) {
            recordRedisPubSubTimeout("psubscribe");
            app.log.error({ err }, "redis pub/sub subscriber init timed out");
          }
          throw err;
        }
        sub.on("pmessage", (_pattern, key, payload) => {
          const channelId = channelIdFromKey(key);
          if (channelId) return forward(byChannel.get(channelId), payload);
          const cloudWsId = cloudWorkspaceIdFromKey(key);
          if (cloudWsId) return routeCloudWorkspaceEvent(cloudWsId, payload);
          const presenceWid = workspaceIdFromPresenceKey(key);
          if (presenceWid) return forward(byWorkspace.get(presenceWid), payload);
          const mentionWid = workspaceIdFromMentionKey(key);
          if (mentionWid) {
            // Mentions are member-targeted: deliver only to the mentioned member's sockets.
            const event = JSON.parse(payload) as ServerEvent;
            if (event.type === "mention") {
              forward(byMember.get(`${mentionWid}:${event.mention.mentionedMemberId}`), payload);
            }
            return;
          }
          const notifyWid = workspaceIdFromNotifyKey(key);
          if (notifyWid) {
            // Notifications are recipient-targeted: deliver only to the recipient's sockets (#8).
            const event = JSON.parse(payload) as ServerEvent;
            if (event.type === "notification") {
              forward(byMember.get(`${notifyWid}:${event.notification.recipientMemberId}`), payload);
            }
          }
        });
        subscriber = sub;
      })();
    }
    return subscriberReady;
  }

  async function setPresence(
    workspaceId: string,
    memberId: string,
    status: PresenceStatus,
  ): Promise<void> {
    const redis = getRedis();
    if (status === "offline") await redis.hdel(presenceHashKey(workspaceId), memberId);
    else await redis.hset(presenceHashKey(workspaceId), memberId, status);
    await publishPresence(workspaceId, memberId, status);
  }

  /**
   * Route a cloud-workspace event (#55) to local watchers. `workspace_presence` fans out to every
   * watcher; `access_revoked` (carrying a target member id) drops THAT member's live watch and
   * notifies them — so a revoke cuts access in real time, even cross-instance.
   */
  function routeCloudWorkspaceEvent(cloudWorkspaceId: string, payload: string): void {
    let event: { type?: string; memberId?: string };
    try {
      event = JSON.parse(payload) as { type?: string; memberId?: string };
    } catch {
      return;
    }
    if (event.type === "workspace_presence") {
      return forward(byCloudWorkspace.get(cloudWorkspaceId), payload);
    }
    if (event.type === "access_revoked" && event.memberId) {
      const set = byCloudWorkspace.get(cloudWorkspaceId);
      if (!set) return;
      const clean = encodeEvent({ type: "access_revoked", cloudWorkspaceId });
      for (const conn of [...set]) {
        if (conn.identity.memberId !== event.memberId) continue;
        dropWatch(conn, cloudWorkspaceId);
        if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(clean);
      }
    }
  }

  /** Remove one connection's watch on a cloud workspace, emitting `left` presence on the last one. */
  function dropWatch(conn: Conn, cloudWorkspaceId: string): void {
    if (!conn.watching.has(cloudWorkspaceId)) return;
    conn.watching.delete(cloudWorkspaceId);
    removeFrom(byCloudWorkspace, cloudWorkspaceId, conn);
    const key = `${cloudWorkspaceId}:${conn.identity.memberId}`;
    const count = (cloudWatchCount.get(key) ?? 1) - 1;
    if (count <= 0) {
      cloudWatchCount.delete(key);
      void publishWorkspacePresence({
        cloudWorkspaceId,
        memberId: conn.identity.memberId,
        status: "left",
      }).catch((err) => app.log.error({ err }, "workspace presence left failed"));
    } else {
      cloudWatchCount.set(key, count);
    }
  }

  async function onConnection(ws: WebSocket, identity: Identity): Promise<void> {
    const conn: Conn = { ws, identity, channels: new Set(), watching: new Set() };
    addTo(byWorkspace, identity.workspaceId, conn);

    const memberKey = `${identity.workspaceId}:${identity.memberId}`;
    addTo(byMember, memberKey, conn);
    const prev = memberSocketCount.get(memberKey) ?? 0;
    memberSocketCount.set(memberKey, prev + 1);
    if (prev === 0) {
      // first socket for this member → announce online
      await setPresence(identity.workspaceId, identity.memberId, "online").catch((err) =>
        app.log.error({ err }, "presence online failed"),
      );
    }

    ws.send(encodeEvent({ type: "ready", memberId: identity.memberId, workspaceId: identity.workspaceId }));

    ws.on("message", (data) => {
      // A command handler must never silently swallow an error — that would hang the client with
      // no reply. Log it and send a generic error so the socket stays responsive.
      handleCommand(conn, data.toString()).catch((err) => {
        app.log.error({ err }, "ws command handler failed");
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(encodeEvent({ type: "error", code: "bad_request", detail: "command failed" }));
        }
      });
    });

    ws.on("close", () => {
      for (const channelId of conn.channels) removeFrom(byChannel, channelId, conn);
      for (const cloudWorkspaceId of [...conn.watching]) dropWatch(conn, cloudWorkspaceId);
      removeFrom(byWorkspace, identity.workspaceId, conn);
      removeFrom(byMember, memberKey, conn);
      const count = (memberSocketCount.get(memberKey) ?? 1) - 1;
      if (count <= 0) {
        memberSocketCount.delete(memberKey);
        void setPresence(identity.workspaceId, identity.memberId, "offline").catch((err) =>
          app.log.error({ err }, "presence offline failed"),
        );
      } else {
        memberSocketCount.set(memberKey, count);
      }
    });
  }

  async function handleCommand(conn: Conn, raw: string): Promise<void> {
    const cmd = parseClientCommand(raw);
    if (!cmd) {
      conn.ws.send(encodeEvent({ type: "error", code: "bad_request", detail: "unparseable command" }));
      return;
    }

    switch (cmd.type) {
      case "subscribe": {
        const channel = await getChannel(cmd.channelId);
        if (!channel || channel.workspaceId !== conn.identity.workspaceId) {
          conn.ws.send(encodeEvent({ type: "error", code: "not_found", detail: "channel not found" }));
          return;
        }
        if (!(await isChannelMember(cmd.channelId, conn.identity.memberId))) {
          conn.ws.send(encodeEvent({ type: "error", code: "forbidden", detail: "not a channel member" }));
          return;
        }
        conn.channels.add(cmd.channelId);
        addTo(byChannel, cmd.channelId, conn);
        conn.ws.send(encodeEvent({ type: "subscribed", channelId: cmd.channelId }));
        return;
      }
      case "unsubscribe": {
        conn.channels.delete(cmd.channelId);
        removeFrom(byChannel, cmd.channelId, conn);
        conn.ws.send(encodeEvent({ type: "unsubscribed", channelId: cmd.channelId }));
        return;
      }
      case "presence": {
        await setPresence(conn.identity.workspaceId, conn.identity.memberId, cmd.status).catch((err) =>
          app.log.error({ err }, "presence update failed"),
        );
        return;
      }
      case "watch": {
        // Gate on collaborator access (#9): only an owner/active collaborator may watch (#55).
        const access = await resolveCloudWorkspaceCapability(conn.identity, cmd.cloudWorkspaceId);
        if (!access) {
          conn.ws.send(
            encodeEvent({ type: "error", code: "forbidden", detail: "no access to cloud workspace" }),
          );
          return;
        }
        if (!conn.watching.has(cmd.cloudWorkspaceId)) {
          conn.watching.add(cmd.cloudWorkspaceId);
          addTo(byCloudWorkspace, cmd.cloudWorkspaceId, conn);
          const key = `${cmd.cloudWorkspaceId}:${conn.identity.memberId}`;
          const prev = cloudWatchCount.get(key) ?? 0;
          cloudWatchCount.set(key, prev + 1);
          if (prev === 0) {
            await publishWorkspacePresence({
              cloudWorkspaceId: cmd.cloudWorkspaceId,
              memberId: conn.identity.memberId,
              status: "joined",
            }).catch((err) => app.log.error({ err }, "workspace presence joined failed"));
          }
        }
        conn.ws.send(encodeEvent({ type: "watching", cloudWorkspaceId: cmd.cloudWorkspaceId }));
        return;
      }
      case "unwatch": {
        dropWatch(conn, cmd.cloudWorkspaceId);
        conn.ws.send(encodeEvent({ type: "unwatched", cloudWorkspaceId: cmd.cloudWorkspaceId }));
        return;
      }
      case "ping":
        conn.ws.send(encodeEvent({ type: "pong" }));
        return;
    }
  }

  // Manual upgrade handling so we can authenticate before opening the socket and reject
  // unauthenticated clients with a real HTTP 401.
  app.server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== WS_PATH) return; // not ours; leave for any other handler / let it hang up

    void (async () => {
      const identity = await resolveIdentityFromCredentials(extractWsCredentials(req));
      if (!identity) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      try {
        await ensureSubscriber();
      } catch (err) {
        app.log.error({ err }, "ws upgrade rejected: realtime subscriber unavailable");
        socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        void onConnection(ws, identity);
      });
    })().catch(() => {
      socket.destroy();
    });
  });

  app.addHook("onClose", async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    if (subscriber) subscriber.disconnect();
  });
}
