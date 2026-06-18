import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { VersionMismatchBanner } from "./VersionMismatchBanner.js";
import { decideVersionParity } from "./version-check.js";

/**
 * #366 — the deploy-freshness banner. It is fail-quiet: it renders ONLY for a confirmed web↔API build
 * mismatch (two valid, divergent SHAs). Loading (null), a match, and an unknown verdict (an unstamped local
 * build or an unreachable/old API) all render nothing — so it never false-alarms.
 */
const A = "0123456789abcdef0123456789abcdef01234567";
const B = "fedcba9876543210fedcba9876543210fedcba98";

describe("VersionMismatchBanner (#366)", () => {
  it("renders nothing while the verdict is still loading (null)", () => {
    const { container } = render(<VersionMismatchBanner verdict={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the web and API are on the same commit (match)", () => {
    const verdict = decideVersionParity({ webSha: A, apiSha: A });
    const { container } = render(<VersionMismatchBanner verdict={verdict} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when parity is unknown (unstamped build / unreachable API) — no false alarm", () => {
    const verdict = decideVersionParity({ webSha: "", apiSha: A });
    const { container } = render(<VersionMismatchBanner verdict={verdict} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows an alert with both short SHAs on a confirmed mismatch", () => {
    const verdict = decideVersionParity({ webSha: A, apiSha: B });
    render(<VersionMismatchBanner verdict={verdict} />);
    const alert = screen.getByRole("alert", { name: /build version mismatch/i });
    expect(alert).toBeInTheDocument();
    expect(alert.textContent).toContain(A.slice(0, 7));
    expect(alert.textContent).toContain(B.slice(0, 7));
  });

  it("offers a reload control that triggers the injected reload handler", () => {
    const onReload = vi.fn();
    render(<VersionMismatchBanner verdict={decideVersionParity({ webSha: A, apiSha: B })} onReload={onReload} />);
    fireEvent.click(screen.getByRole("button", { name: /reload page/i }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
