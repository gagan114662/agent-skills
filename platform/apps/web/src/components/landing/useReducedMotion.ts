/**
 * Motion hooks shared by every auto-playing landing surface (#165).
 *
 * `usePrefersReducedMotion` — true when the visitor has asked the OS to reduce motion. When it's on, the
 * staged reveals skip straight to their final state and nothing animates. Guards jsdom (no matchMedia)
 * safely so the component tests render in a non-animating, fully-revealed state.
 *
 * `useStagedReveal` — drives the "one entry at a time, then loop" animation. With reduced motion (or in
 * jsdom) it returns `count` immediately and never starts a timer, so the whole script is present at once
 * — good for crawlers, assistive tech, and deterministic tests.
 */
import { useEffect, useState } from "react";

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (): void => setReduced(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

export function useStagedReveal(count: number, stepMs: number, reduced: boolean): number {
  const [shown, setShown] = useState(reduced ? count : 1);
  useEffect(() => {
    if (reduced) {
      setShown(count);
      return;
    }
    setShown(1);
    let i = 1;
    const id = window.setInterval(() => {
      // Advance; once the full board has shown, loop back to the first entry.
      i = i >= count ? 1 : i + 1;
      setShown(i);
    }, stepMs);
    return () => window.clearInterval(id);
  }, [reduced, count, stepMs]);
  return shown;
}
