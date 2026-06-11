/**
 * The three-dot pop loader (#145, criterion #9): the only loading affordance in the app — no
 * browser-default spinners anywhere. Three dots scale in sequence with the brand bezier (the motion
 * lives in `styles.css`, gated behind `prefers-reduced-motion`). A visually-hidden status label keeps
 * the loader announced to assistive tech, and lets existing `getByText(/loading/i)` assertions pass.
 */
export function PopLoader({ label = "Loading…" }: { label?: string }): React.JSX.Element {
  return (
    <span className="poploader" role="status" aria-live="polite">
      <span className="poploader__dots" aria-hidden="true">
        <span className="poploader__dot" />
        <span className="poploader__dot" />
        <span className="poploader__dot" />
      </span>
      <span className="poploader__label">{label}</span>
    </span>
  );
}
