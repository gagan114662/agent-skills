import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

/**
 * Spend against an approved ads plan (#339 pilot of @bid on eve).
 *
 * This is the eve-native expression of ipop's #13 approval gate for the `ads` external-send
 * department. `needsApproval: always()` makes a human sign off *before* every call — a
 * pre-execution gate, not a post-hoc review — which is exactly what #200 §4 requires for an
 * irreversible/money action. The bespoke fleet achieves the same guarantee by giving @bid NO spend
 * tool at all (spend lives outside the agent, in the #13 queue); eve lets the gate live ON the tool
 * and pauses the run durably until the owner answers.
 *
 * PILOT SAFETY: this is a dry stub. It connects to NO live ad account and moves NO money — it only
 * records the intent so the spike can observe the approval pause end-to-end. The amount is a typed
 * scalar (injection-safe per #200 §6); the execute body has no path to a real provider.
 */
export default defineTool({
  description:
    "Record spend against a human-approved ads plan. Pauses for human approval every time before it runs.",
  inputSchema: z.object({
    planId: z.string().min(1).describe("The approved plan this spend draws against."),
    amountCents: z.number().int().positive().describe("Amount to spend, in cents."),
  }),
  needsApproval: always(),
  async execute({ planId, amountCents }) {
    // Dry pilot: no live provider connection (out of scope for #339). Record intent only.
    return {
      recorded: true,
      spent: false,
      planId,
      amountCents,
      note: "dry pilot — approval gate fired, no live ad account connected, no money moved",
    };
  },
});
