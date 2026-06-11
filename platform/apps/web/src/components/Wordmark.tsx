/**
 * The ipop wordmark with a popped i-dot (#138 pop identity). The dot of the first "i" is the brand's
 * heartbeat — it hops with a stretch-up / squash-on-landing (the `pop-dot` keyframe in styles.css).
 *
 * Reads the name from BRAND so a rebrand flows through and the product chrome carries no hardcoded
 * brand string (brand.test.ts enforces this for the chrome components that render it). The plain name
 * is exposed via aria-label so assistive tech hears "ipop", not the split-up glyphs.
 * See docs/brand/ipop-brand-identity.html.
 */
import { BRAND } from "../brand.js";

export function Wordmark({ className }: { className?: string }): React.JSX.Element {
  const chars = [...BRAND.name];
  let poppedFirstI = false;
  return (
    <span className={`wordmark${className ? ` ${className}` : ""}`} aria-label={BRAND.name}>
      {chars.map((ch, i) => {
        // Pop the dot on the first lowercase "i": render the stem with an animated dot overlay.
        if (!poppedFirstI && (ch === "i" || ch === "ı")) {
          poppedFirstI = true;
          return (
            <span key={i} className="wordmark__i" aria-hidden="true">
              {"ı"}
              <span className="wordmark__dot" />
            </span>
          );
        }
        return (
          <span key={i} aria-hidden="true">
            {ch}
          </span>
        );
      })}
    </span>
  );
}
