import { dryRunEspSender, type EspSender } from "../reach/channels/email.js";

/**
 * Dependency-free Resend ESP provider for the owner-gated live email path. The API key is secret and rides
 * only the Authorization header; request bodies, persisted rows, and thrown errors never include it.
 */

export const RESEND_API_URL = "https://api.resend.com/emails";

interface ResendResponse {
  id?: string;
  message?: string;
  name?: string;
  statusCode?: number;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ResendProviderOptions {
  /** The Resend API key, resolved from owner-gated deployment env by the caller. */
  apiKey: string;
  /** The verified From address/sender identity. */
  from: string;
  /** Injected fetch for unit tests; defaults to the global fetch. */
  fetchImpl?: FetchLike;
  /** Send HTML vs plain text. Defaults to HTML. */
  html?: boolean;
}

export class ResendEspProvider implements EspSender {
  readonly kind = "resend";
  private readonly apiKey: string;
  private readonly from: string;
  private readonly fetchImpl: FetchLike;
  private readonly html: boolean;

  constructor(opts: ResendProviderOptions) {
    this.apiKey = opts.apiKey;
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
      from: input.from?.trim() || this.from,
      to: [input.to],
      subject: input.subject,
      [this.html ? "html" : "text"]: input.body,
    };
    if (input.headers && Object.keys(input.headers).length > 0) {
      payload.headers = input.headers;
    }

    let res: Response;
    try {
      res = await this.fetchImpl(RESEND_API_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer " + this.apiKey,
          "Content-Type": "application/json",
          "User-Agent": "ipop-server/1.0",
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw new Error("resend request failed: " + (err instanceof Error ? err.message : "network error"));
    }

    let parsed: ResendResponse = {};
    try {
      parsed = (await res.json()) as ResendResponse;
    } catch {
      /* a non-JSON body - fall through to the status check below */
    }

    if (!res.ok) {
      throw new Error("resend HTTP " + res.status + ": " + (parsed.message ?? parsed.name ?? "send rejected"));
    }
    if (!parsed.id) {
      throw new Error("resend accepted the request but returned no id");
    }
    return { externalId: parsed.id };
  }
}

/** Return dry-run unless live sending is enabled and Resend has both an API key and sender identity. */
export function resolveResendSender(opts: {
  live: boolean;
  apiKey: string;
  from: string;
  fetchImpl?: FetchLike;
  html?: boolean;
}): EspSender {
  if (!opts.live || !opts.apiKey || !opts.from) return dryRunEspSender;
  return new ResendEspProvider({
    apiKey: opts.apiKey,
    from: opts.from,
    fetchImpl: opts.fetchImpl,
    html: opts.html,
  });
}
