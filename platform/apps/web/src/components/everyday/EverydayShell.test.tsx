/**
 * Everyday workspace shell render tests (#784). These lock the surface the issue specifies:
 *   · the north star (customers + revenue) is visible up top;
 *   · the approval queue shows the FINISHED deliverable as a one-glance ship decision — never chatter;
 *   · money is the one hard gate (a spend takes a second, explicit confirm);
 *   · the transparency log lists every external action, timestamped + linked;
 *   · the kill switch is always on, framed as reassurance;
 *   · empty states + the greeting read in the cheeky Innocent voice.
 */
import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { EverydayShell } from "./EverydayShell.js";
import { seedEveryday, type EverydayData } from "./everyday-data.js";
import { EVERYDAY } from "../../brand.js";

function emptyData(over: Partial<EverydayData> = {}): EverydayData {
  return {
    memberName: "gagan",
    northStar: { customers: 0, customersDelta: 0, revenue: "$0", revenueDelta: "—", trend: "zero" },
    thread: [],
    approvals: [],
    transparency: [],
    fleetPaused: false,
    ...over,
  };
}

describe("EverydayShell — north star (#630)", () => {
  it("shows paying customers and revenue up top", () => {
    render(<EverydayShell data={seedEveryday()} />);
    expect(screen.getByText(EVERYDAY.northStar.customersLabel)).toBeInTheDocument();
    expect(screen.getByText(EVERYDAY.northStar.revenueLabel)).toBeInTheDocument();
    expect(screen.getByText("$2,480")).toBeInTheDocument();
    expect(screen.getByText("14")).toBeInTheDocument();
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

  it("shows the cheeky empty-thread state + nudge when there is no work", () => {
    render(<EverydayShell data={emptyData()} />);
    expect(screen.getByText(EVERYDAY.thread.empty)).toBeInTheDocument();
    expect(screen.getByText(EVERYDAY.thread.nudge)).toBeInTheDocument();
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

  it("celebrates — and removes the card — after shipping", () => {
    const data = emptyData({
      approvals: [
        {
          id: "only",
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
    render(<EverydayShell data={data} />);
    fireEvent.click(screen.getByRole("button", { name: EVERYDAY.approvals.ship }));
    expect(screen.getByText(EVERYDAY.celebrate.shipped)).toBeInTheDocument();
    expect(screen.getByText(EVERYDAY.approvals.empty)).toBeInTheDocument();
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
    render(<EverydayShell data={data} />);
    const card = screen.getByText("a boost").closest("article")!;
    // First click does NOT ship — it asks for confirmation in voice.
    fireEvent.click(within(card).getByRole("button", { name: EVERYDAY.approvals.ship }));
    expect(
      within(card).getByRole("button", { name: EVERYDAY.safety.moneyGateApprove }),
    ).toBeInTheDocument();
    expect(screen.queryByText(EVERYDAY.celebrate.shipped)).not.toBeInTheDocument();
    // Confirming spends it.
    fireEvent.click(within(card).getByRole("button", { name: EVERYDAY.safety.moneyGateApprove }));
    expect(screen.getByText(EVERYDAY.celebrate.shipped)).toBeInTheDocument();
  });
});

describe("EverydayShell — transparency + kill switch (#629/#784)", () => {
  it("lists every external action with a time, and links the ones with a url", () => {
    render(<EverydayShell data={seedEveryday()} />);
    const log = screen.getByLabelText(EVERYDAY.transparency.heading);
    expect(within(log).getByText("8:55 am")).toBeInTheDocument();
    expect(
      within(log).getAllByRole("link", { name: EVERYDAY.transparency.viewLink }).length,
    ).toBeGreaterThan(0);
  });

  it("undoes a reversible public action from the activity log in one click (#628)", () => {
    render(<EverydayShell data={seedEveryday()} />);
    const log = screen.getByLabelText(EVERYDAY.transparency.heading);
    expect(within(log).getByText(/published the launch page update/i)).toBeInTheDocument();

    fireEvent.click(within(log).getByRole("button", { name: "unpublish" }));

    expect(within(log).queryByRole("button", { name: "unpublish" })).not.toBeInTheDocument();
    expect(within(log).getByText(EVERYDAY.transparency.undone)).toBeInTheDocument();
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
