/**
 * The Pop Mark (#138 brand book, polished in #145): a vermilion dot leaping out of an ink ring — the
 * standalone brand glyph used for the splash, the login card, empty states, and loaders.
 *
 * Idle, the dot does a happy wiggle (the "alive" tell). With `burst`, it plays the full pop cycle on
 * load — dot → swell → 6-ray burst at 60° → overshoot → settle — the dramatic entrance from criterion
 * #1. `color` tints the dot (department spectrum) via the `--pop-color` custom property; all of the
 * motion lives in `styles.css` and is gated behind `prefers-reduced-motion`.
 */
const RAY_COUNT = 6; // six rays, one every 60° — the burst from the brand book.

export function PopMark({
  burst = false,
  color,
  size,
  className,
}: {
  /** Play the full pop cycle (swell + 6-ray burst) on mount. Use for entrances (login, splash). */
  burst?: boolean;
  /** Tint the dot (e.g. a department spectrum hue). Defaults to Pop Vermilion via CSS. */
  color?: string;
  /** Override the ring diameter in px (defaults to the CSS size). */
  size?: number;
  className?: string;
}): React.JSX.Element {
  const style: React.CSSProperties = {};
  if (color) (style as Record<string, string>)["--pop-color"] = color;
  if (size) (style as Record<string, string>)["--pop-size"] = `${size}px`;

  return (
    <span
      className={`popmark${burst ? " popmark--burst" : ""}${className ? ` ${className}` : ""}`}
      style={style}
      aria-hidden="true"
    >
      {burst && (
        <span className="popmark__rays">
          {Array.from({ length: RAY_COUNT }, (_, i) => (
            <span key={i} className="popmark__ray" style={{ transform: `rotate(${i * 60}deg)` }} />
          ))}
        </span>
      )}
      <span className="popmark__dot" />
    </span>
  );
}
