import { afterEach, describe, expect, it, vi } from "vitest";
import { popConfetti, prefersReducedMotion } from "./confetti.js";

/**
 * #145 success micro-burst. Approving an action, sending a message, and completing checkout each fire
 * a three-dot confetti burst at the interaction point. It is the brand's "small win" tell — used
 * sparingly — and, like every motion in the system, it is a delight that reduced-motion turns off.
 */
describe("popConfetti", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("mounts a three-dot burst positioned at the interaction point", () => {
    const el = popConfetti(120, 80);
    expect(el).not.toBeNull();
    expect(document.querySelector(".confetti-burst")).not.toBeNull();
    expect(document.querySelectorAll(".confetti-burst__dot")).toHaveLength(3);
    expect(el!.style.left).toBe("120px");
    expect(el!.style.top).toBe("80px");
  });

  it("auto-removes the burst after its animation window (no DOM litter)", () => {
    vi.useFakeTimers();
    popConfetti(10, 10);
    expect(document.querySelector(".confetti-burst")).not.toBeNull();
    vi.advanceTimersByTime(1500);
    expect(document.querySelector(".confetti-burst")).toBeNull();
  });

  it("is a no-op under prefers-reduced-motion (the pop is never a tax)", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false;
      },
    }));
    expect(prefersReducedMotion()).toBe(true);
    const el = popConfetti(5, 5);
    expect(el).toBeNull();
    expect(document.querySelector(".confetti-burst")).toBeNull();
  });

  it("treats no matchMedia support as motion-allowed (graceful default)", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(prefersReducedMotion()).toBe(false);
    expect(popConfetti(1, 1)).not.toBeNull();
  });
});
