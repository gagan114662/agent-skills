/**
 * The hero's staged chat vignette (#149): a tiny, auto-playing, looping peek at the fleet doing work.
 * Scripted lines (from `LANDING.vignette`) reveal one at a time — typed-out feel — department-coloured
 * per speaker, finishing on a completed task that pops three-dot confetti, then loops.
 *
 * Pure CSS/JS, no video. Every scripted line is always in the DOM (so it's there for crawlers and
 * assistive tech); the reveal is a visual `is-shown` class driven by a single interval. When the visitor
 * prefers reduced motion, the whole script shows at once and nothing animates — see the
 * `prefers-reduced-motion` block in styles.css and {@link usePrefersReducedMotion}.
 */
import { useEffect, useState } from "react";
import { DEPARTMENT_SPECTRUM, FLEET, LANDING } from "../../brand.js";

/** True when the visitor asked the OS to reduce motion. Guards jsdom (no matchMedia) safely. */
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

const STEP_MS = 1700;
const NAME_BY_HANDLE = new Map(FLEET.map((a) => [a.handle, a.name]));

export function HeroVignette(): React.JSX.Element {
  const lines = LANDING.vignette;
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState(1);

  useEffect(() => {
    if (reduced) {
      setShown(lines.length);
      return;
    }
    setShown(1);
    let i = 1;
    const id = window.setInterval(() => {
      // Advance, then loop back to the first line after the last (with a brief beat on the full board).
      i = i >= lines.length ? 1 : i + 1;
      setShown(i);
    }, STEP_MS);
    return () => window.clearInterval(id);
  }, [reduced, lines.length]);

  return (
    <div className="vignette" role="region" aria-label="A peek at the fleet at work">
      <div className="vignette__bar" aria-hidden="true">
        <span className="vignette__dot" />
        <span className="vignette__channel">#seo</span>
      </div>
      <ol className="vignette__lines">
        {lines.map((line, i) => {
          const isShown = i < shown;
          const isYou = line.from === "you";
          const color = line.dept ? DEPARTMENT_SPECTRUM[line.dept] : undefined;
          const speaker = isYou ? "you" : (NAME_BY_HANDLE.get(line.from) ?? line.from);
          return (
            <li
              key={i}
              className={`vignette__line${isYou ? " vignette__line--you" : ""}${
                isShown ? " is-shown" : ""
              }`}
            >
              <span className="vignette__who" style={color ? { color } : undefined}>
                <span
                  className="vignette__avatar"
                  style={{ background: color ?? "var(--ink-dim)" }}
                  aria-hidden="true"
                />
                {speaker}
              </span>
              <span
                className="vignette__bubble"
                style={color ? { borderColor: color } : undefined}
              >
                {line.text}
              </span>
              {line.done && isShown && (
                <span className="vignette__confetti confetti" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
