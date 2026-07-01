import type { CSSProperties } from "react";

export interface IpopExperienceTokens {
  readonly color: {
    readonly canvas: string;
    readonly surface: string;
    readonly raised: string;
    readonly border: string;
    readonly text: string;
    readonly textDim: string;
    readonly accent: string;
    readonly onAccent: string;
  };
  readonly typography: {
    readonly serif: string;
    readonly sans: string;
  };
  readonly radius: string;
  readonly gap: string;
  readonly motionEase: string;
}

export const ipopExperienceTokens: IpopExperienceTokens = {
  color: {
    canvas: "#0f0f12",
    surface: "#17171c",
    raised: "#1e1e25",
    border: "rgba(255, 255, 255, 0.08)",
    text: "#f4f3f1",
    textDim: "#9a9aa2",
    accent: "#ff5470",
    onAccent: "#2a0a12",
  },
  typography: {
    serif: '"Instrument Serif", Georgia, "Times New Roman", serif',
    sans: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  },
  radius: "16px",
  gap: "28px",
  motionEase: "cubic-bezier(0.22, 0.61, 0.36, 1)",
};

export const ipopExperienceLightTokens: IpopExperienceTokens = {
  ...ipopExperienceTokens,
  color: {
    canvas: "#fff7b3",
    surface: "rgba(255, 255, 255, 0.72)",
    raised: "#fffdf0",
    border: "rgba(17, 17, 17, 0.12)",
    text: "#17120f",
    textDim: "rgba(23, 18, 15, 0.66)",
    accent: "#ff5470",
    onAccent: "#2a0a12",
  },
};

type ExperienceSurface = "onboarding" | "everyday" | "everydayLight";

const PREFIX_BY_SURFACE: Record<ExperienceSurface, string> = {
  onboarding: "o",
  everyday: "ed",
  everydayLight: "ed",
};

export function experienceTokenStyle(surface: ExperienceSurface): CSSProperties {
  const prefix = PREFIX_BY_SURFACE[surface];
  const tokens = surface === "everydayLight" ? ipopExperienceLightTokens : ipopExperienceTokens;
  return {
    [`--${prefix}-canvas`]: tokens.color.canvas,
    [`--${prefix}-surface`]: tokens.color.surface,
    [`--${prefix}-raised`]: tokens.color.raised,
    [`--${prefix}-border`]: tokens.color.border,
    [`--${prefix}-text`]: tokens.color.text,
    [`--${prefix}-text-dim`]: tokens.color.textDim,
    [`--${prefix}-pop`]: tokens.color.accent,
    ...(surface === "onboarding"
      ? { "--o-pop-ink": tokens.color.onAccent }
      : { "--ed-on-pop": tokens.color.onAccent }),
    [`--${prefix}-serif`]: tokens.typography.serif,
    [`--${prefix}-sans`]: tokens.typography.sans,
    [`--${prefix}-radius`]: tokens.radius,
    [`--${prefix}-gap`]: tokens.gap,
    [`--${prefix}-ease`]: tokens.motionEase,
  } as CSSProperties;
}
