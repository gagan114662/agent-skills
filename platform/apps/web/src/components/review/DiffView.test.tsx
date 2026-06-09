import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { DiffView } from "./DiffView.js";

/** The dependency-free diff renderer (#51) classifies each line so additions/deletions are colored. */
describe("DiffView", () => {
  it("renders an empty state with no patch", () => {
    const { getByText } = render(<DiffView patch="" files={[]} />);
    expect(getByText(/No changes on this branch yet/i)).toBeInTheDocument();
  });

  it("classifies hunk / addition / deletion / context lines", () => {
    const patch = [
      "diff --git a/x.ts b/x.ts",
      "@@ -1,2 +1,2 @@",
      " context line",
      "-removed line",
      "+added line",
    ].join("\n");
    const { container } = render(
      <DiffView patch={patch} files={[{ path: "x.ts", additions: 1, deletions: 1, binary: false }]} />,
    );
    expect(container.querySelector('[data-kind="add"]')?.textContent).toContain("added line");
    expect(container.querySelector('[data-kind="del"]')?.textContent).toContain("removed line");
    expect(container.querySelector('[data-kind="hunk"]')?.textContent).toContain("@@");
    expect(container.querySelector('[data-kind="meta"]')?.textContent).toContain("diff --git");
  });

  it("shows per-file stats including a binary marker", () => {
    const { getByText } = render(
      <DiffView
        patch={"diff --git a/logo.png b/logo.png\nBinary files differ\n"}
        files={[{ path: "logo.png", additions: null, deletions: null, binary: true }]}
      />,
    );
    expect(getByText("logo.png")).toBeInTheDocument();
    expect(getByText("binary")).toBeInTheDocument();
  });
});
