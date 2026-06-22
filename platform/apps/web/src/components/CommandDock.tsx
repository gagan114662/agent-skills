/**
 * #729 floating command dock — a small, premium, always-present launcher pinned to the bottom-right of the
 * workspace chrome. It collects the cross-surface quick actions (jump to the approvals inbox, open workspace
 * settings) behind one consistent set of stroked icons, plus the user-facing light ⇄ dark theme toggle.
 *
 * VISUAL ONLY (#729): every button here is a shortcut to behaviour that already exists — the approvals and
 * settings buttons call handlers the host (ConsoleView) already wires to its existing overlays; the theme
 * button only swaps the palette via {@link toggleThemeMode}. No new product behaviour, no new state on the
 * wire. The dock is purely additive, so when its handlers are omitted (e.g. a standalone render) it quietly
 * shows just the theme toggle.
 */
import { useEffect, useState } from "react";
import {
  applyStoredThemeMode,
  currentThemeMode,
  toggleThemeMode,
  type ThemeMode,
} from "../theme-toggle.js";

export interface CommandDockProps {
  /** Open the first-class approvals inbox. Omit to hide the approvals button. */
  onOpenApprovals?: () => void;
  /** Open workspace settings. Omit to hide the settings button. */
  onOpenSettings?: () => void;
  /** Count of approvals waiting on the user — drives a small badge on the approvals button. */
  pendingCount?: number;
}

export function CommandDock({
  onOpenApprovals,
  onOpenSettings,
  pendingCount = 0,
}: CommandDockProps = {}): React.JSX.Element {
  // Reflect whatever palette is live (gate default or a saved override). Restore the saved choice on mount.
  const [mode, setMode] = useState<ThemeMode>(() => currentThemeMode());
  useEffect(() => {
    applyStoredThemeMode();
    setMode(currentThemeMode());
  }, []);

  function onToggleTheme(): void {
    setMode(toggleThemeMode());
  }

  const nextTheme = mode === "dark" ? "light" : "dark";

  return (
    <div className="cmddock" role="toolbar" aria-label="Quick actions">
      {onOpenApprovals && (
        <button
          type="button"
          className="cmddock__btn"
          onClick={onOpenApprovals}
          aria-label="Open approvals"
          title="Approvals"
        >
          <ApprovalsIcon />
          {pendingCount > 0 && (
            <span className="cmddock__badge" aria-hidden="true">
              {pendingCount > 9 ? "9+" : pendingCount}
            </span>
          )}
        </button>
      )}
      {onOpenSettings && (
        <button
          type="button"
          className="cmddock__btn"
          onClick={onOpenSettings}
          aria-label="Open workspace settings"
          title="Settings"
        >
          <SettingsIcon />
        </button>
      )}
      <span className="cmddock__divider" aria-hidden="true" />
      <button
        type="button"
        className="cmddock__btn cmddock__btn--theme"
        onClick={onToggleTheme}
        aria-label={`Switch to ${nextTheme} theme`}
        title={`Switch to ${nextTheme} theme`}
      >
        {mode === "dark" ? <SunIcon /> : <MoonIcon />}
      </button>
    </div>
  );
}

/* ---- iconography (#729): one consistent stroked set — 18px, 1.75 stroke, round caps, currentColor. ---- */

function svgProps(): React.SVGProps<SVGSVGElement> {
  return {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    focusable: false,
  };
}

function ApprovalsIcon(): React.JSX.Element {
  // An inbox with an approving check — the governance surface.
  return (
    <svg {...svgProps()}>
      <path d="M4 13h4l1.5 2.5h5L16 13h4" />
      <path d="M4 13l2.5-7.5h11L20 13v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4Z" />
      <path d="m9.5 9.5 1.8 1.8 3.2-3.6" />
    </svg>
  );
}

function SettingsIcon(): React.JSX.Element {
  return (
    <svg {...svgProps()}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 6.7 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 4 13.9H4a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 5.2 7.2l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H10A1.6 1.6 0 0 0 11 3.1V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.4 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
    </svg>
  );
}

function SunIcon(): React.JSX.Element {
  return (
    <svg {...svgProps()}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonIcon(): React.JSX.Element {
  return (
    <svg {...svgProps()}>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </svg>
  );
}
