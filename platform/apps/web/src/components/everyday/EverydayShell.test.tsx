/**
 * Everyday workspace shell render tests (#784). These lock the surface the issue specifies:
 *   · the north star (customers + revenue) is visible up top;
 *   · the approval queue shows the FINISHED deliverable as a one-glance ship decision — never chatter;
 *   · money is the one hard gate (a spend takes a second, explicit confirm);
 *   · the transparency log lists every external action, timestamped + linked;
 *   · the kill switch is always on, framed as reassurance;
 *   · empty states + the greeting read in the cheeky Innocent voice.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { EverydayShell, type EverydayApprovalActions } from "./EverydayShell.js";
import { ipopDogfoodEveryday, seedEveryday, type ApprovalCard, type EverydayData } from "./everyday-data.js";
import { EVERYDAY } from "../../brand.js";
import { APP_ROUTES } from "../../routing.js";
import { ipopExperienceTokens } from "../../design/ipop-experience-tokens.js";

function emptyData(over: Partial<EverydayData> = {}): EverydayData {
  return {
    memberName: "gagan",
    northStar: { customers: 0, customersDelta: 0, revenue: "$0", revenueDelta: "—", trend: "zero" },
    room: [],
    connectors: [],
    thread: [],
    approvals: [],
    transparency: [],
    fleetPaused: false,
    ...over,
  };
}

function approvalActions(): EverydayApprovalActions & {
  ship: ReturnType<typeof vi.fn>;
  requestRevision: ReturnType<typeof vi.fn>;
} {
  return {
    ship: vi.fn(async (_card: ApprovalCard) => undefined),
    requestRevision: vi.fn(async (_card: ApprovalCard, _note: string) => undefined),
  };
}

describe("EverydayShell — north star (#630)", () => {
  it("defaults to an honest empty live state, not the demo seed (#1181)", () => {
    render(<EverydayShell />);
    expect(screen.getAllByText("$0").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Northwind/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Dana/i)).not.toBeInTheDocument();
  });

  it("renders from the shared ipop experience token contract (#1068)", () => {
    const { container } = render(<EverydayShell data={seedEveryday()} />);
    const root = container.querySelector<HTMLElement>(".everyday-shell");

    expect(root).not.toBeNull();
    expect(root).toHaveStyle({
      "--ed-canvas": ipopExperienceTokens.color.canvas,
      "--ed-surface": ipopExperienceTokens.color.surface,
      "--ed-pop": ipopExperienceTokens.color.accent,
      "--ed-serif": ipopExperienceTokens.typography.serif,
      "--ed-sans": ipopExperienceTokens.typography.sans,
    });
  });

  it("shows paying customers and revenue up top", () => {
    render(<EverydayShell data={seedEveryday()} />);
    expect(screen.getByText(EVERYDAY.northStar.customersLabel)).toBeInTheDocument();
    expect(screen.getByText(EVERYDAY.northStar.revenueLabel)).toBeInTheDocument();
    expect(screen.getAllByText("$2,480").length).toBeGreaterThan(0);
    expect(screen.getAllByText("14").length).toBeGreaterThan(0);
  });

  it("reads the zero-customer state in voice, not as a failure", () => {
    render(<EverydayShell data={emptyData()} />);
    expect(screen.getByText(EVERYDAY.northStar.zero)).toBeInTheDocument();
  });
});

describe("EverydayShell — greeting + voice (#784)", () => {
  it("greets with a time-of-day, lowercase, cheeky line", () => {
    render(<EverydayShell data={seedEveryday("Gagan")} hour={14} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/afternoon, gagan/i);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/making pop today/i);
  });

  it("shows a useful starter chat when there is no work yet", () => {
    render(<EverydayShell data={emptyData()} />);
    expect(screen.getByText(/build ipop like Tomo/i)).toBeInTheDocument();
    expect(screen.getByText(/Mining category, product, user, time, space/i)).toBeInTheDocument();
  });
});

describe("EverydayShell — Tomo-simple cowork room (#1265)", () => {
  it("shows multiple agents working together, including an operator lane", () => {
    render(<EverydayShell data={seedEveryday()} />);
    const room = screen.getByRole("region", { name: EVERYDAY.room.heading });
    expect(within(room).getByRole("heading", { name: EVERYDAY.room.heading })).toBeInTheDocument();
    expect(within(room).getAllByText("Scout").length).toBeGreaterThan(0);
    expect(within(room).getAllByText("Quill").length).toBeGreaterThan(0);
    expect(within(room).getAllByText("Echo").length).toBeGreaterThan(0);
    expect(within(room).getAllByText("Lens").length).toBeGreaterThan(0);
    expect(within(room).getAllByText("Operator").length).toBeGreaterThan(0);
    expect(within(room).getByText(EVERYDAY.room.statuses.codex)).toBeInTheDocument();
    expect(within(room).queryByText(/Codex/i)).not.toBeInTheDocument();
  });

  it("starts the room from one input and lets the user chat into the room", async () => {
    const onStartRoom = vi.fn(async () => undefined);
    render(<EverydayShell data={emptyData()} onStartRoom={onStartRoom} />);
    fireEvent.change(screen.getByRole("textbox", { name: EVERYDAY.prompt }), {
      target: { value: "ipop.ai" },
    });
    fireEvent.click(screen.getByRole("button", { name: EVERYDAY.composerSend }));

    await waitFor(() => expect(onStartRoom).toHaveBeenCalledWith("ipop.ai"));
    expect(screen.getAllByText("ipop.ai").length).toBeGreaterThan(0);
    expect(screen.getAllByText(EVERYDAY.thread.working("Scout")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Scout/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Team engine active/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Codex subscription/i)).not.toBeInTheDocument();
  });

  it("does not show accepted room activity until the live team run is accepted", async () => {
    const onStartRoom = vi.fn(async () => {
      throw new Error("The team engine is not connected to your signed-in subscription yet.");
    });
    render(<EverydayShell data={emptyData()} onStartRoom={onStartRoom} />);
    fireEvent.change(screen.getByRole("textbox", { name: EVERYDAY.prompt }), {
      target: { value: "ipop.ai" },
    });
    fireEvent.click(screen.getByRole("button", { name: EVERYDAY.composerSend }));

    await waitFor(() => expect(onStartRoom).toHaveBeenCalledWith("ipop.ai"));
    expect(screen.getAllByText("ipop.ai").length).toBeGreaterThan(0);
    expect(
      await screen.findByText("The team engine is not connected to your signed-in subscription yet."),
    ).toBeInTheDocument();
    expect(screen.queryByText(EVERYDAY.thread.working("Scout"))).not.toBeInTheDocument();
    expect(screen.queryByText("I can take product/code handoffs once the team agrees what should ship.")).not.toBeInTheDocument();
    expect(screen.queryByText(/Codex/i)).not.toBeInTheDocument();
  });

  it("shows a CMO-style dashboard brief with pipeline, channels, blockers, and receipts", () => {
    render(<EverydayShell data={seedEveryday()} />);
    const dashboard = screen.getByRole("region", { name: EVERYDAY.dashboard.heading });
    expect(dashboard).toHaveAttribute("id", "dashboard");
    expect(within(dashboard).getByText(EVERYDAY.dashboard.funnel)).toBeInTheDocument();
    expect(within(dashboard).getByText(EVERYDAY.dashboard.channels)).toBeInTheDocument();
    expect(within(dashboard).getByText(EVERYDAY.dashboard.blockers)).toBeInTheDocument();
    expect(within(dashboard).getByText(EVERYDAY.dashboard.decisions)).toBeInTheDocument();
    expect(within(dashboard).getByText(EVERYDAY.dashboard.next)).toBeInTheDocument();
    expect(within(dashboard).getByText("customers")).toBeInTheDocument();
    expect(within(dashboard).getByText("qualified")).toBeInTheDocument();
    expect(within(dashboard).getByText("customer goal")).toBeInTheDocument();
    expect(within(dashboard).getByText("briefed")).toBeInTheDocument();
    expect(within(dashboard).getByText("workspace")).toBeInTheDocument();
    expect(within(dashboard).getByText(/needs CMO metrics feed/i)).toBeInTheDocument();
  });

  it("shows iMessage as the only messaging setup lane", () => {
    const onConnectorConnect = vi.fn();
    render(<EverydayShell data={seedEveryday()} onConnectorConnect={onConnectorConnect} />);
    const setup = screen.getByRole("region", { name: EVERYDAY.connectors.heading });
    expect(within(setup).getByRole("heading", { name: EVERYDAY.connectors.heading })).toBeInTheDocument();
    expect(within(setup).getByRole("region", { name: EVERYDAY.connectors.groups.visibility })).toBeInTheDocument();
    expect(within(setup).getByRole("region", { name: EVERYDAY.connectors.groups.productivity })).toBeInTheDocument();
    expect(within(setup).getByText("iMessage")).toBeInTheDocument();
    expect(within(setup).queryByText("WhatsApp")).not.toBeInTheDocument();
    expect(within(setup).queryByText("Telegram")).not.toBeInTheDocument();
    expect(within(setup).getByText("Gmail")).toBeInTheDocument();
    expect(within(setup).getByText("gagan@getfoolish.com")).toBeInTheDocument();
    expect(within(setup).getByText(EVERYDAY.connectors.connected)).toBeInTheDocument();
    const buttons = within(setup).getAllByRole("button", { name: /connect|set up iMessage/i });
    expect(buttons.length).toBeGreaterThan(0);
    fireEvent.click(buttons[0]!);
    expect(onConnectorConnect).toHaveBeenCalled();
  });

  it("routes public dashboard connector actions to the workspace instead of rendering no-op buttons", () => {
    render(<EverydayShell data={ipopDogfoodEveryday()} dashboardFirst />);
    const setup = screen.getByRole("region", { name: EVERYDAY.connectors.heading });

    const links = within(setup).getAllByRole("link", { name: EVERYDAY.connectors.publicAction });
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((link) => link.getAttribute("href") === APP_ROUTES.everyday)).toBe(true);
    expect(within(setup).getAllByText(EVERYDAY.connectors.publicHint).length).toBeGreaterThan(0);
    expect(within(setup).queryByRole("button", { name: /connect|set up iMessage|notify me/i })).not.toBeInTheDocument();
  });
});

describe("EverydayShell — approval queue is a ship decision (#572/#574/#632)", () => {
  it("renders the finished deliverable body, not internal chatter", () => {
    render(<EverydayShell data={seedEveryday()} />);
    // The actual artifact text (the warm-lead reply) is on the card.
    expect(screen.getByText(/thanks for the kind words about the demo/i)).toBeInTheDocument();
    // It is labelled as the finished deliverable.
    expect(screen.getAllByText(EVERYDAY.approvals.deliverableEyebrow).length).toBeGreaterThan(0);
  });

  it("offers ship / redo as the one-glance decision", () => {
    render(<EverydayShell data={seedEveryday()} />);
    expect(screen.getAllByRole("button", { name: EVERYDAY.approvals.ship }).length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByRole("button", { name: EVERYDAY.approvals.redo }).length).toBeGreaterThan(
      0,
    );
  });

  it("records ship through the approval gate before removing the card (#1182)", async () => {
    const actions = approvalActions();
    const data = emptyData({
      approvals: [
        {
          id: "only",
          approvalRequestId: "apr_only",
          agent: "Comet",
          deliverable: {
            title: "a reply",
            kind: "draft",
            preview: "hello there, this is a real draft.",
          },
          consequence: "send it",
          costsMoney: false,
        },
      ],
    });
    render(<EverydayShell data={data} approvalActions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: EVERYDAY.approvals.ship }));
    expect(actions.ship).toHaveBeenCalledWith(data.approvals[0]);
    await waitFor(() => expect(screen.getByText(EVERYDAY.celebrate.shipped)).toBeInTheDocument());
    expect(screen.getByText(EVERYDAY.approvals.empty)).toBeInTheDocument();
  });

  it("records redo as a revision request with reviewer note (#1182)", async () => {
    const actions = approvalActions();
    render(<EverydayShell data={seedEveryday()} approvalActions={actions} />);
    const card = screen.getByText("reply to a warm lead in your inbox").closest("article")!;

    fireEvent.click(within(card).getByRole("button", { name: EVERYDAY.approvals.redo }));
    fireEvent.change(within(card).getByRole("textbox", { name: EVERYDAY.approvals.redoNote }), {
      target: { value: "make this warmer" },
    });
    fireEvent.click(within(card).getByRole("button", { name: EVERYDAY.approvals.redoSend }));

    expect(actions.requestRevision).toHaveBeenCalledWith(seedEveryday().approvals[0], "make this warmer");
    await waitFor(() => expect(screen.getByText(EVERYDAY.celebrate.shipped)).toBeInTheDocument());
  });

  it("keeps the card visible and shows failure when the approval API rejects (#1182)", async () => {
    const actions = approvalActions();
    actions.ship.mockRejectedValueOnce(new Error("backend said no"));
    render(<EverydayShell data={seedEveryday()} approvalActions={actions} />);
    const card = screen.getByText("reply to a warm lead in your inbox").closest("article")!;

    fireEvent.click(within(card).getByRole("button", { name: EVERYDAY.approvals.ship }));

    await waitFor(() => expect(within(card).getByRole("alert")).toHaveTextContent("backend said no"));
    expect(screen.getByText("reply to a warm lead in your inbox")).toBeInTheDocument();
  });
});

describe("EverydayShell — money is the one hard gate (#784)", () => {
  it("surfaces the money gate on a spend card", () => {
    render(<EverydayShell data={seedEveryday()} />);
    expect(screen.getByTestId("money-gate")).toHaveTextContent(EVERYDAY.safety.moneyGate);
  });

  it("requires a second explicit confirm before a spend ships", () => {
    const data = emptyData({
      approvals: [
        {
          id: "spend",
          approvalRequestId: "apr_spend",
          agent: "Ada",
          deliverable: {
            title: "a boost",
            kind: "draft",
            preview: "boost this post to the right people.",
          },
          consequence: "spend on a boost",
          costsMoney: true,
          amount: "$40",
        },
      ],
    });
    const actions = approvalActions();
    render(<EverydayShell data={data} approvalActions={actions} />);
    const card = screen.getByText("a boost").closest("article")!;
    // First click does NOT ship — it asks for confirmation in voice.
    fireEvent.click(within(card).getByRole("button", { name: EVERYDAY.approvals.ship }));
    expect(
      within(card).getByRole("button", { name: EVERYDAY.safety.moneyGateApprove }),
    ).toBeInTheDocument();
    expect(screen.queryByText(EVERYDAY.celebrate.shipped)).not.toBeInTheDocument();
    // Confirming spends it.
    fireEvent.click(within(card).getByRole("button", { name: EVERYDAY.safety.moneyGateApprove }));
    expect(actions.ship).toHaveBeenCalledWith(data.approvals[0]);
    return waitFor(() => expect(screen.getByText(EVERYDAY.celebrate.shipped)).toBeInTheDocument());
  });
});

describe("EverydayShell — transparency + kill switch (#629/#784)", () => {
  it("lists every external action with a time, and links every receipt (#625/#629)", () => {
    render(<EverydayShell data={seedEveryday()} />);
    const log = screen.getByLabelText(EVERYDAY.transparency.heading);
    expect(within(log).getByText("8:55 am")).toBeInTheDocument();
    expect(within(log).getAllByRole("link").length).toBe(seedEveryday().transparency.length);
    expect(within(log).getByRole("link", { name: "open live page" })).toHaveAttribute(
      "href",
      "https://ipop.ai/launch",
    );
    expect(within(log).getByRole("link", { name: "open sent email" })).toHaveAttribute(
      "href",
      "https://mail.google.com/mail/u/0/#sent/ipop-dana-northwind-trial",
    );
    expect(within(log).getByRole("link", { name: "open signup" })).toHaveAttribute(
      "href",
      "https://dashboard.stripe.com/customers/cus_northwind_trial",
    );
  });

  it("undoes a reversible public action from the activity log in one click (#628)", () => {
    render(<EverydayShell data={seedEveryday()} />);
    const log = screen.getByLabelText(EVERYDAY.transparency.heading);
    expect(within(log).getByText(/published the launch page update/i)).toBeInTheDocument();

    fireEvent.click(within(log).getByRole("button", { name: "unpublish" }));

    expect(within(log).queryByRole("button", { name: "unpublish" })).not.toBeInTheDocument();
    expect(within(log).getByText(EVERYDAY.transparency.undone)).toBeInTheDocument();
  });

  it("searches the external-action log without dropping receipt links", () => {
    render(<EverydayShell data={seedEveryday()} />);
    const log = screen.getByLabelText(EVERYDAY.transparency.heading);
    const search = within(log).getByRole("searchbox", { name: EVERYDAY.transparency.searchLabel });

    fireEvent.change(search, { target: { value: "reddit" } });
    expect(within(log).getByText("11:28 am")).toBeInTheDocument();
    expect(within(log).getByText(/public reddit threads/i)).toBeInTheDocument();
    expect(within(log).queryByText(/warm-lead reply/i)).not.toBeInTheDocument();
    expect(within(log).getByRole("link", { name: "open thread" })).toHaveAttribute(
      "href",
      "https://reddit.com/r/marketing",
    );
  });

  it("shows the always-on kill switch as reassurance, not config", () => {
    render(<EverydayShell data={seedEveryday()} />);
    expect(screen.getByText(EVERYDAY.safety.killSwitchTitle)).toBeInTheDocument();
    expect(screen.getByText(EVERYDAY.safety.killSwitchBody)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: EVERYDAY.safety.killSwitchAction }),
    ).toBeInTheDocument();
  });
});
