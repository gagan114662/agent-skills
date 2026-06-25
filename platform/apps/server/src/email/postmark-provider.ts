import { dryRunEspSender, type EspSender } from "../reach/channels/email.js";

/**
 * The live Postmark ESP provider (issue #268, ADR-0268). This is the only place a *real* email leaves the
 * building, and it is deliberately gated three ways: it is constructed only by {@link resolvePostmarkSender},
 * which returns the recorded-only {@link dryRunEspSender} unless live sending is explicitly enabled AND a
 * Postmark server token is connected — so CI/tests/the default deployment never touch the network. Even when
 * a live provider IS constructed, the email deliverability service still routes the send through the
 * `email.live_send` #13 always-gate (`decidePostmarkLiveSend`) before calling it. Dependency-free: the
 * Postmark v1 REST API over global `fetch` (no SDK), with `fetch` injectable for offline unit tests.
 *
 * The server token is a SECRET (it can send mail as the domain), so it rides ONLY the `X-Postmark-Server-Token`
 * request header — never the request body, never a log line, never a thrown error message.
 */

/** The Postmark single-message send endpoint. */
export const POSTMARK_API_URL = "https://api.postmarkapp.com/email";

/** The minimal slice of the Postmark `/email` response we read. `ErrorCode: 0` means accepted. */
interface PostmarkResponse {
  MessageID?: string;
  ErrorCode?: number;
  Message?: string;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface PostmarkProviderOptions {
  /** The Postmark server token (secret — resolved from the #192 vault by the caller). */
  serverToken: string;
  /** The verified From address (a DKIM-signed sender on the connected domain). */
  from: string;
  /** Injected fetch for unit tests; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Send HTML (`HtmlBody`) vs plain text (`TextBody`). Defaults to HTML. */
  html?: boolean;
}

export class PostmarkEspProvider implements EspSender {
  readonly kind = "postmark";
  private readonly serverToken: string;
  private readonly from: string;
  private readonly fetchImpl: FetchLike;
  private readonly html: boolean;

  constructor(opts: PostmarkProviderOptions) {
    this.serverToken = opts.serverToken;
    this.from = opts.from;
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.html = opts.html ?? true;
  }

  async send(input: {
    to: string;
    subject: string;
    body: string;
    from?: string | null;
    headers?: Record<string, string>;
  }): Promise<{ externalId: string }> {
    const payload: Record<string, unknown> = {
      From: input.from?.trim() || this.from,
      To: input.to,
      Subject: input.subject,
      [this.html ? "HtmlBody" : "TextBody"]: input.body,
      MessageStream: "broadcast",
    };
    if (input.headers && Object.keys(input.headers).length > 0) {
      payload.Headers = Object.entries(input.headers).map(([Name, Value]) => ({ Name, Value }));
    }

    let res: Response;
    try {
      res = await this.fetchImpl(POSTMARK_API_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          // The secret rides ONLY here — never the body, never a log line.
          "X-Postmark-Server-Token": this.serverToken,
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      // A network error — surface a token-free message so the channel records a clean failure.
      throw new Error(`postmark request failed: ${err instanceof Error ? err.message : "network error"}`);
    }

    let parsed: PostmarkResponse = {};
    try {
      parsed = (await res.json()) as PostmarkResponse;
    } catch {
      /* a non-JSON body — fall through to the status check below */
    }

    if (!res.ok) {
      // Surface the Postmark error code/message (public), NEVER the token.
      throw new Error(`postmark HTTP ${res.status}: ${parsed.Message ?? "send rejected"} (code ${parsed.ErrorCode ?? "?"})`);
    }
    if (typeof parsed.ErrorCode === "number" && parsed.ErrorCode !== 0) {
      throw new Error(`postmark rejected the message: ${parsed.Message ?? "unknown"} (code ${parsed.ErrorCode})`);
    }
    if (!parsed.MessageID) {
      throw new Error("postmark accepted the request but returned no MessageID");
    }
    return { externalId: parsed.MessageID };
  }
}

/**
 * Resolve the ESP sender for a send. Returns the recorded-only {@link dryRunEspSender} UNLESS live sending is
 * enabled AND a Postmark server token + From address are connected — only then is a real {@link
 * PostmarkEspProvider} constructed. This is the gate that keeps the default path (and all of CI) byte-for-byte
 * network-free; wiring a workspace to live sending is the owner's deliberate, gated step.
 */
export function resolvePostmarkSender(opts: {
  live: boolean;
  serverToken: string;
  from: string;
  fetchImpl?: FetchLike;
  html?: boolean;
}): EspSender {
  if (!opts.live || !opts.serverToken || !opts.from) return dryRunEspSender;
  return new PostmarkEspProvider({
    serverToken: opts.serverToken,
    from: opts.from,
    fetchImpl: opts.fetchImpl,
    html: opts.html,
  });
}
