/**
 * Public acquisition event seam (#1183). The marketing site must be able to prove the no-signup demo
 * funnel exists without coupling the app to one analytics provider. This helper emits the exact event name
 * three ways when the browser has them: a local CustomEvent for tests/embeds, dataLayer for GA-style tags,
 * and Plausible when it is installed. Missing providers are a no-op.
 */

export const ACQUISITION_EVENT_TARGET = "ipop:acquisition";

export type AcquisitionEventName =
  | "cta-click"
  | "activation-start"
  | "workspace-created"
  | "demo-start"
  | "demo-complete"
  | "demo-to-signup";

export interface AcquisitionEventDetail {
  url?: string;
  host?: string;
  source?: string;
  sectionCount?: number;
}

declare global {
  interface Window {
    dataLayer?: Array<Record<string, unknown>>;
    plausible?: (event: string, options?: { props?: Record<string, unknown> }) => void;
  }
}

export function trackAcquisitionEvent(name: AcquisitionEventName, detail: AcquisitionEventDetail = {}): void {
  if (typeof window === "undefined") return;
  const payload = { event: name, ...detail };
  window.dispatchEvent(new CustomEvent(ACQUISITION_EVENT_TARGET, { detail: payload }));
  window.dataLayer?.push(payload);
  window.plausible?.(name, { props: detail as Record<string, unknown> });
}
