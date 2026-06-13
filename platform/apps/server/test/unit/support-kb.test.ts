import { describe, it, expect } from "vitest";
import { buildAnswerWithReceipts, kbEntryFromResolvedTicket, kbSlug, type KbEntry } from "../../src/support/kb.js";

function entry(over: Partial<KbEntry>): KbEntry {
  return {
    id: "kb-1",
    workspaceId: "ws-1",
    ventureIdeaId: null,
    slug: "s",
    title: "t",
    body: "b",
    category: "support",
    source: "manual",
    sourceTicketId: null,
    provenance: "manual",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

describe("support/kb — answer assembly with receipts (#190)", () => {
  it("matches the relevant entry and cites it as a receipt", () => {
    const entries = [
      entry({ id: "kb-pw", title: "Reset password", body: "To reset your password, open settings and click reset password.", category: "support" }),
      entry({ id: "kb-bill", title: "Billing", body: "Invoices are emailed monthly.", category: "pricing" }),
    ];
    const ans = buildAnswerWithReceipts(entries, { subject: "password help", body: "how do I reset my password?", category: "support" });
    expect(ans.receipts).toContain("kb-pw");
    expect(ans.receipts).not.toContain("kb-bill");
    expect(ans.confidence).toBeGreaterThan(0);
    expect(ans.draft).toContain("reset your password");
  });

  it("returns zero confidence and no receipts when nothing matches (forces escalation upstream)", () => {
    const entries = [entry({ id: "kb-x", title: "Shipping", body: "We ship worldwide in 3 days.", category: "support" })];
    const ans = buildAnswerWithReceipts(entries, { subject: null, body: "quantum entanglement pricing", category: "pricing" });
    expect(ans.confidence).toBe(0);
    expect(ans.receipts).toEqual([]);
    expect(ans.draft).toBe("");
  });

  it("empty KB or empty query yields zero confidence", () => {
    expect(buildAnswerWithReceipts([], { subject: null, body: "anything", category: "support" }).confidence).toBe(0);
    expect(buildAnswerWithReceipts([entry({})], { subject: null, body: "", category: "support" }).confidence).toBe(0);
  });

  it("a same-category match scores higher than a cross-category one with equal overlap", () => {
    const entries = [
      entry({ id: "same", title: "export data", body: "export data from the dashboard", category: "support" }),
      entry({ id: "cross", title: "export data", body: "export data from the dashboard", category: "pricing" }),
    ];
    const ans = buildAnswerWithReceipts(entries, { subject: null, body: "how to export data", category: "support" }, { maxEntries: 1 });
    expect(ans.receipts[0]).toBe("same");
  });

  it("is deterministic — same inputs, same receipts", () => {
    const entries = [entry({ id: "a", body: "reset password steps here" }), entry({ id: "b", body: "reset password alternative" })];
    const q = { subject: null, body: "reset password", category: "support" as const };
    expect(buildAnswerWithReceipts(entries, q)).toEqual(buildAnswerWithReceipts(entries, q));
  });

  it("kbEntryFromResolvedTicket distills a resolved ticket with traceable provenance", () => {
    const e = kbEntryFromResolvedTicket(
      { id: "tic-9", workspaceId: "ws-1", ventureIdeaId: "idea-1", subject: "Cannot log in", body: "...", category: "support" },
      "Clear your cookies and try again.",
    );
    expect(e.source).toBe("resolved_ticket");
    expect(e.sourceTicketId).toBe("tic-9");
    expect(e.provenance).toBe("resolved_ticket:tic-9");
    expect(e.slug).toBe("cannot-log-in");
    expect(e.body).toBe("Clear your cookies and try again.");
  });

  it("kbSlug is stable, lowercased, and capped", () => {
    expect(kbSlug("Reset My Password!")).toBe("reset-my-password");
    expect(kbSlug("")).toBe("untitled");
  });
});
