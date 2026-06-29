import { ActionExecutionError } from "../approvals/executor.js";
import { resolveResendSender } from "../email/resend-provider.js";
import type { EmailSendInput, EspProvider, SendOutcome } from "./providers.js";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ResendEspResolution {
  /** Whether the owner has turned live sending ON for this workspace. */
  live: boolean;
  /** The Resend API key, resolved inline and never persisted by this adapter. */
  apiKey: string;
  /** The verified From address for the connected sending domain. */
  from: string;
}

export type ResendEspResolver = (workspaceId: string) => ResendEspResolution | Promise<ResendEspResolution>;

export interface ResendEspProviderDeps {
  resolve: ResendEspResolver;
  fetchImpl?: FetchLike;
  html?: boolean;
}

/** Build the acquisition ESP provider backed by Resend, with dry-run as the default fail-safe path. */
export function createResendEspProvider(deps: ResendEspProviderDeps): EspProvider {
  return {
    kind: "resend",
    async send(input: EmailSendInput): Promise<SendOutcome> {
      const { live, apiKey, from } = await deps.resolve(input.workspaceId);
      const sender = resolveResendSender({
        live,
        apiKey,
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
        throw new ActionExecutionError(
          "resend send failed: " + (err instanceof Error ? err.message : "unknown error"),
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
