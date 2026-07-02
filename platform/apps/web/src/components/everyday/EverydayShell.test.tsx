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
import { type ApprovalCard, type EverydayData } from "./everyday-data.js";
import { ipopDogfoodEveryday, seedEveryday } from "./__fixtures__/everyday-fixtures.js";
import { EVERYDAY } from "../../brand.js";
import { APP_ROUTES } from "../../routing.js";
import { ipopExperienceLightTokens, ipopExperienceTokens } from "../../design/ipop-experience-tokens.js";

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

  it("uses the light homepage token set for public dashboard embeds (#1532)", () => {
    const { container } = render(<EverydayShell data={emptyData()} dashboardFirst dashboardOnly theme="public" />);
    const root = container.querySelector<HTMLElement>(".everyday-shell");

    expect(root).not.toBeNull();
    expect(root).toHaveClass("everyday-shell--public");
    expect(root).toHaveStyle({
      "--ed-canvas": ipopExperienceLightTokens.color.canvas,
      "--ed-surface": ipopExperienceLightTokens.color.surface,
      "--ed-text": ipopExperienceLightTokens.color.text,
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

  it("hides raw shell/tool invocations from the user-facing iMessage room (#1463)", () => {
    render(
      <EverydayShell
        data={emptyData({
          thread: [
            {
              id: "leaked-tool",
              kind: "agent-line",
              agent: "Scout",
              at: "now",
              text: `/bin/sh -lc "sed -n '1,220p' ipop_homepage_clarity_receipt.md"`,
            },
            {
              id: "leaked-member-tool",
              kind: "agent-line",
              agent: "gagan",
              at: "now",
              text: `/bin/sh -lc "node -e fetch('https://ipop.ai/').then(r=>r.text())"`,
            },
            {
              id: "leaked-codex-tool",
              kind: "agent-line",
              agent: "Lens",
              at: "now",
              text: `🔧 /bin/sh -lc "node - <<'NODE'\nfetch('https://ipop.ai/')\nNODE"`,
            },
            {
              id: "team-event-json",
              kind: "agent-line",
              agent: "Scout",
              at: "now",
              text:
                '::team-event:: {"teamRunId":"tr1","subtaskId":"s1","agentMemberId":"a1","kind":"started","summary":"started: Scout site read","branch":"b","createdAt":"2026-07-01T00:00:00.000Z"}',
            },
            {
              id: "leaked-deliverable",
              kind: "deliverable",
              agent: "Quill",
              at: "now",
              deliverable: {
                title: "Homepage receipt",
                kind: "draft",
                preview: "sed -n '1,220p' ipop_homepage_clarity_receipt.md",
              },
            },
          ],
        })}
      />,
    );

    const room = screen.getByRole("region", { name: EVERYDAY.room.heading });
    expect(within(room).queryByText(/\/bin\/sh -lc/i)).not.toBeInTheDocument();
    expect(within(room).queryByText(/node -e/i)).not.toBeInTheDocument();
    expect(within(room).queryByText(/ipop_homepage_clarity_receipt\.md/i)).not.toBeInTheDocument();
    expect(within(room).queryByText(/::team-event::/i)).not.toBeInTheDocument();
    expect(within(room).getByText("started: Scout site read")).toBeInTheDocument();
    expect(within(room).getAllByText(EVERYDAY.thread.internalToolActivity)).toHaveLength(4);
  });

  it("starts the room from one input and lets the user chat into the room", async () => {
    const onStartRoom = vi.fn(async () => undefined);
    render(<EverydayShell data={emptyData()} onStartRoom={onStartRoom} />);
    expect(screen.getByText(EVERYDAY.room.imessageNotes.setupNeeded)).toBeInTheDocument();
    expect(screen.queryByText(/Until the native relay is live/i)).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: EVERYDAY.prompt }), {
      target: { value: "ipop.ai" },
    });
    fireEvent.click(screen.getByRole("button", { name: EVERYDAY.composerSend }));

    await waitFor(() => expect(onStartRoom).toHaveBeenCalledWith("ipop.ai"));
    expect(screen.getAllByText("ipop.ai").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Reading ipop\.ai and lining up/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Scout/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Team engine active/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Codex subscription/i)).not.toBeInTheDocument();
  });

  it("replaces stale first-run chat with the owner's new target when the room starts (#1466)", async () => {
    const onStartRoom = vi.fn(async () => undefined);
    render(
      <EverydayShell
        data={emptyData({
          thread: [
            {
              id: "old-acme-scout",
              kind: "agent-line",
              agent: "Scout",
              at: "first run",
              text: "read acme.com and found the offer gap",
            },
            {
              id: "old-acme-quill",
              kind: "deliverable",
              agent: "Quill",
              at: "queued",
              deliverable: {
                title: "acme-week-one-homepage-clarity.md",
                kind: "draft",
                preview: "drafting launch copy for acme.com",
              },
            },
          ],
        })}
        onStartRoom={onStartRoom}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: EVERYDAY.prompt }), {
      target: { value: "ipop.ai — an AI marketing team" },
    });
    fireEvent.click(screen.getByRole("button", { name: EVERYDAY.composerSend }));

    await waitFor(() => expect(onStartRoom).toHaveBeenCalledWith("ipop.ai — an AI marketing team"));
    const room = screen.getByRole("region", { name: EVERYDAY.room.heading });
    expect(within(room).getByText("ipop.ai — an AI marketing team")).toBeInTheDocument();
    expect(within(room).getByText(/Reading ipop\.ai/i)).toBeInTheDocument();
    expect(within(room).queryByText(/acme/i)).not.toBeInTheDocument();
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
    await waitFor(() =>
      expect(screen.getAllByText("The team engine is not connected to your signed-in subscription yet.").length).toBeGreaterThan(0),
    );
    expect(screen.queryByText(/Reading ipop\.ai and lining up/i)).not.toBeInTheDocument();
    expect(screen.queryByText("I can take product/code handoffs once the team agrees what should ship.")).not.toBeInTheDocument();
    expect(screen.queryByText(/Codex/i)).not.toBeInTheDocument();
  });

  it("shows a plain-language marketing dashboard with channels, decisions, and receipts", () => {
    render(<EverydayShell data={seedEveryday()} />);
    const dashboard = screen.getByRole("region", { name: EVERYDAY.dashboard.heading });
    expect(dashboard).toHaveAttribute("id", "dashboard");
    expect(within(dashboard).getByText(EVERYDAY.dashboard.funnel)).toBeInTheDocument();
    expect(within(dashboard).getByText(EVERYDAY.dashboard.channels)).toBeInTheDocument();
    expect(within(dashboard).getByText(EVERYDAY.dashboard.since)).toBeInTheDocument();
    expect(within(dashboard).getByText(EVERYDAY.dashboard.executive)).toBeInTheDocument();
    expect(within(dashboard).getByText(EVERYDAY.dashboard.rankedWork)).toBeInTheDocument();
    expect(within(dashboard).getByText(EVERYDAY.dashboard.capacity)).toBeInTheDocument();
    expect(within(dashboard).getAllByText(EVERYDAY.dashboard.blockers).length).toBeGreaterThan(0);
    expect(within(dashboard).getByText(EVERYDAY.dashboard.decisions)).toBeInTheDocument();
    expect(within(dashboard).getByText(EVERYDAY.dashboard.next)).toBeInTheDocument();
    expect(within(dashboard).getByText("customers")).toBeInTheDocument();
    expect(within(dashboard).getByText("visible work")).toBeInTheDocument();
    expect(within(dashboard).getByText("new customers")).toBeInTheDocument();
    expect(within(dashboard).getByText("needs your review")).toBeInTheDocument();
    expect(within(dashboard).getByText("channels to connect")).toBeInTheDocument();
    expect(within(dashboard).getAllByText("first campaign platform").length).toBeGreaterThan(0);
    expect(within(dashboard).getByText("usable asset ready for a connected channel")).toBeInTheDocument();
    expect(within(dashboard).getByText("campaigns running")).toBeInTheDocument();
    expect(within(dashboard).getByText("team members active")).toBeInTheDocument();
    expect(within(dashboard).queryByText("Upgrade to keep the whole agent room active")).not.toBeInTheDocument();
    expect(within(dashboard).queryByRole("link", { name: "View Pro" })).not.toBeInTheDocument();
    expect(within(dashboard).getByText("monthly work budget")).toBeInTheDocument();
    expect(within(dashboard).getByText("team members")).toBeInTheDocument();
    expect(within(dashboard).getByText("connected channels")).toBeInTheDocument();
    expect(within(dashboard).getByText("approvals")).toBeInTheDocument();
    expect(within(dashboard).getByText("customer goal")).toBeInTheDocument();
    expect(within(dashboard).getByText("briefed")).toBeInTheDocument();
    expect(within(dashboard).getByText("workspace")).toBeInTheDocument();
    expect(within(dashboard).getByText(/operator lane ready/i)).toBeInTheDocument();
    expect(within(dashboard).queryByText(/needs CMO metrics feed/i)).not.toBeInTheDocument();
    expect(within(dashboard).getAllByText("live").length).toBeGreaterThan(0);
    // #1533: the setup checklist reads in plain customer words, not engineering labels.
    expect(within(dashboard).getByText(EVERYDAY.dashboard.readiness)).toBeInTheDocument();
    expect(within(dashboard).getByText("Sign-in")).toBeInTheDocument();
    expect(within(dashboard).getByText("Connected channels")).toBeInTheDocument();
    expect(within(dashboard).getByText("First result")).toBeInTheDocument();
    expect(within(dashboard).getByText("Sending")).toBeInTheDocument();
    expect(within(dashboard).getByText("Plan & billing")).toBeInTheDocument();
    expect(within(dashboard).getByText("Activity tracking")).toBeInTheDocument();
    expect(within(dashboard).getByText("Privacy & trust")).toBeInTheDocument();
  });

  it("can render the dashboard as a focused one-icon summary without the full workspace below it", () => {
    render(<EverydayShell data={seedEveryday()} dashboardFirst dashboardOnly />);

    expect(screen.getByRole("region", { name: EVERYDAY.dashboard.heading })).toHaveAttribute(
      "id",
      "dashboard",
    );
    expect(screen.queryByRole("heading", { name: EVERYDAY.room.heading })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: EVERYDAY.connectors.heading })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: EVERYDAY.approvals.heading })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: EVERYDAY.transparency.heading })).not.toBeInTheDocument();
  });

  it("labels public dogfood dashboard metrics by proof class instead of implying sample traction is live", () => {
    // #1533: this is the internal dogfooding readout, so it renders with the build-receipt proof lines shown.
    render(<EverydayShell data={ipopDogfoodEveryday()} dashboardFirst internal />);
    const dashboard = screen.getByRole("region", { name: EVERYDAY.dashboard.heading });
    const metrics = within(dashboard).getByRole("list", { name: EVERYDAY.dashboard.heading + " metrics" });

    expect(within(metrics).getAllByText("external proof").length).toBeGreaterThan(0);
    expect(within(metrics).getAllByText("live").length).toBeGreaterThan(0);
    expect(within(metrics).queryByText("sample")).not.toBeInTheDocument();
    expect(within(dashboard).getByText(EVERYDAY.dashboard.since)).toBeInTheDocument();
    expect(within(dashboard).getByText(EVERYDAY.dashboard.executive)).toBeInTheDocument();
    expect(within(dashboard).getByText(EVERYDAY.dashboard.rankedWork)).toBeInTheDocument();
    expect(within(dashboard).getByText(EVERYDAY.dashboard.capacity)).toBeInTheDocument();
    expect(within(dashboard).getByText("External customer proof remains zero")).toBeInTheDocument();
    expect(within(dashboard).getByText("no external leads qualified or contacted")).toBeInTheDocument();
    expect(within(dashboard).getByText("changed homepage direction, but did not create customer flow")).toBeInTheDocument();
    expect(within(dashboard).getByText("blocked until one provider has a sent-message receipt")).toBeInTheDocument();
    expect(within(dashboard).getByText("do not upsell until the first lane creates value")).toBeInTheDocument();
    expect(within(dashboard).getAllByText("zero signup/payment/customer approval receipts").length).toBeGreaterThan(0);
    expect(within(dashboard).getByText("Google sign-in and signed-in team runtime remain the gate")).toBeInTheDocument();
  });

  it("#1533: hides internal build-receipt jargon from the customer view but keeps the honesty chip + plain help", () => {
    // Default render = customer view (internal off). The build receipts must NOT leak onto a customer surface.
    render(<EverydayShell data={ipopDogfoodEveryday()} dashboardFirst />);
    const dashboard = screen.getByRole("region", { name: EVERYDAY.dashboard.heading });
    const metrics = within(dashboard).getByRole("list", { name: EVERYDAY.dashboard.heading + " metrics" });

    // The internal build-receipt lines behind each metric (the "proof" chatter) are hidden from a customer…
    expect(within(dashboard).queryByText("zero signup/payment/customer approval receipts")).not.toBeInTheDocument();
    // …but the live/sample/external honesty chip and the plain setup labels stay, so nothing misleads a customer.
    expect(within(metrics).getAllByText("external proof").length).toBeGreaterThan(0);
    expect(within(dashboard).getByText("Sign-in")).toBeInTheDocument();
    expect(within(dashboard).getByText("Connected channels")).toBeInTheDocument();
  });

  it("#1533: internal flag reveals the build-receipt proof lines for a dogfooding session", () => {
    render(<EverydayShell data={ipopDogfoodEveryday()} dashboardFirst internal />);
    const dashboard = screen.getByRole("region", { name: EVERYDAY.dashboard.heading });

    expect(within(dashboard).getAllByText("zero signup/payment/customer approval receipts").length).toBeGreaterThan(0);
    expect(within(dashboard).getByText("Google sign-in and signed-in team runtime remain the gate")).toBeInTheDocument();
  });

  it("keeps the empty marketing dashboard honest with blocked ranked work instead of fake traction", () => {
    render(<EverydayShell data={emptyData()} dashboardFirst dashboardOnly />);
    const dashboard = screen.getByRole("region", { name: EVERYDAY.dashboard.heading });

    expect(within(dashboard).getByText(EVERYDAY.dashboard.rankedWork)).toBeInTheDocument();
    expect(within(dashboard).getByText("real acquisition channel")).toBeInTheDocument();
    expect(within(dashboard).getByText("blocked work cannot create leads until a provider is connected")).toBeInTheDocument();
    expect(within(dashboard).getByText("0 customers")).toBeInTheDocument();
  });

  it("offers a channel connect action from the focused dashboard when connectors are blocked (#1522)", () => {
    const onConnectorConnect = vi.fn();
    render(
      <EverydayShell
        data={emptyData({
          connectors: [
            {
              id: "telegram_room",
              group: "visibility",
              name: "Telegram room",
              status: "available",
              detail: "open the bot-native connect flow.",
              actionLabel: "connect",
            },
          ],
        })}
        dashboardFirst
        dashboardOnly
        onConnectorConnect={onConnectorConnect}
      />,
    );

    const dashboard = screen.getByRole("region", { name: EVERYDAY.dashboard.heading });
    fireEvent.click(within(dashboard).getByRole("button", { name: /connect telegram room/i }));
    expect(onConnectorConnect).toHaveBeenCalledWith("telegram_room");
  });

  it("shows all room visibility lanes without pretending external transports are live", () => {
    const onConnectorConnect = vi.fn();
    render(<EverydayShell data={seedEveryday()} onConnectorConnect={onConnectorConnect} />);
    const setup = screen.getByRole("region", { name: EVERYDAY.connectors.heading });
    expect(within(setup).getByRole("heading", { name: EVERYDAY.connectors.heading })).toBeInTheDocument();
    expect(within(setup).getByRole("region", { name: EVERYDAY.connectors.groups.visibility })).toBeInTheDocument();
    expect(within(setup).getByRole("region", { name: EVERYDAY.connectors.groups.productivity })).toBeInTheDocument();
    expect(within(setup).getByText("Web room")).toBeInTheDocument();
    expect(within(setup).getByText("iMessage")).toBeInTheDocument();
    expect(within(setup).getByText("WhatsApp room")).toBeInTheDocument();
    expect(within(setup).getByText("Telegram room")).toBeInTheDocument();
    expect(within(setup).getAllByText("notify me").length).toBeGreaterThanOrEqual(2);
    expect(within(setup).getByText("Gmail")).toBeInTheDocument();
    expect(within(setup).getByText("gagan@getfoolish.com")).toBeInTheDocument();
    expect(within(setup).getByText(EVERYDAY.connectors.connected)).toBeInTheDocument();
    const buttons = within(setup).getAllByRole("button", { name: /connect|set up iMessage/i });
    expect(buttons.length).toBeGreaterThan(0);
    fireEvent.click(buttons[0]!);
    expect(onConnectorConnect).toHaveBeenCalled();
  });

  it("shows visible feedback after a connect click resolves (#1551)", async () => {
    const onConnectorConnect = vi.fn(async () => ({ outcome: "waitlisted" as const }));
    render(
      <EverydayShell
        data={emptyData({
          connectors: [
            {
              id: "linkedin",
              group: "marketing",
              name: "LinkedIn",
              status: "coming_soon",
              detail: "native LinkedIn posting is not live yet.",
              actionLabel: "notify me",
            },
          ],
        })}
        onConnectorConnect={onConnectorConnect}
      />,
    );
    const setup = screen.getByRole("region", { name: EVERYDAY.connectors.heading });
    fireEvent.click(within(setup).getByRole("button", { name: "notify me" }));
    expect(onConnectorConnect).toHaveBeenCalledWith("linkedin");
    expect(await within(setup).findByText(EVERYDAY.connectors.outcome.waitlisted)).toBeInTheDocument();
  });

  it("surfaces an error when a connect click fails instead of failing silently (#1551)", async () => {
    const onConnectorConnect = vi.fn(async () => {
      throw new Error("network down");
    });
    render(
      <EverydayShell
        data={emptyData({
          connectors: [
            {
              id: "email",
              group: "productivity",
              name: "Email",
              status: "available",
              detail: "email, replies, and follow-up receipts.",
              actionLabel: "connect",
            },
          ],
        })}
        onConnectorConnect={onConnectorConnect}
      />,
    );
    const setup = screen.getByRole("region", { name: EVERYDAY.connectors.heading });
    fireEvent.click(within(setup).getByRole("button", { name: "connect" }));
    expect(await within(setup).findByRole("alert")).toHaveTextContent(EVERYDAY.connectors.connectError);
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

describe("EverydayShell — CMO summary strip (#1456) provenance is honest in every state", () => {
  const connector = (
    id: string,
    group: EverydayData["connectors"][number]["group"],
    status: EverydayData["connectors"][number]["status"],
    name = id,
  ): EverydayData["connectors"][number] => ({ id, group, name, status, detail: "", actionLabel: "connect" });

  const receipt = (id: string): EverydayData["transparency"][number] => ({
    id,
    at: "2:14 pm",
    action: "shipped a landing page revision",
    href: "https://example.com/pr/" + id,
    receiptLabel: "see the PR",
  });

  function strip(over: Partial<EverydayData> = {}) {
    render(<EverydayShell data={emptyData(over)} dashboardFirst dashboardOnly showCmoSummary />);
    return screen.getByRole("region", { name: "CMO summary" });
  }

  it("stays hidden by default (new surface ships default-OFF behind the owner-first flag)", () => {
    render(<EverydayShell data={emptyData()} dashboardFirst dashboardOnly />);
    expect(screen.queryByRole("region", { name: "CMO summary" })).not.toBeInTheDocument();
  });

  it("empty state: never fabricates a number, money stays owner-gated, internal zeros stay honest", () => {
    const cmo = strip();
    // all six CMO questions render
    expect(within(cmo).getByText("pipeline touched")).toBeInTheDocument();
    expect(within(cmo).getByText("qualified leads")).toBeInTheDocument();
    expect(within(cmo).getByText("assets shipped")).toBeInTheDocument();
    expect(within(cmo).getByText("spend / revenue")).toBeInTheDocument();
    expect(within(cmo).getByText("waiting on you")).toBeInTheDocument();
    expect(within(cmo).getByText("channels live")).toBeInTheDocument();
    // unconnected sources read "not connected yet", NOT a fake "0"
    expect(within(cmo).getAllByText("not connected yet").length).toBeGreaterThanOrEqual(3);
    expect(within(cmo).getAllByText("not connected").length).toBeGreaterThan(0);
    // money is blocked — needs owner, never auto
    expect(within(cmo).getAllByText("blocked — needs owner").length).toBeGreaterThan(0);
    expect(within(cmo).getAllByText("needs you").length).toBeGreaterThan(0);
    // approvals + channels are internally measurable, so a real "0" is honest with a receipt badge
    expect(within(cmo).getAllByText("receipt").length).toBeGreaterThanOrEqual(2);
    // no upgrade prompt without real value behind a limit
    expect(within(cmo).queryByRole("note")).not.toBeInTheDocument();
  });

  it("partially-connected state: a connected source is receipt-backed, a blocked one needs the owner", () => {
    const cmo = strip({
      connectors: [
        connector("hubspot", "marketing", "connected", "HubSpot"),
        connector("ga4", "visibility", "blocked", "Analytics"),
        connector("wordpress", "publishing", "available", "WordPress"),
      ],
    });
    // leads sourced from a connected marketing connector → receipt
    expect(within(cmo).getByText(/HubSpot connected/)).toBeInTheDocument();
    // pipeline's only source (analytics) is blocked → blocked, needs owner
    expect(within(cmo).getByText(/connect Analytics to track pipeline/)).toBeInTheDocument();
    // channels honestly reports the blocked one
    expect(within(cmo).getByText(/1 live · 1 blocked/)).toBeInTheDocument();
  });

  it("active-work state: shipped is a receipt-backed count with a real link, and a connect moment appears", () => {
    const cmo = strip({
      connectors: [
        connector("wordpress", "publishing", "connected", "WordPress"),
        connector("linkedin", "publishing", "blocked", "LinkedIn"),
      ],
      approvals: [
        {
          id: "ar-1",
          approvalRequestId: "ar-1",
          agent: "scout",
          deliverable: { title: "draft", kind: "draft", preview: "hi" },
          consequence: "sends an email",
          costsMoney: false,
        },
        {
          id: "ar-2",
          approvalRequestId: "ar-2",
          agent: "scout",
          deliverable: { title: "draft", kind: "draft", preview: "hi" },
          consequence: "spends ad budget",
          costsMoney: true,
        },
      ],
      transparency: [receipt("a"), receipt("b"), receipt("c")],
    });
    // shipped = 3 with a real receipt link
    expect(within(cmo).getByText("3")).toBeInTheDocument();
    const receiptLink = within(cmo).getByRole("link", { name: "see receipt" });
    expect(receiptLink).toHaveAttribute("href", "https://example.com/pr/c");
    // approvals = 2 waiting on the owner
    expect(within(cmo).getByText("2")).toBeInTheDocument();
    // upgrade/connect moment is tied to proven value behind a blocked channel
    const note = within(cmo).getByRole("note");
    expect(within(note).getByText("Connect LinkedIn")).toBeInTheDocument();
    expect(within(note).getByText(/3 shipped receipt\(s\)/)).toBeInTheDocument();
    // revenue is STILL blocked even though real work is landing
    expect(within(cmo).getByText(/owner must connect billing/)).toBeInTheDocument();
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

  it("confirms, engages, and resumes the fleet switch with visible feedback (#1468)", async () => {
    const onEmergencyStop = vi.fn(async () => undefined);
    const onResumeFleet = vi.fn(async () => undefined);
    render(
      <EverydayShell
        data={seedEveryday()}
        onEmergencyStop={onEmergencyStop}
        onResumeFleet={onResumeFleet}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: EVERYDAY.safety.killSwitchAction }));
    expect(screen.getByRole("status")).toHaveTextContent(EVERYDAY.safety.killSwitchConfirm);

    fireEvent.click(screen.getByRole("button", { name: EVERYDAY.safety.killSwitchAction }));

    await waitFor(() => expect(onEmergencyStop).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status")).toHaveTextContent(EVERYDAY.safety.killSwitchEngaged);
    expect(screen.getByRole("button", { name: EVERYDAY.safety.killSwitchResume })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: EVERYDAY.safety.killSwitchResume }));

    await waitFor(() => expect(onResumeFleet).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: EVERYDAY.safety.killSwitchAction })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("surfaces a failed fleet-stop instead of silently doing nothing (#1468)", async () => {
    render(
      <EverydayShell
        data={seedEveryday()}
        onEmergencyStop={vi.fn(async () => {
          throw new Error("nope");
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: EVERYDAY.safety.killSwitchAction }));
    fireEvent.click(screen.getByRole("button", { name: EVERYDAY.safety.killSwitchAction }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(EVERYDAY.safety.killSwitchError),
    );
  });
});
