import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { loadConfig } from "../config/loader.js";
import { loadStateSecret, newStateNonce } from "../auth/oauth-state.js";
import {
  CONNECTION_DESCRIPTORS,
  EMAIL_CONNECTION_ID,
  getConnectionDescriptor,
  IMESSAGE_CONNECTION_ID,
  TELEGRAM_ROOM_CONNECTION_ID,
  type ConnectionDescriptor,
} from "../connections/registry.js";
import { decideApprovedConnectRequest, mapExchangeToSeal } from "../connections/connect.js";
import { signConnectState, verifyConnectState } from "../connections/state.js";
import { ConnectProviderError, isValidAuthCode } from "../connections/provider.js";
import {
  decideConnectionView,
  decideInternalConnect,
  decideOneClickConnect,
  decideWaitlist,
} from "../connections/view.js";
import { verifyConnectionHealth } from "../connections/health.js";
import {
  createDefaultConnectOnceService,
  defaultConnectProvider,
  googleAdsConnectionOAuthConfigStatus,
  googleConnectionOAuthConfigStatus,
  linkedInConnectionOAuthConfigStatus,
  metaAdsConnectionOAuthConfigStatus,
  xConnectionOAuthConfigStatus,
} from "../connections/default.js";
import { getRequest, recordExecution } from "../db/repositories/approvals.js";
import {
  listServiceStatuses,
  setServiceCredentials,
  revokeServiceCredentials,
} from "../db/repositories/external-credentials.js";

/**
 * Connections routes (#258) — the OAuth-first "connect once, the agents do the rest" surface. All
 * `/me/*`-scoped to the caller's workspace (#3).
 *
 *  - `GET /me/connections` lists what the workspace can connect. Customer connectors (consumer OAuth:
 *    "Sign in with Google", "Connect X", "Connect your website") are always listed; the INTERNAL GitHub
 *    site-publish connector is listed ONLY for the owner/admin workspace — a non-technical customer never
 *    sees a repo, a PR, or a token.
 *  - `POST /me/connections/:id/connect` is the INTERNAL paste path (admin only): it seals a GitHub token +
 *    repo into the encrypted #192 vault so `publish_site` no longer needs a Fly server secret. It refuses
 *    a non-owner and refuses an OAuth (customer) connector outright.
 *  - `POST /me/connections/:id/oauth/start` is the consumer-OAuth seam. The live redirect flow is a
 *    follow-up; today it 501s with `status: "coming_soon"` or `status: "blocked"` so the UI is honest.
 *    The model is already OAuth-shaped, so the redirect slots in here without re-modelling.
 *
 * Connecting is a one-time CONSENT, not money — so it carries no #13 gate (consistent with #243 money-only
 * and the #192 non-money connects). Real spend through a connected channel stays money-gated, unchanged.
 */
const CONNECTION_RETURN_PATH = "/everyday";
const POSTMARK_SERVICE_KEY = "postmark";
const POSTMARK_TOKEN_KEY = "POSTMARK_SERVER_TOKEN";
const POSTMARK_FROM_KEYS = ["POSTMARK_FROM", "POSTMARK_FROM_ADDRESS", "POSTMARK_SENDER"] as const;
const POSTMARK_AUTH_RESULTS_HEADER_KEY = "POSTMARK_AUTH_RESULTS_HEADER";
const IMESSAGE_ENABLED_KEYS = ["IMESSAGE_RELAY_ENABLED"] as const;
const IMESSAGE_DRY_RUN_KEYS = ["IMESSAGE_RELAY_DRY_RUN"] as const;
const IMESSAGE_MACOS_HOST_KEYS = ["IMESSAGE_RELAY_MACOS_HOST"] as const;
const TELEGRAM_BOT_TOKEN_KEY = "TELEGRAM_BOT_TOKEN";
const TELEGRAM_ROOM_CHAT_ID_KEY = "TELEGRAM_ROOM_CHAT_ID";
const TELEGRAM_CHAT_ID_KEY = "TELEGRAM_CHAT_ID";
const TELEGRAM_WEBHOOK_SECRET_KEY = "TELEGRAM_WEBHOOK_SECRET";

