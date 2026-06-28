import { describe, expect, it, vi, beforeEach, afterAll } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../../api/client.js";
import type { InboundLeadDto } from "../../api/types.js";
import { InboundLeadsPanel } from "./InboundLeadsPanel.js";

const getInboundLeads = vi.spyOn(api, "getInboundLeads");
const updateInboundLead = vi.spyOn(api, "updateInboundLead");

const lead = (over: Partial<InboundLeadDto> = {}): InboundLeadDto => ({
  id: "lead-1",
  workspaceId: "w1",
  name: "Jane Buyer",
  email: "jane@buyerco.io",
  message: "I need an autonomous GTM team before our launch next Friday.",
  source: "site",
  trackingRef: null,
  status: "new",
  assigneeMemberId: null,
  nextAction: null,
  respondedAtMs: null,
  slaDueAtMs: Date.parse("2026-06-25T12:00:00Z"),
  slaNotifiedAtMs: null,
  slaBreached: false,
  reachContactKey: "email:jane@buyerco.io",
  createdAtMs: Date.parse("2026-06-24T12:00:00Z"),
  ...over,
});

describe("InboundLeadsPanel (#898)", () => {
  beforeEach(() => {
    getInboundLeads.mockReset();
    updateInboundLead.mockReset();
    getInboundLeads.mockResolvedValue({ leads: [lead()] });
    updateInboundLead.mockImplementation(async (_id, input) => ({ lead: lead({ ...input, status: input.status ?? "new" }) }));
  });
  afterAll(() => {
    getInboundLeads.mockRestore();
    updateInboundLead.mockRestore();
  });

  it("lists captured leads, shows the full message, and exposes the Reach dedupe key", async () => {
    render(<InboundLeadsPanel />);

    const detail = await screen.findByLabelText("Lead details");
    expect(within(detail).getByRole("heading", { name: "Jane Buyer" })).toBeInTheDocument();
    expect(within(detail).getByText("I need an autonomous GTM team before our launch next Friday.")).toBeInTheDocument();
    expect(within(detail).getByText("email:jane@buyerco.io")).toBeInTheDocument();
    expect(getInboundLeads).toHaveBeenCalledWith({ limit: 50 });
  });

  it("shows the first-customer proof spine and tracked booking link for a captured hand-raiser", async () => {
    getInboundLeads.mockResolvedValue({
      leads: [
        lead({
          trackingRef: "ipop_deadbeefdeadbeef",
          respondedAtMs: Date.parse("2026-06-24T13:00:00Z"),
          status: "working",
        }),
      ],
    });

    render(<InboundLeadsPanel />);

    const proof = await screen.findByRole("region", { name: "First-customer proof" });
    expect(within(proof).getByText("Real lead captured with ipop_deadbeefdeadbeef")).toBeInTheDocument();
    expect(within(proof).getByText(/Needs approved Postmark production_readback receipt/)).toBeInTheDocument();
    expect(within(proof).getByText(/Response recorded/)).toBeInTheDocument();
    expect(within(proof).getByRole("link", { name: "Tracked booking link" })).toHaveAttribute(
      "href",
      "/start?source=landing_booking_cta&ref=ipop_deadbeefdeadbeef",
    );
    const draftHref = within(proof).getByRole("link", { name: "Proof JSON draft" }).getAttribute("href") ?? "";
    expect(within(proof).getByRole("link", { name: "Proof JSON draft" })).toHaveAttribute(
      "download",
      "first-customer-proof-ipop_deadbeefdeadbeef.json",
    );
    const draft = JSON.parse(decodeURIComponent(draftHref.replace("data:application/json;charset=utf-8,", "")));
    expect(draft._meta).toMatchObject({
      validator:
        "pnpm -C platform --filter @reload/server first-customer:proof -- --file first-customer-proof.json",
      requiredEvidence: expect.arrayContaining([
        "approvalRequestId",
        "outboundDelivery.receipt.externalRef",
        "reply.providerThreadId",
        "inboundRoute.acknowledged",
      ]),
    });
    expect(draft.prospectSource).toMatchObject({
      trackingRef: "ipop_deadbeefdeadbeef",
      sampleEmails: ["jane@buyerco.io"],
      fabricatedCount: 0,
    });
    expect(draft.outboundDelivery).toMatchObject({
      recipient: "jane@buyerco.io",
      approvalRequestId: "",
      trackingRef: "ipop_deadbeefdeadbeef",
    });
    expect(draft.outboundDelivery.receipt.externalRef).toBe("");
    expect(draft.outboundDelivery.receipt.observedAt).toBe("");
    expect(draft.reply.providerThreadId).toBe("");
    expect(draft.booking.url).toBe("https://ipop.ai/start?source=landing_booking_cta&ref=ipop_deadbeefdeadbeef");
  });

  it("flags 24h SLA breaches in the owner queue", async () => {
    getInboundLeads.mockResolvedValue({ leads: [lead({ slaBreached: true })] });
    render(<InboundLeadsPanel />);

    expect(await screen.findByText("24h SLA breached")).toBeInTheDocument();
    expect(screen.getByLabelText("1 open, 1 breached")).toBeInTheDocument();
  });

  it("assigns a lead, sets next action, and transitions lifecycle state", async () => {
    render(<InboundLeadsPanel />);

    await screen.findByLabelText("Lead details");
    await userEvent.type(screen.getByLabelText("Assignee member ID"), "11111111-2222-3333-4444-555555555555");
    await userEvent.type(screen.getByLabelText("Next action"), "Book a demo");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(updateInboundLead).toHaveBeenCalledWith("lead-1", {
      assigneeMemberId: "11111111-2222-3333-4444-555555555555",
      nextAction: "Book a demo",
      status: undefined,
    });

    const actions = screen.getByLabelText("Lead actions");
    await userEvent.click(within(actions).getByRole("button", { name: "Working" }));
    expect(updateInboundLead).toHaveBeenLastCalledWith("lead-1", { status: "working" });
  });
});
