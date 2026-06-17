import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SampleConsole } from "./SampleConsole.js";
import { api } from "../api/client.js";
import { SAMPLE } from "../brand.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const SAMPLE_PAYLOAD = {
  offered: true as const,
  console: {
    readOnly: true as const,
    workspaceLabel: "Sample workspace",
    deliverables: [
      {
        id: "sample-scout-seo-audit",
        agent: "Scout",
        department: "SEO",
        title: "SEO audit — example.com",
        preview: "Strong foundation, three high-impact fixes.",
        body: "# SEO audit — example.com\n\nThree fixes, ranked by impact.",
      },
    ],
  },
};

describe("SampleConsole (#300 — read-only front door)", () => {
  it("shows a real agent deliverable (AC: a deliverable without any Google scope)", async () => {
    vi.spyOn(api, "getSampleConsole").mockResolvedValue(SAMPLE_PAYLOAD);
    render(<SampleConsole />);
    expect(await screen.findByText("SEO audit — example.com")).toBeInTheDocument();
    expect(screen.getByText("Scout")).toBeInTheDocument();
    expect(screen.getByText(SAMPLE.badge)).toBeInTheDocument();
    // It is read-only: there's a way back to sign in, and no action controls.
    expect(screen.getAllByRole("link", { name: new RegExp(SAMPLE.back, "i") }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("degrades honestly when the sample isn't switched on (offered:false)", async () => {
    vi.spyOn(api, "getSampleConsole").mockResolvedValue({ offered: false, console: null });
    render(<SampleConsole />);
    expect(await screen.findByText(SAMPLE.empty)).toBeInTheDocument();
  });

  it("degrades honestly when the API is unreachable (never crashes the public page)", async () => {
    vi.spyOn(api, "getSampleConsole").mockRejectedValue(new Error("offline"));
    render(<SampleConsole />);
    expect(await screen.findByText(SAMPLE.empty)).toBeInTheDocument();
  });
});