function oauthSetupStatus(id: string):
  | ReturnType<typeof googleConnectionOAuthConfigStatus>
  | ReturnType<typeof googleAdsConnectionOAuthConfigStatus>
  | ReturnType<typeof metaAdsConnectionOAuthConfigStatus>
  | ReturnType<typeof linkedInConnectionOAuthConfigStatus>
  | ReturnType<typeof xConnectionOAuthConfigStatus>
  | null {
  if (id === "google" && !googleConnectionOAuthConfigStatus().configured) {
    return googleConnectionOAuthConfigStatus();
  }
  if (id === "google_ads" && !googleAdsConnectionOAuthConfigStatus().configured) {
    return googleAdsConnectionOAuthConfigStatus();
  }
  if (id === "meta_ads" && !metaAdsConnectionOAuthConfigStatus().configured) {
    return metaAdsConnectionOAuthConfigStatus();
  }
  if (id === "linkedin" && !linkedInConnectionOAuthConfigStatus().configured) {
    return linkedInConnectionOAuthConfigStatus();
  }
  if (id === "x" && !xConnectionOAuthConfigStatus().configured) {
    return xConnectionOAuthConfigStatus();
  }
  return null;
}

function oauthMissingConfigCode(id: string): string {
  if (id === "x") return "x_connection_oauth_missing_config";
  if (id === "google_ads") return "google_ads_connection_oauth_missing_config";
  if (id === "meta_ads") return "meta_ads_connection_oauth_missing_config";
  if (id === "linkedin") return "linkedin_connection_oauth_missing_config";
  return "google_connection_oauth_missing_config";
}

function firstEnv(keys: readonly string[]): string {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return "";
}

function emailProviderProofSecrets(workspaceId: string): Record<string, string> {
  const reach = loadConfig(workspaceId).reach;
  if (reach?.sendProvider !== "postmark" || reach.liveSendEnabled !== true) return {};
  const token = process.env[POSTMARK_TOKEN_KEY]?.trim() ?? "";
  const from = firstEnv(POSTMARK_FROM_KEYS);
  if (!token || !from) return {};
  return {
    [POSTMARK_TOKEN_KEY]: token,
    POSTMARK_FROM: from,
    ...(process.env[POSTMARK_AUTH_RESULTS_HEADER_KEY]?.trim()
      ? {
          [POSTMARK_AUTH_RESULTS_HEADER_KEY]: process.env[POSTMARK_AUTH_RESULTS_HEADER_KEY]!.trim(),
        }
      : {}),
  };
}

function telegramProviderProofSecrets(): Record<string, string> {
  const botToken = process.env[TELEGRAM_BOT_TOKEN_KEY]?.trim() ?? "";
  const chatId = process.env[TELEGRAM_ROOM_CHAT_ID_KEY]?.trim() ?? "";
  const webhookSecret = process.env[TELEGRAM_WEBHOOK_SECRET_KEY]?.trim() ?? "";
  if (!botToken || !chatId || !webhookSecret) return {};
  return {
    [TELEGRAM_CHAT_ID_KEY]: chatId,
  };
}

