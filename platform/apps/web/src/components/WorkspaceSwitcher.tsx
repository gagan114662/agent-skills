/**
 * Workspace / product switcher (#510) — the top-left title is a real menu, not dead chrome.
 *
 * Before this, the "workspace · 019eb…" line was a plain <div>: it looked like a switcher but absorbed no
 * clicks, so they fell through to the channel behind it. This turns the title into a button that opens a
 * popover listing the current workspace (named by its #502 marketing target product when one is set, else the
 * short workspace id), plus two shortcuts: "New product" — point the fleet at another product — and
 * "Settings". Both land in the settings overlay, which leads with the "What are we marketing?" panel where a
 * product is defined (there is one workspace per account today; #502's marketing target IS the product, so
 * pointing the fleet at a new product happens there). The list is structured to grow once an account can hold
 * more than one workspace.
 *
 * SAFETY (#200): the product name is owner-typed DATA — rendered as React text only, never markup, and never
 * read as an instruction. Opening this menu navigates and opens settings only; it spends nothing and gates
 * nothing — every irreversible/money action still flows through the #13 approval queue.
 */
import { useEffect, useRef, useState } from "react";
import { useAppState } from "../store/StoreContext.js";
import { api } from "../api/client.js";
import { CONSOLE } from "../brand.js";

const COPY = CONSOLE.coordination.switcher;

export interface WorkspaceSwitcherProps {
  /** Open the workspace settings overlay (which leads with the "What are we marketing?" product panel). */
  onOpenSettings?: () => void;
}

export function WorkspaceSwitcher({ onOpenSettings }: WorkspaceSwitcherProps = {}): React.JSX.Element | null {
  const { identity } = useAppState();
  const [open, setOpen] = useState(false);
  const [productName, setProductName] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Best-effort: label the current entry with the product the fleet markets (#502) when one is set. A failure
  // or an unset target just leaves the workspace-id fallback — the switcher never depends on this resolving.
  useEffect(() => {
    if (!identity) return;
    let live = true;
    void api
      .getMarketingTarget()
      .then((s) => {
        if (!live) return;
        const name = s.configured ? s.target.name?.trim() : "";
        setProductName(name && name.length > 0 ? name : null);
      })
      .catch(() => {
        /* honest fallback to the workspace id below */
      });
    return () => {
      live = false;
    };
  }, [identity]);

  // Dismiss on outside click or Escape so the popover behaves like a native menu.
  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent): void {
      if (!rootRef.current?.contains(e.target as Node | null)) setOpen(false);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!identity) return null;

  const shortId = identity.workspaceId.slice(0, 8);
  const label = productName ?? `${COPY.currentPrefix} · ${shortId}`;

  function openSettings(): void {
    setOpen(false);
    onOpenSettings?.();
  }

  return (
    <div className="wsswitcher" ref={rootRef}>
      <button
        type="button"
        className="wsswitcher__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={COPY.triggerLabel}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="wsswitcher__label">{label}</span>
        <span className="wsswitcher__caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="wsswitcher__menu" role="menu" aria-label={COPY.heading}>
          <p className="wsswitcher__heading">{COPY.heading}</p>
          <button type="button" className="wsswitcher__item wsswitcher__item--current" role="menuitem" aria-current="true" onClick={() => setOpen(false)}>
            <span className="wsswitcher__itemname">{label}</span>
            <span className="wsswitcher__badge">{COPY.current}</span>
          </button>
          <div className="wsswitcher__divider" role="separator" />
          <button type="button" className="wsswitcher__item" role="menuitem" onClick={openSettings}>
            {COPY.newProduct}
          </button>
          <button type="button" className="wsswitcher__item" role="menuitem" onClick={openSettings}>
            {COPY.settings}
          </button>
        </div>
      )}
    </div>
  );
}
