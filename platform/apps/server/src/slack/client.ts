import type { SlackBlock } from "./blocks.js";
import { egressAllowed } from "../config/egress.js";

/**
 * The Slack Web API seam (#170). Decouples *what* we post (replies, approval DMs, digests) from *how*
 * the bytes leave the box — so the whole service is unit/integration-tested offline with a fake client
 * that records calls, and a real deployment uses {@link HttpSlackClient} over `fetch`. Outbound is
 * egress-gated: under data-privacy mode (#58) nothing leaves the box (mirrors the notifications
 * transport). Posting back into a thread the human started + the opt-in digest are the ONLY outbound
 * Slack traffic — the inbound-only posture (#170 criterion 4) lives above this seam, in the service.
 */

export interface SlackPostMessageInput {
  /** The Slack channel id (or a DM channel id from `openDm`). */
  channel: string;
  /** Plain-text body (fallback + simple replies). */
  text?: string;
  /** Optional Block Kit blocks (approval DMs, digests). */
  blocks?: SlackBlock[];
  /** Thread to reply in (the `ts` of the root Slack message). */
  threadTs?: string;
}

export interface SlackClient {
  /** Post a message to a channel/thread. Returns the new message `ts` (Slack's id), or null if dropped. */
  postMessage(token: string, input: SlackPostMessageInput): Promise<{ ts: string } | null>;
  /** Open (or fetch) the DM channel id for a Slack user, or null if unavailable. */
  openDm(token: string, userId: string): Promise<{ channel: string } | null>;
}

/** Minimal shape of `fetch` we depend on — injectable so the client is testable offline. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ json: () => Promise<unknown> }>;

const SLACK_API = "https://slack.com/api";

/** The production Slack client: bot-token-authenticated JSON POSTs to the Slack Web API. */
export class HttpSlackClient implements SlackClient {
  constructor(
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly opts: { dataPrivacyMode?: boolean } = {},
  ) {}

  private allowed(): boolean {
    return egressAllowed({ dataPrivacyMode: this.opts.dataPrivacyMode ?? false });
  }

  private async call(token: string, method: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await this.fetchImpl(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  async postMessage(
    token: string,
    input: SlackPostMessageInput,
  ): Promise<{ ts: string } | null> {
    if (!this.allowed()) return null;
    const body: Record<string, unknown> = { channel: input.channel };
    if (input.text !== undefined) body.text = input.text;
    if (input.blocks !== undefined) body.blocks = input.blocks;
    if (input.threadTs !== undefined) body.thread_ts = input.threadTs;
    const json = (await this.call(token, "chat.postMessage", body)) as {
      ok?: boolean;
      ts?: string;
    };
    return json?.ok && typeof json.ts === "string" ? { ts: json.ts } : null;
  }

  async openDm(token: string, userId: string): Promise<{ channel: string } | null> {
    if (!this.allowed()) return null;
    const json = (await this.call(token, "conversations.open", { users: userId })) as {
      ok?: boolean;
      channel?: { id?: string };
    };
    return json?.ok && typeof json.channel?.id === "string" ? { channel: json.channel.id } : null;
  }
}
