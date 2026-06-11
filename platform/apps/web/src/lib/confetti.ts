/**
 * The three-dot confetti micro-burst (#145) — the brand's "small win" tell. Approving an action,
 * sending a message, and completing checkout each fire one burst at the interaction point. It is used
 * sparingly (these are the only confetti moments) and, like every motion in the system, it is gated:
 * under `prefers-reduced-motion: reduce` it is a no-op, never a tax.
 *
 * Imperative on purpose: a success burst is a fleeting, point-anchored flourish that outlives the React
 * event that triggered it, so it mounts a self-removing node on `document.body` rather than living in a
 * component's render tree. The dots use the brand palette + bezier from `styles.css` (`.confetti-burst`).
 */

/** True when the user has asked the OS to reduce motion. Safe when `matchMedia` is absent (jsdom/SSR). */
export function prefersReducedMotion(): boolean {
  const mm = typeof globalThis !== "undefined" ? globalThis.matchMedia : undefined;
  if (typeof mm !== "function") return false;
  try {
    return mm("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** How long the burst lives before it removes itself (must outlast the CSS animation). */
const BURST_MS = 1100;

/**
 * Fire a three-dot confetti burst centred on viewport point (`x`, `y`). Returns the mounted element,
 * or `null` when motion is reduced or there is no DOM. The node removes itself after the animation.
 */
export function popConfetti(x: number, y: number, host: HTMLElement = document.body): HTMLElement | null {
  if (prefersReducedMotion()) return null;
  if (typeof document === "undefined") return null;

  const burst = document.createElement("span");
  burst.className = "confetti-burst";
  burst.setAttribute("aria-hidden", "true");
  burst.style.left = `${Math.round(x)}px`;
  burst.style.top = `${Math.round(y)}px`;
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement("span");
    dot.className = "confetti-burst__dot";
    burst.appendChild(dot);
  }
  host.appendChild(burst);
  setTimeout(() => burst.remove(), BURST_MS);
  return burst;
}

/**
 * Convenience wrapper: fire a burst at the centre of the element that triggered a React event (the
 * common case — a button click). Falls back to the event's client coordinates when no target rect.
 */
export function popConfettiFromEvent(e: { currentTarget: EventTarget | null }): HTMLElement | null {
  const target = e.currentTarget;
  if (target instanceof HTMLElement) {
    const r = target.getBoundingClientRect();
    return popConfetti(r.left + r.width / 2, r.top + r.height / 2);
  }
  return null;
}