export async function connectionsRoutes(app: FastifyInstance): Promise<void> {
  function isOwnerWorkspace(workspaceId: string): boolean {
    return loadConfig(workspaceId).marketing.ownerWorkspaceId === workspaceId;
  }

  async function connectionProofs(workspaceId: string): Promise<
    Map<
      string,
      {
        connected: boolean;
        envKeys: string[];
        fingerprint: string;
        connectedAtMs: number;
      }
    >
  > {
    const rows = await listServiceStatuses(workspaceId);
    const proofs = new Map(
      rows.map((r) => [
        r.serviceKey,
        {
          connected: r.status === "connected",
          envKeys: r.envKeys,
          fingerprint: r.fingerprint,
          connectedAtMs: r.connectedAtMs,
        },
      ]),
    );
    const postmark = proofs.get(POSTMARK_SERVICE_KEY);
    if (postmark?.connected) proofs.set(EMAIL_CONNECTION_ID, postmark);
    return proofs;
  }

  function runtimeDescriptors(): ConnectionDescriptor[] {
    return CONNECTION_DESCRIPTORS.map((descriptor) => {
      if (descriptor.id === IMESSAGE_CONNECTION_ID) {
        const enabled =
          process.env.IMESSAGE_RELAY_ENABLED === "true" ||
          process.env.IMESSAGE_RELAY_ENABLED === "1";
        const dryRun =
          process.env.IMESSAGE_RELAY_DRY_RUN === "true" ||
          process.env.IMESSAGE_RELAY_DRY_RUN === "1";
        const macosHost = process.platform === "darwin" && process.env.IMESSAGE_RELAY_MACOS_HOST === "1";
        if (enabled && !dryRun && macosHost) {
          return {
            ...descriptor,
            status: "available",
            summary:
              "Send the team room to Apple Messages after you add and verify your iMessage email or phone.",
          };
        }
        const requiresMacHost = enabled && !dryRun && !macosHost;
        return {
          ...descriptor,
          configIssue: {
            code: requiresMacHost
              ? "imessage_relay_requires_macos_host"
              : dryRun
                ? "imessage_relay_dry_run"
                : "imessage_relay_disabled",
            missingEnv: requiresMacHost
              ? [...IMESSAGE_MACOS_HOST_KEYS]
              : enabled
                ? [...IMESSAGE_DRY_RUN_KEYS]
                : [...IMESSAGE_ENABLED_KEYS],
            remedy: requiresMacHost
              ? "Run the Apple Messages relay on a logged-in macOS host before offering this connector; Fly/Linux cannot run osascript."
              : dryRun
                ? "Set IMESSAGE_RELAY_DRY_RUN=0 and verify the macOS Messages relay host before offering this connector."
                : "Set IMESSAGE_RELAY_ENABLED=1 on a logged-in macOS relay host that can run osascript against Messages.",
          },
        };
      }
      if (descriptor.id === TELEGRAM_ROOM_CONNECTION_ID) {
        const missing = [
          ...(process.env[TELEGRAM_BOT_TOKEN_KEY]?.trim() ? [] : [TELEGRAM_BOT_TOKEN_KEY]),
          ...(process.env[TELEGRAM_ROOM_CHAT_ID_KEY]?.trim() ? [] : [TELEGRAM_ROOM_CHAT_ID_KEY]),
          ...(process.env[TELEGRAM_WEBHOOK_SECRET_KEY]?.trim() ? [] : [TELEGRAM_WEBHOOK_SECRET_KEY]),
        ];
        if (missing.length === 0) {
          return {
            ...descriptor,
            status: "available",
            summary:
              "Mirror the agent room into the configured Telegram chat with signed webhook replies back into ipop.",
          };
        }
        return {
          ...descriptor,
          configIssue: {
            code: "telegram_room_missing_config",
            missingEnv: missing,
            remedy:
              "Set TELEGRAM_BOT_TOKEN, TELEGRAM_ROOM_CHAT_ID, and TELEGRAM_WEBHOOK_SECRET, then configure Telegram to send webhooks with X-Telegram-Bot-Api-Secret-Token.",
          },
        };
      }
      if (descriptor.auth !== "oauth") return descriptor;
      const provider = defaultConnectProvider(descriptor.id);
      if (provider.live) return { ...descriptor, status: "available" };
      if (descriptor.id === "google") {
        const status = googleConnectionOAuthConfigStatus();
        return {
          ...descriptor,
          configIssue: status.configured
            ? undefined
            : {
                code: "google_connection_oauth_missing_config",
                missingEnv: status.missing,
                remedy:
                  "Set GOOGLE_CONNECTION_OAUTH_REDIRECT_URI to the deployed /me/connections/google/oauth/callback URL and add that exact URI to the Google OAuth client.",
            },
        };
      }
      if (descriptor.id === "x") {
        const status = xConnectionOAuthConfigStatus();
        return {
          ...descriptor,
          configIssue: status.configured
            ? undefined
            : {
                code: "x_connection_oauth_missing_config",
                missingEnv: status.missing,
                remedy:
                  "Set X_OAUTH_CLIENT_ID, X_OAUTH_CLIENT_SECRET, and X_CONNECTION_OAUTH_REDIRECT_URI to the deployed /me/connections/x/oauth/callback URL, then add that exact URI to the X app.",
            },
        };
      }
      if (descriptor.id === "google_ads") {
        const status = googleAdsConnectionOAuthConfigStatus();
        return {
          ...descriptor,
          configIssue: status.configured
            ? undefined
            : {
                code: "google_ads_connection_oauth_missing_config",
                missingEnv: status.missing,
                remedy:
                  "Set GOOGLE_ADS_CONNECTION_OAUTH_REDIRECT_URI to the deployed /me/connections/google_ads/oauth/callback URL and add that exact URI to the Google OAuth client.",
            },
        };
      }
      if (descriptor.id === "meta_ads") {
        const status = metaAdsConnectionOAuthConfigStatus();
        return {
          ...descriptor,
          configIssue: status.configured
            ? undefined
            : {
                code: "meta_ads_connection_oauth_missing_config",
                missingEnv: status.missing,
                remedy:
                  "Set META_OAUTH_CLIENT_ID, META_OAUTH_CLIENT_SECRET, and META_ADS_CONNECTION_OAUTH_REDIRECT_URI to the deployed /me/connections/meta_ads/oauth/callback URL, then add that exact URI to the Meta app.",
            },
        };
      }
      if (descriptor.id === "linkedin") {
        const status = linkedInConnectionOAuthConfigStatus();
        return {
          ...descriptor,
          configIssue: status.configured
            ? undefined
            : {
                code: "linkedin_connection_oauth_missing_config",
                missingEnv: status.missing,
                remedy:
                  "Set LINKEDIN_OAUTH_CLIENT_ID, LINKEDIN_OAUTH_CLIENT_SECRET, and LINKEDIN_CONNECTION_OAUTH_REDIRECT_URI to the deployed /me/connections/linkedin/oauth/callback URL, then add that exact absolute URL to the LinkedIn app.",
              },
        };
      }
      return descriptor;
    });
  }

  function runtimeDescriptor(id: string): ConnectionDescriptor | undefined {
    return runtimeDescriptors().find((descriptor) => descriptor.id === id);
  }

  // What this workspace can connect (+ which are already connected). Read-only, never a secret.
  app.get("/me/connections", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const wid = identity.workspaceId;
    const isOwner = isOwnerWorkspace(wid);
    const connections = decideConnectionView({
      descriptors: runtimeDescriptors(),
      proofs: await connectionProofs(wid),
      isOwner,
    });
    return { connections, canManageInternal: isOwner };
  });

  // INTERNAL paste connect (admin only): seal the GitHub token + repo into the encrypted vault.
  app.post("/me/connections/:id/connect", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const wid = identity.workspaceId;
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { repo?: unknown; token?: unknown; baseBranch?: unknown };
    const decision = decideInternalConnect({
      descriptor: getConnectionDescriptor(id),
      isOwner: isOwnerWorkspace(wid),
      repo: typeof body.repo === "string" ? body.repo : undefined,
      token: typeof body.token === "string" ? body.token : undefined,
      baseBranch: typeof body.baseBranch === "string" ? body.baseBranch : undefined,
    });
    if (!decision.ok) return reply.code(400).send({ error: decision.reason });
    await setServiceCredentials({
      workspaceId: wid,
      serviceKey: decision.serviceKey,
      secrets: decision.secrets,
      scopes: decision.scopes,
      connectedByMemberId: identity.memberId,
    });
    // Re-read so the caller sees the freshly-connected state — never the secret.
    const connections = decideConnectionView({
      descriptors: runtimeDescriptors(),
      proofs: await connectionProofs(wid),
      isOwner: isOwnerWorkspace(wid),
    });
    return { connected: true, id: decision.serviceKey, connections };
  });

  // One-click customer consent (#529, #507) — record consent for a channel without a redirect or pasted
  // secret. Consent alone is NOT provider proof (#1284): the returned connection stays providerStatus
  // "unproven" / connected false until a provider-specific health check writes proof material.
  app.post("/me/connections/:id/enable", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const wid = identity.workspaceId;
    const id = (req.params as { id: string }).id;
    const decision = decideOneClickConnect({ descriptor: runtimeDescriptor(id) });
    if (!decision.ok) return reply.code(400).send({ error: decision.reason });
    const providerSecrets =
      decision.serviceKey === EMAIL_CONNECTION_ID
        ? emailProviderProofSecrets(wid)
        : decision.serviceKey === TELEGRAM_ROOM_CONNECTION_ID
          ? telegramProviderProofSecrets()
          : {};
    await setServiceCredentials({
      workspaceId: wid,
      serviceKey: providerSecrets[POSTMARK_TOKEN_KEY] ? POSTMARK_SERVICE_KEY : decision.serviceKey,
      // Without live provider proof, one-click records consent only. With live Postmark configured, seal the
      // provider credential where the sender actually reads it, then alias that proof back to the email card.
      secrets: providerSecrets,
      scopes: decision.scopes,
      connectedByMemberId: identity.memberId,
    });
    const connections = decideConnectionView({
      descriptors: runtimeDescriptors(),
      proofs: await connectionProofs(wid),
      isOwner: isOwnerWorkspace(wid),
    });
    const view = connections.find((connection) => connection.id === decision.serviceKey);
    return {
      connected: view?.connected ?? false,
      id: decision.serviceKey,
      consentStatus: view?.consentStatus ?? "recorded",
      providerStatus: view?.providerStatus ?? "unproven",
      connections,
    };
  });

  // Waitlist (#507) — a connector whose live flow isn't wired yet offers "notify me" instead of a dead stop.
  // We record the interest (no money, no secret) so the user always has a next step and the team can see
  // demand; the connector stays `coming_soon` until its live flow ships.
  app.post("/me/connections/:id/waitlist", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const id = (req.params as { id: string }).id;
    const decision = decideWaitlist({ descriptor: runtimeDescriptor(id) });
    if (!decision.ok) return reply.code(400).send({ error: decision.reason });
    req.log.info(
      {
        event: "connection_waitlist",
        connectionId: decision.connectionId,
        provider: decision.provider,
        workspaceId: identity.workspaceId,
      },
      "connection waitlist interest recorded",
    );
    return reply.code(202).send({ status: "waitlisted", id: decision.connectionId });
  });

  // Consumer-OAuth seam (#258 Stage 2) — the shared connect-once flow. When the live flow is OUT of scope
  // for this workspace (flag OFF / not the owner workspace / no live provider wired) it stays the honest
  // `coming_soon` (501, today's behavior). When it IS in scope, connecting an outside account ALWAYS pauses
  // for an explicit owner approval: the service parks a PENDING `connection.connect_account` #13 request and
  // we return its id — the live redirect + token exchange + vault seal behind that gate is the per-department
  // follow-up (#265/#268/#269/#272), so nothing is connected without the owner's yes.
  const connectOnce = createDefaultConnectOnceService();
  app.post("/me/connections/:id/oauth/start", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const id = (req.params as { id: string }).id;
    const descriptor = getConnectionDescriptor(id);
    if (!descriptor || descriptor.auth !== "oauth") {
      return reply.code(400).send({ error: "not an OAuth connection" });
    }
    if (descriptor.status === "blocked") {
      return reply.code(501).send({
        status: "blocked",
        provider: descriptor.provider,
        scopes: descriptor.oauthScopes,
        reason: descriptor.statusReason ?? "This connection needs setup before it can run.",
      });
    }
    const result = await connectOnce.startConnect(
      { workspaceId: identity.workspaceId, requesterMemberId: identity.memberId },
      descriptor,
    );
    if (result.status === "pending_approval") {
      return reply.code(202).send({
        status: "pending_approval",
        requestId: result.requestId,
        authorizePath: `/me/connections/${encodeURIComponent(id)}/oauth/authorize?requestId=${encodeURIComponent(result.requestId)}`,
        provider: descriptor.provider,
        scopes: descriptor.oauthScopes,
        message: `Connecting ${descriptor.label} needs your approval — it's waiting in your decision queue.`,
      });
    }
    return reply.code(501).send({
      status: "coming_soon",
      provider: descriptor.provider,
      scopes: descriptor.oauthScopes,
      message: result.reason,
    });
  });

  // Owner-approved OAuth redirect (#1285) — turns the parked approval request into a real IdP consent URL.
  // This route still mints no credential; it only signs a callback state bound to the workspace, connector,
  // and approval request id. A pending/rejected/executed approval cannot start the live redirect.
  app.get("/me/connections/:id/oauth/authorize", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const id = (req.params as { id: string }).id;
    const query = (req.query ?? {}) as { requestId?: unknown };
    const requestId = typeof query.requestId === "string" ? query.requestId.trim() : "";
    if (!requestId) return reply.code(400).send({ error: "requestId is required" });
    const descriptor = getConnectionDescriptor(id);
    if (!descriptor || descriptor.auth !== "oauth") {
      return reply.code(400).send({ error: "not an OAuth connection" });
    }
    const provider = defaultConnectProvider(id);
    if (!provider.live) {
      const setup = oauthSetupStatus(id);
      return reply.code(501).send({
        status: "coming_soon",
        provider: descriptor.provider,
        scopes: descriptor.oauthScopes,
        issue: setup
          ? {
              code: oauthMissingConfigCode(id),
              missingEnv: setup.missing,
              callbackPath: setup.callbackPath,
            }
          : null,
      });
    }
    const approval = decideApprovedConnectRequest({
      request: await getRequest(requestId),
      workspaceId: identity.workspaceId,
      connectionId: id,
    });
    if (!approval.ok) return reply.code(approval.statusCode).send({ error: approval.reason });
    const state = signConnectState(
      {
        workspaceId: identity.workspaceId,
        connectionId: id,
        approvalRequestId: approval.request.id,
        nonce: newStateNonce(),
      },
      loadStateSecret(),
    );
    return reply.redirect(provider.authorizeUrl({ state }));
  });

  // Provider callback (#1285) — verifies the state, exchanges the code, seals the credential into the #192
  // vault, and marks the approved request executed. The response never exposes token material.
  app.get("/me/connections/:id/oauth/callback", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const id = (req.params as { id: string }).id;
    const descriptor = getConnectionDescriptor(id);
    const query = (req.query ?? {}) as { state?: unknown; code?: unknown };
    const finish = (status: string): void =>
      void reply.redirect(
        `${CONNECTION_RETURN_PATH}?connection=${encodeURIComponent(id)}&status=${encodeURIComponent(status)}`,
      );

    if (!descriptor || descriptor.auth !== "oauth") return finish("error");
    if (!isValidAuthCode(query.code)) return finish("error");
    const payload =
      typeof query.state === "string" ? verifyConnectState(query.state, loadStateSecret()) : null;
    if (
      !payload ||
      payload.workspaceId !== identity.workspaceId ||
      payload.connectionId !== id ||
      !payload.approvalRequestId
    ) {
      return finish("error");
    }

    const approval = decideApprovedConnectRequest({
      request: await getRequest(payload.approvalRequestId),
      workspaceId: identity.workspaceId,
      connectionId: id,
    });
    if (!approval.ok) return finish("error");

    const provider = defaultConnectProvider(id);
    if (!provider.live) return finish("coming_soon");

    let exchange;
    try {
      exchange = await provider.exchange({ code: query.code, state: query.state as string });
    } catch (err) {
      const reason = err instanceof ConnectProviderError ? err.message : "token exchange failed";
      await recordExecution(approval.request.id, identity.workspaceId, {
        ok: false,
        error: reason,
      });
      return finish("error");
    }
    const seal = mapExchangeToSeal({ descriptor, exchange });
    if (!seal.seal) {
      await recordExecution(approval.request.id, identity.workspaceId, {
        ok: false,
        error: seal.reason,
      });
      return finish("error");
    }
    const health = await verifyConnectionHealth({ descriptor, secrets: seal.secrets });
    if (!health.ok) {
      await recordExecution(approval.request.id, identity.workspaceId, {
        ok: false,
        error: health.reason,
      });
      return finish("error");
    }
    const proof = await setServiceCredentials({
      workspaceId: identity.workspaceId,
      serviceKey: seal.serviceKey,
      secrets: seal.secrets,
      scopes: seal.scopes,
      connectedByMemberId: identity.memberId,
    });
    const recorded = await recordExecution(approval.request.id, identity.workspaceId, {
      ok: true,
      result: {
        connectionId: seal.serviceKey,
        provider: descriptor.provider,
        envKeys: proof.envKeys,
        fingerprint: proof.fingerprint,
        scopes: proof.scopes,
        health: {
          provider: health.provider,
          checkedAtMs: health.checkedAtMs,
          scopes: health.scopes,
          subject: health.subject,
          audience: health.audience,
        },
      },
    });
    if (recorded.outcome !== "recorded") return finish("conflict");
    return finish("connected");
  });

  // Disconnect — dependent capabilities go offline gracefully (the vault marks the row revoked).
  // Internal connections (the GitHub site-publish paste) are admin-only: a non-owner can't revoke one.
  app.delete("/me/connections/:id", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const id = (req.params as { id: string }).id;
    const descriptor = getConnectionDescriptor(id);
    if (descriptor?.audience === "internal" && !isOwnerWorkspace(identity.workspaceId)) {
      return reply.code(403).send({ error: "internal connection — admin only" });
    }
    await revokeServiceCredentials(identity.workspaceId, id, identity.memberId);
    if (id === EMAIL_CONNECTION_ID) {
      const proofs = await connectionProofs(identity.workspaceId);
      if (proofs.get(POSTMARK_SERVICE_KEY)?.connected) {
        await revokeServiceCredentials(
          identity.workspaceId,
          POSTMARK_SERVICE_KEY,
          identity.memberId,
        );
      }
    }
    return { revoked: true, id };
  });
}
