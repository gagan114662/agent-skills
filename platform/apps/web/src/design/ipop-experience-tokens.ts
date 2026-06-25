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

type ExperienceSurface = "onboarding" | "everyday";

const PREFIX_BY_SURFACE: Record<ExperienceSurface, string> = {
  onboarding: "o",
  everyday: "ed",
};

export function experienceTokenStyle(surface: ExperienceSurface): CSSProperties {
  const prefix = PREFIX_BY_SURFACE[surface];
  return {
    [`--${prefix}-canvas`]: ipopExperienceTokens.color.canvas,
    [`--${prefix}-surface`]: ipopExperienceTokens.color.surface,
    [`--${prefix}-raised`]: ipopExperienceTokens.color.raised,
    [`--${prefix}-border`]: ipopExperienceTokens.color.border,
    [`--${prefix}-text`]: ipopExperienceTokens.color.text,
    [`--${prefix}-text-dim`]: ipopExperienceTokens.color.textDim,
    [`--${prefix}-pop`]: ipopExperienceTokens.color.accent,
    ...(surface === "onboarding"
      ? { "--o-pop-ink": ipopExperienceTokens.color.onAccent }
      : { "--ed-on-pop": ipopExperienceTokens.color.onAccent }),
    [`--${prefix}-serif`]: ipopExperienceTokens.typography.serif,
    [`--${prefix}-sans`]: ipopExperienceTokens.typography.sans,
    [`--${prefix}-radius`]: ipopExperienceTokens.radius,
    [`--${prefix}-gap`]: ipopExperienceTokens.gap,
    [`--${prefix}-ease`]: ipopExperienceTokens.motionEase,
  } as CSSProperties;
}
