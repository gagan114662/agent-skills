import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ShortFormBlitzSurface, type ShortFormPublishingSeam } from "./ShortFormBlitzSurface.js";

function seam(over: Partial<ShortFormPublishingSeam> = {}): ShortFormPublishingSeam {
  return {
    listDrafts: vi.fn().mockResolvedValue([
      {
        id: "draft-1",
        title: "Launch-week demo cut",
        platform: "tiktok",
        hook: "Open with the before/after dashboard moment.",
        owner: "Quill",
        durationSec: 34,
        createdAt: "2026-06-22T12:00:00Z",
        approvalRequestId: "appr-1",
      },
      {
        id: "draft-2",
        title: "Founder proof cut",
        platform: "instagram",
        hook: "Lead with the approved revenue screen.",
        owner: "Scout",
        durationSec: 28,
        createdAt: "2026-06-22T13:00:00Z",
        approvalRequestId: "appr-2",
      },
    ]),
    listCalendar: vi.fn().mockResolvedValue([
      {
        id: "post-1",
        title: "Published teaser",
        platform: "youtube",
        status: "published",
        scheduledAt: "2026-06-20T16:00:00Z",
        publishedAt: "2026-06-20T16:05:00Z",
      },
    ]),
    approveDraft: vi.fn().mockResolvedValue({
      id: "post-2",
      title: "Launch-week demo cut",
      platform: "tiktok",
      status: "scheduled",
      scheduledAt: "2026-06-24T14:00:00Z",
    }),
    skipDraft: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe("ShortFormBlitzSurface (#744)", () => {
  it("does not mount or read the seam when the feature flag is off", () => {
    const adapter = seam();
    const { container } = render(<ShortFormBlitzSurface workspaceId="w1" seam={adapter} enabled={false} />);

    expect(container).toBeEmptyDOMElement();
    expect(adapter.listDrafts).not.toHaveBeenCalled();
    expect(adapter.listCalendar).not.toHaveBeenCalled();
  });

  it("approves the active draft through the injected publishing seam and schedules it on the calendar", async () => {
    const adapter = seam();
    render(<ShortFormBlitzSurface workspaceId="w1" seam={adapter} />);

    expect(await screen.findByText("Launch-week demo cut")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(adapter.approveDraft).toHaveBeenCalledWith("w1", "draft-1"));
    expect(screen.queryByRole("article", { name: "Launch-week demo cut" })).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Founder proof cut" })).toBeInTheDocument();
    const calendar = screen.getByLabelText("Content calendar");
    expect(within(calendar).getAllByText("Launch-week demo cut")).toHaveLength(1);
    expect(within(calendar).getByText("scheduled")).toBeInTheDocument();
  });

  it("skips the active draft without adding a calendar post", async () => {
    const adapter = seam();
    render(<ShortFormBlitzSurface workspaceId="w1" seam={adapter} />);

    expect(await screen.findByText("Launch-week demo cut")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Skip" }));

    await waitFor(() => expect(adapter.skipDraft).toHaveBeenCalledWith("w1", "draft-1"));
    expect(screen.queryByRole("article", { name: "Launch-week demo cut" })).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Founder proof cut" })).toBeInTheDocument();
    expect(screen.getByLabelText("Content calendar")).toHaveTextContent("1 posts");
  });

  it("shows empty queue and empty calendar states", async () => {
    const adapter = seam({
      listDrafts: vi.fn().mockResolvedValue([]),
      listCalendar: vi.fn().mockResolvedValue([]),
    });
    render(<ShortFormBlitzSurface workspaceId="w1" seam={adapter} />);

    expect(await screen.findByText("No video drafts are waiting. Approved posts stay visible on the calendar.")).toBeInTheDocument();
    expect(screen.getByText("No scheduled or published posts yet.")).toBeInTheDocument();
  });
});
