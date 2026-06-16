/**
 * BrandKitPanel (#271) — the Settings panel where the owner sets the brand kit once (name, colours,
 * voice, logo). Mark enforces it server-side and the fleet draws from it; setting it connects the brand
 * proof tile. The panel reads all copy from BRAND_KIT and writes through `api.setBrandKit`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import type { BrandKitState } from "../api/types.js";
import { BrandKitPanel } from "./BrandKitPanel.js";
import { api } from "../api/client.js";
import { BRAND_KIT } from "../brand.js";

afterEach(() => vi.restoreAllMocks());

const UNSET: BrandKitState = { connected: false, brandKit: null };
const SET: BrandKitState = {
  connected: true,
  assetCount: 2,
  brandKit: { id: "kit-1", name: "Acme", palette: ["#1a73e8", "#34a853"], voice: "Confident.", logoAssetId: null },
};

async function renderPanel() {
  await act(async () => {
    render(<BrandKitPanel />);
  });
}

describe("BrandKitPanel (#271)", () => {
  it("shows the 'not set' badge and an empty form when no kit exists", async () => {
    vi.spyOn(api, "getBrandKit").mockResolvedValue(UNSET);
    await renderPanel();
    expect(await screen.findByText(BRAND_KIT.unsetBadge)).toBeInTheDocument();
    expect(screen.getByText(BRAND_KIT.title)).toBeInTheDocument();
  });

  it("hydrates from an existing kit and shows the connected badge + asset count", async () => {
    vi.spyOn(api, "getBrandKit").mockResolvedValue(SET);
    await renderPanel();
    expect(await screen.findByText(new RegExp(BRAND_KIT.connectedBadge))).toBeInTheDocument();
    expect(screen.getByText(/2 on-brand assets/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("Acme")).toBeInTheDocument();
    expect(screen.getByDisplayValue("#1a73e8")).toBeInTheDocument();
  });

  it("saves the brand kit the owner enters (name + palette + voice) and confirms", async () => {
    vi.spyOn(api, "getBrandKit").mockResolvedValue(UNSET);
    const setSpy = vi.spyOn(api, "setBrandKit").mockResolvedValue(SET);
    await renderPanel();

    fireEvent.change(screen.getByPlaceholderText(BRAND_KIT.namePlaceholder), { target: { value: "Acme" } });
    fireEvent.change(screen.getByLabelText(`${BRAND_KIT.paletteLabel} 1`), { target: { value: "#1a73e8" } });
    fireEvent.change(screen.getByPlaceholderText(BRAND_KIT.voicePlaceholder), { target: { value: "Confident." } });

    await act(async () => {
      fireEvent.click(screen.getByText(BRAND_KIT.save));
    });

    expect(setSpy).toHaveBeenCalledWith({
      name: "Acme",
      palette: ["#1a73e8"],
      voice: "Confident.",
      logoAssetId: null,
    });
    expect(await screen.findByText(BRAND_KIT.saved)).toBeInTheDocument();
  });

  it("surfaces an error if the save fails (e.g. an invalid hex rejected server-side)", async () => {
    vi.spyOn(api, "getBrandKit").mockResolvedValue(UNSET);
    vi.spyOn(api, "setBrandKit").mockRejectedValue(new Error("400"));
    await renderPanel();
    fireEvent.change(screen.getByPlaceholderText(BRAND_KIT.namePlaceholder), { target: { value: "Acme" } });
    await act(async () => {
      fireEvent.click(screen.getByText(BRAND_KIT.save));
    });
    expect(await screen.findByText(BRAND_KIT.error)).toBeInTheDocument();
  });
});
