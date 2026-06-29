import { describe, expect, it } from "vitest";
import { getPlan } from "../../src/billing/plans.js";
import {
  connectChannel,
  countConnectedChannels,
} from "../../src/outbound-channel/service.js";
import type { ChannelConnectionRow } from "../../src/db/repositories/outbound-channels.js";

function row(overrides: Partial<ChannelConnectionRow> = {}): ChannelConnectionRow {
  return {
    id: "conn-1",
    workspaceId: "ws-1",
    channel: "email_postmark",
    provider: "postmark",
    status: "connected",
    fromAddress: "fleet@ipop.test",
    credentialFingerprint: "fp",
    connectedByMemberId: "member-1",
    connectedAtMs: 1,
    revokedAtMs: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

describe("outbound-channel plan quota (#1290)", () => {
  it("counts connected channel slots without double-counting a reconnect", () => {
    expect(countConnectedChannels([], "email_postmark")).toBe(1);
    expect(countConnectedChannels([row()], "email_postmark")).toBe(1);
    expect(countConnectedChannels([row({ status: "revoked" })], "email_postmark")).toBe(1);
  });

  it("blocks a new channel connection over the active plan's connected-channel cap before writing", async () => {
    const starter = getPlan("starter")!;
    const result = await connectChannel({
      workspaceId: "ws-1",
      fromAddress: "fleet@ipop.test",
      connectedByMemberId: "member-1",
      serverToken: "pm-token",
      planForWorkspace: async () => starter,
      listConnectionsForWorkspace: async () => [
        row({ id: "conn-resend", channel: "email_resend", provider: "resend" }),
      ],
    });
    expect(result).toMatchObject({
      ok: false,
      code: "plan_limit",
      limit: starter.productLimits.connectedChannels,
      used: 2,
      planKey: "starter",
    });
    if (!result.ok) expect(result.error).toContain(starter.upgradeTrigger);
  });
});
