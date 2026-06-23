/**
 * The real Postmark ESP adapter for the acquisition dispatcher (issue #395).
 *
 * This is the one wiring that makes a marketing email actually leave the building. The dispatcher
 * (`execution.ts dispatchEmail`) talks to its channels through the narrow {@link EspProvider} seam whose
 * DEFAULT is `dryRunEspProvider` (recorded-only, no network). This adapter bridges that seam to the real
 * {@link PostmarkEspProvider} (`email/postmark-provider.ts`, #268) — but it stays SAFE BY DEFAULT and
 * gated exactly like every other real provider:
 *
 *   1. The dispatcher only reaches `esp.send` when the acquisition email channel is cleared to execute
 *      (master flag + email flag ON — `channelExecutes`), and only ever from `executeApprovedRequest`,
 *      i.e. AFTER a human approves the parked `external.send` #13 request. There is no autonomous send.
 *   2. Even then, this adapter resolves the connection PER WORKSPACE and routes through
 *      {@link resolvePostmarkSender}, which returns the recorded-only `dryRunEspSender` UNLESS live sending
 *      is enabled AND a Postmark server token + verified From address are connected. So with nothing
 *      connected — the byte-for-byte default — no email ever touches the network.
 *
 * The server token is a SECRET: it is resolved inline (never persisted by this module) and handed to the
 * Postmark provider, which puts it ONLY on the `X-Postmark-Server-Token` header. A send failure surfaces a
 * token-free {@link ActionExecutionError} so the #13 request is recorded `failed` — never a silent send.
 */

import { ActionExecutionError } from "../approvals/executor.js";
import { resolvePostmarkSender } from "../email/postmark-provider.js";
import type { EmailSendInput, EspProvider, SendOutcome } from "./providers.js";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** What the adapter needs to decide, per workspace, whether a REAL send is connected and where it sends from. */
export interface PostmarkEspResolution {
  /** Whether the owner has turned live sending ON for this workspace (the connect-once + flag decision). */
  live: boolean;
  /** The Postmark server token (a secret) — resolved inline, never persisted by this adapter. */
  serverToken: string;
  /** The verified DKIM-signed From address for the connected sending domain. */
  from: string;
}

/** Resolve the live/token/from for a workspace at send time (async so production can read the connection ledger). */
export type PostmarkEspResolver = (
  workspaceId: string,
) => PostmarkEspResolution | Promise<PostmarkEspResolution>;

export interface PostmarkEspProviderDeps {
  /** Per-workspace connect-once resolution. */
  resolve: PostmarkEspResolver;
  /** Injected fetch for unit tests; the real provider defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Send HTML vs plain text (defaults to HTML, matching the Postmark provider). */
  html?: boolean;
}

/**
 * Build the acquisition {@link EspProvider} backed by Postmark. When the workspace is not connected (the
 * default), every send is the recorded-only dry-run — no network. When connected, each recipient is sent a
 * real email and the Postmark `MessageID` is returned as the external receipt (#200 §2/§3).
 */
export function createPostmarkEspProvider(deps: PostmarkEspProviderDeps): EspProvider {
  return {
    kind: "postmark",
    async send(input: EmailSendInput): Promise<SendOutcome> {
      const { live, serverToken, from } = await deps.resolve(input.workspaceId);
      // The single network gate: dryRunEspSender unless live AND a token + From are connected.
      const sender = resolvePostmarkSender({
        live,
        serverToken,
        from,
        fetchImpl: deps.fetchImpl,
        html: deps.html,
      });
      const dryRun = sender.kind === "dryrun";

      const messageIds: string[] = [];
      try {
        for (const to of input.recipients) {
          const { externalId } = await sender.send({ to, subject: input.subject, body: input.body });
          messageIds.push(externalId);
        }
      } catch (err) {
        // PostmarkEspProvider already throws token-free messages; wrap as ActionExecutionError so the #13
        // request is recorded `failed` with a clean reason (never a silent send, never a leaked token).
        throw new ActionExecutionError(
          `postmark send failed: ${err instanceof Error ? err.message : "unknown error"}`,
        );
      }

      return {
        status: "sent",
        externalId: messageIds[0] ?? null,
        provider: sender.kind,
        detail: {
          dryRun,
          recipientCount: input.recipients.length,
          messageIds,
        },
      };
    },
  };
}
