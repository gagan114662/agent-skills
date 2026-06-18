import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { loadConfig } from "../config/loader.js";
import { loadStateSecret, newStateNonce } from "../auth/oauth-state.js";
import {
  resolveConnectClaudeCaps,
  decideClaudeConnectOffer,
  createClaudeConnectProvider,
  signConnectState,
  verifyConnectState,
  isValidAuthCode,
  type ClaudeConnectProvider,
  type ConnectClaudeCaps,
} from "../auth/claude-connect.js";
import {
  setWorkspaceClaudeToken,
  getClaudeConnectionHealth,
} from "../db/repositories/agent-credentials.js";

/**
 * Connect Claude without a CLI token (#262, ADR-0262) — the in-app, one-click replacement for pasting a
 * `claude setup-token`. All `/me/*`-scoped to the caller's workspace (#3).
 *
 *  - `GET  /me/claude/connect`          — the offer the Settings panel features (managed one-click vs the
 *                                         always-available Advanced paste). Read-only, never a secret.
 *  - `POST /me/claude/connect/start`    — begin the managed flow: mints an HMAC-signed, workspace-bound
 *                                         OAuth `state` (no DB) and returns the consent URL. Honest 409
 *                                         (not enabled) / 501 (`coming_soon`) when the flow can't run.
 *  - `GET  /me/claude/connect/callback` — the IdP redirect: verifies the state (CSRF + tenant binding),
 *                                         validates the untrusted `code` (#200 §6), exchanges it for the
 *                                         subscription token, and seals it into the SAME #68 vault the
 *                                         manual paste uses. Then redirects back to the board.
 *
 * Connecting is a one-time CONSENT, not money — so it carries no #13 gate (consistent with #243 money-only
 * and the #258 non-money connects). Default OFF + owner-workspace-first: an unwired deployment never
 * features the one-click flow and the paste path (behind #263 Advanced) always remains.
 */
export interface ClaudeConnectRoutesOptions {
  /** Injectable for tests; defaults to env-derived (dry-run unless a live OAuth client is configured). */
  provider?: ClaudeConnectProvider;
}

const BOARD_PATH = "/";

export async function claudeConnectRoutes(
  app: FastifyInstance,
  opts: ClaudeConnectRoutesOptions = {},
): Promise<void> {
  const provider = opts.provider ?? createClaudeConnectProvider();

  /** Caps for a workspace; owner-first reuses the canonical #235 owner marker when none is set here. */
  function capsFor(workspaceId: string): ConnectClaudeCaps {
    const cfg = loadConfig(workspaceId);
    const caps = resolveConnectClaudeCaps(cfg.connectClaude);
    if (caps.ownerWorkspaceId === null) {
      caps.ownerWorkspaceId = cfg.marketing.ownerWorkspaceId ?? null;
    }
    return caps;
  }

  app.get("/me/claude/connect", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const offer = decideClaudeConnectOffer({
      caps: capsFor(identity.workspaceId),
      workspaceId: identity.workspaceId,
      liveProviderConfigured: provider.live,
    });
    return { offer };
  });

  // #365: the owner's connection-health signal — connected / not connected / token expired — so they can
  // see at a glance whether the fleet can actually run on the subscription token (#246). Derived purely
  // from the per-tenant vault; NEVER returns the token. `/me/*`-scoped to the caller's own workspace (#3).
  app.get("/me/claude/health", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const health = await getClaudeConnectionHealth(identity.workspaceId);
    return { health };
  });

  app.post("/me/claude/connect/start", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const offer = decideClaudeConnectOffer({
      caps: capsFor(identity.workspaceId),
      workspaceId: identity.workspaceId,
      liveProviderConfigured: provider.live,
    });
    if (offer.method !== "managed_oauth") {
      return reply
        .code(409)
        .send({ error: "managed connect isn't enabled for this workspace", offer });
    }
    if (offer.status !== "available" || !provider.live) {
      // Honest: featured but not wired. The UI keeps the Advanced paste available.
      return reply.code(501).send({ status: "coming_soon", offer });
    }
    const state = signConnectState(
      { workspaceId: identity.workspaceId, nonce: newStateNonce() },
      loadStateSecret(),
    );
    return { authorizeUrl: provider.authorizeUrl({ state }) };
  });

  app.get("/me/claude/connect/callback", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const fail = (code: string): void =>
      void reply.redirect(`${BOARD_PATH}?claude=${encodeURIComponent(code)}`);

    const query = (req.query ?? {}) as { state?: unknown; code?: unknown };
    // #200 §6 injection defense: validate the untrusted callback inputs BEFORE any exchange.
    if (!isValidAuthCode(query.code)) return fail("error");
    const payload =
      typeof query.state === "string" ? verifyConnectState(query.state, loadStateSecret()) : null;
    // Tenant binding: a state minted for another workspace can never connect this caller's.
    if (!payload || payload.workspaceId !== identity.workspaceId) return fail("error");

    let token: string | null;
    try {
      ({ token } = await provider.exchange({ code: query.code, state: query.state as string }));
    } catch {
      return fail("error");
    }
    if (!token) return fail("error"); // never seal a blank credential into the vault

    await setWorkspaceClaudeToken({
      workspaceId: identity.workspaceId,
      token,
      connectedByMemberId: identity.memberId,
    });
    return reply.redirect(`${BOARD_PATH}?claude=connected`);
  });
}
