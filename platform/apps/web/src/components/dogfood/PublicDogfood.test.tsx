import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../../api/client.js";
import type { PublicDogfoodFeedDto } from "../../api/types.js";
import { PublicDogfood } from "./PublicDogfood.js";

const feed: PublicDogfoodFeedDto = {
  slug: "ipop",
  workspaceName: "ipop.ai",
  title: "ipop is marketing itself with ipop",
  lastUpdatedAt: "2026-06-25T09:06:00.000Z",
  receipts: [
    {
      id: "dogfood_1",
      agent: "Agent",
      workstream: "ipop SEO dogfood",
      phase: "artifact",
      summary: "Drafted meta description and saved artifact",
      artifactLabel: "seo_audit",
      approvalStatus: null,
      occurredAt: "2026-06-25T09:06:00.000Z",
    },
  ],
};

afterEach(() => vi.restoreAllMocks());

describe("PublicDogfood", () => {
  it("renders public dogfood receipts from the API", async () => {
    vi.spyOn(api, "getPublicDogfoodFeed").mockResolvedValue(feed);
    render(<PublicDogfood slug="ipop" />);

    expect(await screen.findByText("ipop is marketing itself with ipop")).toBeInTheDocument();
    expect(api.getPublicDogfoodFeed).toHaveBeenCalledWith("ipop");
    expect(screen.getByText("Drafted meta description and saved artifact")).toBeInTheDocument();
    expect(screen.getAllByText("Artifact").length).toBeGreaterThan(0);
    expect(screen.getByText("seo_audit")).toBeInTheDocument();
  });

  it("renders the honest empty state instead of fake rows", async () => {
    vi.spyOn(api, "getPublicDogfoodFeed").mockResolvedValue({ ...feed, lastUpdatedAt: null, receipts: [] });
    render(<PublicDogfood slug="ipop" />);

    expect(await screen.findByText("No public dogfood receipts yet")).toBeInTheDocument();
    expect(screen.queryByText("Drafted meta description and saved artifact")).not.toBeInTheDocument();
  });

  it("renders not found only for an unpublished feed", async () => {
    vi.spyOn(api, "getPublicDogfoodFeed").mockRejectedValue(new ApiError("not found", 404));
    render(<PublicDogfood slug="missing" />);

    await waitFor(() => expect(screen.getByText("No public dogfood feed")).toBeInTheDocument());
  });
});
