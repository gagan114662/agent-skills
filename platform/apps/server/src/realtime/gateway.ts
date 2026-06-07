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
  channelIdFromKey,
  presenceHashKey,
  publishPresence,
  workspaceIdFromPresenceKey,
} from "./bus.js";

const WS_PATH = "/ws";

/** A live socket plus the channels it's subscribed to (local to this process). */
interface Conn {
  ws: WebSocket;
  identity: Identity;
  channels: Set<string>;
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
  // How many local sockets a member has open, keyed `${workspaceId}:${memberId}` — drives
  // presence online/offline on first-connect / last-disconnect.
  const memberSocketCount = new Map<string, number>();

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
        await sub.psubscribe(CHANNEL_PATTERN, PRESENCE_PATTERN);
        sub.on("pmessage", (_pattern, key, payload) => {
          const channelId = channelIdFromKey(key);
          if (channelId) return forward(byChannel.get(channelId), payload);
          const workspaceId = workspaceIdFromPresenceKey(key);
          if (workspaceId) forward(byWorkspace.get(workspaceId), payload);
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

  async function onConnection(ws: WebSocket, identity: Identity): Promise<void> {
    const conn: Conn = { ws, identity, channels: new Set() };
    addTo(byWorkspace, identity.workspaceId, conn);

    const memberKey = `${identity.workspaceId}:${identity.memberId}`;
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
      void handleCommand(conn, data.toString());
    });

    ws.on("close", () => {
      for (const channelId of conn.channels) removeFrom(byChannel, channelId, conn);
      removeFrom(byWorkspace, identity.workspaceId, conn);
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
      await ensureSubscriber();
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
