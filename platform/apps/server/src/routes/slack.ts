import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { getChannel } from "../db/repositories/channels.js";
import { getWorkspaceMember } from "../db/repositories/members.js";
import {
  getSlackStatus,
  getSlackSecrets,
  setSlackConnection,
  clearSlackConnection,
  linkSlackChannel,
  linkSlackUser,
} from "../db/repositories/slack.js";
import { verifySlackSignature, SlackVerificationError } from "../slack/verify.js";
import { createDefaultSlackService } from "../slack/default.js";
import type { SlackEventService } from "../slack/service.js";
import { recordWebhookSignatureFailure } from "../observability/metrics.js";

/**
 * Slack-native routes (issue #170, ADR-0170). Two surfaces:
 *  - **Connect** (`/me/slack`, authenticated): the masked write-only vault — mirrors `/me/agent-credentials`
 *    (#68). The bot token + signing secret are write-only (stored sealed, never echoed); only the
 *    connected state + fingerprint come back. Plus the channel ↔ channel and user ↔ member link upserts.
 *  - **Webhooks** (`/slack/events/:wid`, `/slack/interact/:wid`, UNAUTHENTICATED but signature-verified):
 *    inbound Slack deliveries. Both register a RAW-body parser in an encapsulated plugin scope (the rest
 *    of the app keeps JSON parsing), 503 until the workspace is connected, and verify the Slack
 *    signature over the raw bytes before doing anything.
 */
export interface SlackRoutesOptions {
  /** The Slack bridge service (injected in tests with a fake client). Default: real wiring. */
  service?: SlackEventService;
}

