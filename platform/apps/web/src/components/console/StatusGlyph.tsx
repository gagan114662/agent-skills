/**
 * The one status grammar, rendered. Used identically in the standup rows and on the board so a glyph
 * means the same thing everywhere:
 *   running → braille spinner (the single looping tell in the console; reduced-motion freezes it)
 *   waiting → a filled vermilion dot (your call)
 *   shipped → a filled green dot
 *   idle    → a hollow ring
 * All motion is gated behind prefers-reduced-motion; under it the spinner shows a single static frame.
 */
import { useEffect, useState } from "react";
import { usePrefersReducedMotion } from "../landing/useReducedMotion.js";
import { brailleFrame } from "../../brand.js";
import type { ItemKind } from "./model.js";

/** The braille spinner — cycles ⠋⠙⠹… at 80ms, freezes to one frame under reduced motion. */
export function BrailleSpinner({ className }: { className?: string }): React.JSX.Element {
  const reduced = usePrefersReducedMotion();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (reduced) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 80);
    return () => window.clearInterval(id);
  }, [reduced]);
  return (
    <span className={`braille${className ? ` ${className}` : ""}`} aria-hidden="true">
      {brailleFrame(tick)}
    </span>
  );
}

/** The glyph for an item's status, in the shared grammar. `idle` covers the empty/quiet row. */
export function StatusGlyph({ kind }: { kind: ItemKind | "idle" }): React.JSX.Element {
  if (kind === "running") return <BrailleSpinner className="braille--glyph" />;
  if (kind === "waiting") return <span className="glyph-dot glyph-dot--wait" aria-hidden="true" />;
  if (kind === "shipped") return <span className="glyph-dot glyph-dot--done" aria-hidden="true" />;
  return <span className="glyph-dot glyph-dot--idle" aria-hidden="true" />;
}
