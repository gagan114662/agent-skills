import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Draft a starter paid-acquisition plan (#339 pilot of @bid on eve).
 *
 * This is the *draft* half of @bid's job — the work that stays inside the building. It produces a
 * structured plan plus a one-line summary and NOTHING leaves: no account is touched, no money moves.
 * It needs no approval because drafting is reversible and free (#200 §4). Spending the budget this
 * plan proposes is a separate, human-gated action (`record_ad_spend`).
 *
 * Injection defense (#200 §6) is structural: every input is a typed scalar validated by the schema,
 * so a poisoned web read a model might paste in can only ever land as plan *data* in the returned
 * draft — it can never become an actuation, because this tool has no side effect to steer.
 */
export default defineTool({
  description:
    "Draft a starter paid-acquisition plan (channels, proposed daily budget, CAC target). Drafts only — proposes spend, never spends. A human approves any actual spend separately.",
  inputSchema: z.object({
    objective: z.string().min(1).describe("What the campaign should achieve, in one line."),
    monthlyBudgetCents: z.number().int().positive().describe("The total monthly budget to pace, in cents."),
    channels: z.array(z.string().min(1)).min(1).describe("Candidate channels, e.g. google_search, meta."),
    targetCacCents: z.number().int().positive().optional().describe("Target cost per acquisition, in cents."),
  }),
  async execute({ objective, monthlyBudgetCents, channels, targetCacCents }) {
    const dailyBudgetCents = Math.floor(monthlyBudgetCents / 30);
    const perChannelDailyCents = Math.floor(dailyBudgetCents / channels.length);
    const plan = channels.map((channel) => ({ channel, dailyBudgetCents: perChannelDailyCents }));
    return {
      status: "draft" as const,
      spent: false,
      objective,
      proposedDailyBudgetCents: dailyBudgetCents,
      targetCacCents: targetCacCents ?? null,
      plan,
      summary: `Draft only — proposes $${(dailyBudgetCents / 100).toFixed(2)}/day across ${channels.length} channel(s); nothing spent until a human approves.`,
    };
  },
});