export async function slackRoutes(app: FastifyInstance, opts: SlackRoutesOptions = {}): Promise<void> {
  const service = opts.service ?? createDefaultSlackService(app.log);

  // --- Settings → Connect Slack (#170): the per-tenant Slack app vault (masked write-only). ---

  // The connected/not-connected state. NEVER returns the bot token or signing secret.
  app.get("/me/slack", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    return getSlackStatus(identity.workspaceId);
  });

  // Connect (or re-connect) the workspace's Slack app. The bot token + signing secret are write-only —
  // stored sealed and never echoed back; only the connected state + fingerprint are returned. An
  // optional `slackUserId` links the connecting member so approval DMs + the digest reach their Slack.
  app.put("/me/slack", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const body = (req.body ?? {}) as {
      botToken?: unknown;
      signingSecret?: unknown;
      teamId?: unknown;
      botUserId?: unknown;
      slackUserId?: unknown;
    };
    const botToken = typeof body.botToken === "string" ? body.botToken.trim() : "";
    const signingSecret = typeof body.signingSecret === "string" ? body.signingSecret.trim() : "";
    if (!botToken) return reply.code(400).send({ error: "botToken required" });
    if (!signingSecret) return reply.code(400).send({ error: "signingSecret required" });
    const status = await setSlackConnection({
      workspaceId: identity.workspaceId,
      botToken,
      signingSecret,
      teamId: typeof body.teamId === "string" ? body.teamId : null,
      botUserId: typeof body.botUserId === "string" ? body.botUserId : null,
      connectedByMemberId: identity.memberId,
    });
    if (typeof body.slackUserId === "string" && body.slackUserId.trim()) {
      await linkSlackUser({
        workspaceId: identity.workspaceId,
        slackUserId: body.slackUserId.trim(),
        memberId: identity.memberId,
      });
    }
    return status;
  });

  // Disconnect the workspace's Slack app (idempotent). The cascade clears its links.
  app.delete("/me/slack", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    await clearSlackConnection(identity.workspaceId);
    return { connected: false, fingerprint: null, teamId: null, connectedAt: null };
  });

  // Link a Slack channel to a platform channel (the bridge map). The channel must be in the caller's
  // workspace (tenant-scoped; cross-tenant is a 404, never a leak).
  app.put("/me/slack/channel-link", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const body = (req.body ?? {}) as { slackChannelId?: unknown; channelId?: unknown };
    const slackChannelId = typeof body.slackChannelId === "string" ? body.slackChannelId.trim() : "";
    const channelId = typeof body.channelId === "string" ? body.channelId : "";
    if (!slackChannelId || !channelId) {
      return reply.code(400).send({ error: "slackChannelId and channelId required" });
    }
    const ch = await getChannel(channelId);
    if (!ch || ch.workspaceId !== identity.workspaceId) {
      return reply.code(404).send({ error: "channel not found" });
    }
    await linkSlackChannel({ workspaceId: identity.workspaceId, slackChannelId, channelId });
    return { ok: true };
  });

  // Link a Slack user to a platform member so their mentions/approvals round-trip to a real identity.
  app.put("/me/slack/user-link", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const body = (req.body ?? {}) as { slackUserId?: unknown; memberId?: unknown };
    const slackUserId = typeof body.slackUserId === "string" ? body.slackUserId.trim() : "";
    const memberId = typeof body.memberId === "string" && body.memberId ? body.memberId : identity.memberId;
    if (!slackUserId) return reply.code(400).send({ error: "slackUserId required" });
    const member = await getWorkspaceMember(memberId, identity.workspaceId);
    if (!member) return reply.code(404).send({ error: "member not found" });
    await linkSlackUser({ workspaceId: identity.workspaceId, slackUserId, memberId });
    return { ok: true };
  });

  // --- Inbound webhooks (raw body, signature-verified, unauthenticated) ---

  await app.register(async (webhookScope) => {
    const rawParser = (
      _req: unknown,
      body: Buffer,
      done: (err: Error | null, body?: unknown) => void,
    ): void => done(null, body);
    webhookScope.addContentTypeParser("application/json", { parseAs: "buffer" }, rawParser);
    webhookScope.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "buffer" },
      rawParser,
    );

    function rawBody(reqBody: unknown): string {
      return reqBody instanceof Buffer ? reqBody.toString("utf8") : String(reqBody ?? "");
    }

    async function verify(
      wid: string,
      reqBody: unknown,
      headers: Record<string, unknown>,
    ): Promise<{ ok: true; raw: string } | { ok: false; code: 503 | 400; error: string }> {
      const secrets = await getSlackSecrets(wid);
      if (!secrets) return { ok: false, code: 503, error: "slack not configured for this workspace" };
      const raw = rawBody(reqBody);
      const ts = headers["x-slack-request-timestamp"];
      const sig = headers["x-slack-signature"];
      try {
        verifySlackSignature(
          raw,
          typeof ts === "string" ? ts : undefined,
          typeof sig === "string" ? sig : undefined,
          secrets.signingSecret,
        );
      } catch (err) {
        if (err instanceof SlackVerificationError) return { ok: false, code: 400, error: err.message };
        throw err;
      }
      return { ok: true, raw };
    }

    // Slack Events API: app_mention → the existing #123 mention → session path.
    webhookScope.post("/slack/events/:wid", async (req, reply) => {
      const { wid } = req.params as { wid: string };
      const v = await verify(wid, req.body, req.headers as Record<string, unknown>);
      if (!v.ok && v.code === 400) {
        req.log.warn({ provider: "slack", workspaceId: wid, reason: v.error }, "webhook signature verification failed");
        recordWebhookSignatureFailure("slack", v.error);
      }
      if (!v.ok) return reply.code(v.code).send({ error: v.error });
      let payload: { type?: string; challenge?: string; event_id?: string; event?: Record<string, unknown> };
      try {
        payload = JSON.parse(v.raw) as typeof payload;
      } catch {
        return reply.code(400).send({ error: "invalid JSON body" });
      }
      // Slack's one-time endpoint verification handshake.
      if (payload.type === "url_verification") {
        return reply.send({ challenge: payload.challenge ?? "" });
      }
      if (payload.type === "event_callback") {
        const result = await service.handleEvent(wid, payload);
        return reply.send({ ok: true, status: result.status });
      }
      return reply.send({ ok: true });
    });

    // Slack interactivity: Approve/Reject button → the existing #13 decision path.
    webhookScope.post("/slack/interact/:wid", async (req, reply) => {
      const { wid } = req.params as { wid: string };
      const v = await verify(wid, req.body, req.headers as Record<string, unknown>);
      if (!v.ok && v.code === 400) {
        req.log.warn({ provider: "slack", workspaceId: wid, reason: v.error }, "webhook signature verification failed");
        recordWebhookSignatureFailure("slack", v.error);
      }
      if (!v.ok) return reply.code(v.code).send({ error: v.error });
      const form = new URLSearchParams(v.raw);
      const payloadStr = form.get("payload");
      if (!payloadStr) return reply.code(400).send({ error: "missing payload" });
      let payload: {
        user?: { id?: unknown };
        actions?: Array<{ action_id?: unknown; value?: unknown }>;
      };
      try {
        payload = JSON.parse(payloadStr) as typeof payload;
      } catch {
        return reply.code(400).send({ error: "invalid payload JSON" });
      }
      const result = await service.handleInteractivity(wid, payload);
      return reply.send({ text: result.ack });
    });
  });
}
