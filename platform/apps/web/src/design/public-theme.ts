import { useEffect, type CSSProperties } from "react";

export const IPOP_PUBLIC_THEME = {
  bg: "#f6f1e7",
  heroFill: "#fff879",
  surface: "#fffdf0",
  raised: "#efe7d8",
  text: "#171310",
  textDim: "#6b6258",
  accent: "#ff4524",
  border: "#e0d4bf",
  radius: "18px",
  shadow: "0 18px 48px rgba(43, 33, 22, 0.14)",
} as const;

type PublicThemePrefix = "o" | "ed";

function prefixedTokens(prefix: PublicThemePrefix): CSSProperties {
  return {
    [`--${prefix}-canvas`]: IPOP_PUBLIC_THEME.bg,
    [`--${prefix}-surface`]: "rgba(255, 255, 255, 0.72)",
    [`--${prefix}-raised`]: IPOP_PUBLIC_THEME.surface,
    [`--${prefix}-border`]: "rgba(23, 19, 16, 0.14)",
    [`--${prefix}-text`]: IPOP_PUBLIC_THEME.text,
    [`--${prefix}-text-dim`]: "rgba(23, 19, 16, 0.66)",
    [`--${prefix}-pop`]: IPOP_PUBLIC_THEME.accent,
    [`--${prefix}-serif`]: '"Instrument Serif", Georgia, "Times New Roman", serif',
    [`--${prefix}-sans`]: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    [`--${prefix}-radius`]: IPOP_PUBLIC_THEME.radius,
    [`--${prefix}-gap`]: "28px",
    [`--${prefix}-ease`]: "cubic-bezier(0.22, 0.61, 0.36, 1)",
    ...(prefix === "o" ? { "--o-pop-ink": "#2a0a12" } : { "--ed-on-pop": "#2a0a12" }),
  } as CSSProperties;
}

export function publicThemeStyle(prefixes: readonly PublicThemePrefix[] = []): CSSProperties {
  return {
    backgroundColor: IPOP_PUBLIC_THEME.bg,
    color: IPOP_PUBLIC_THEME.text,
    "--public-bg": IPOP_PUBLIC_THEME.bg,
    "--public-surface": IPOP_PUBLIC_THEME.surface,
    "--public-text": IPOP_PUBLIC_THEME.text,
    "--public-accent": IPOP_PUBLIC_THEME.accent,
    "--public-border": IPOP_PUBLIC_THEME.border,
    "--public-radius": IPOP_PUBLIC_THEME.radius,
    "--public-shadow": IPOP_PUBLIC_THEME.shadow,
    "--paper": IPOP_PUBLIC_THEME.bg,
    "--ink": IPOP_PUBLIC_THEME.text,
    "--bg": IPOP_PUBLIC_THEME.bg,
    "--bg-1": IPOP_PUBLIC_THEME.raised,
    "--bg-2": "#e9e0d0",
    "--bg-3": "#e2d7c4",
    "--line": IPOP_PUBLIC_THEME.border,
    "--border": IPOP_PUBLIC_THEME.border,
    "--text": IPOP_PUBLIC_THEME.text,
    "--text-dim": IPOP_PUBLIC_THEME.textDim,
    "--text-faint": "#9b9286",
    "--accent": IPOP_PUBLIC_THEME.accent,
    "--accent-press": "#e23a1c",
    "--accent-dim": "#ffd9cf",
    "--link": "#c73618",
    "--link-hover": "#a82e15",
    "--radius": "12px",
    "--radius-sm": "8px",
    "--radius-md": "12px",
    "--radius-lg": IPOP_PUBLIC_THEME.radius,
    "--radius-pill": "999px",
    "--shadow-sm": "0 2px 6px rgba(43, 33, 22, 0.07), 0 1px 2px rgba(43, 33, 22, 0.05)",
    "--shadow-md": "0 8px 24px rgba(43, 33, 22, 0.1), 0 2px 6px rgba(43, 33, 22, 0.06)",
    "--shadow-lg": IPOP_PUBLIC_THEME.shadow,
    ...Object.assign({}, ...prefixes.map(prefixedTokens)),
  } as CSSProperties;
}

export function usePublicLightTheme(enabled = true): void {
  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    const root = document.documentElement;
    const body = document.body;
    const previousRootSurface = root.getAttribute("data-public-surface");
    const previousBodySurface = body.getAttribute("data-public-surface");
    const previousBodyBackground = body.style.backgroundColor;
    const previousBodyColor = body.style.color;

    root.setAttribute("data-public-surface", "light");
    body.setAttribute("data-public-surface", "light");
    body.style.backgroundColor = IPOP_PUBLIC_THEME.bg;
    body.style.color = IPOP_PUBLIC_THEME.text;

    return () => {
      if (previousRootSurface === null) root.removeAttribute("data-public-surface");
      else root.setAttribute("data-public-surface", previousRootSurface);
      if (previousBodySurface === null) body.removeAttribute("data-public-surface");
      else body.setAttribute("data-public-surface", previousBodySurface);
      body.style.backgroundColor = previousBodyBackground;
      body.style.color = previousBodyColor;
    };
  }, [enabled]);
}
