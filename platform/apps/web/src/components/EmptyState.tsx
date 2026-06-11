/**
 * The empty-state block (#145, criterion #8): every empty pane gets a small static Pop Mark
 * illustration above a line of VOICE copy — zero bare "no data" strings anywhere. Callers pass the
 * voice line as children; `color` optionally tints the mark to a surface's department hue.
 */
import type { ReactNode } from "react";
import { PopMark } from "./PopMark.js";

export function EmptyState({
  children,
  color,
  className,
}: {
  children: ReactNode;
  color?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={`emptystate${className ? ` ${className}` : ""}`}>
      <PopMark color={color} className="emptystate__mark" />
      <p className="emptystate__copy">{children}</p>
    </div>
  );
}
