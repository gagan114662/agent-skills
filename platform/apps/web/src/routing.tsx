/**
 * A tiny, dependency-free client router. The console is a single-page app served from one origin;
 * the only routing it needs is "which top-level screen am I on" — landing (`/`), `/login`, `/signup`,
 * or the authenticated app. Pulling in react-router for that would violate the "no heavy deps" budget
 * (#149), so this is ~40 lines over the History API + `useSyncExternalStore`.
 *
 * `useRoute()` returns the current pathname and re-renders on `navigate()` or browser back/forward.
 * `<Link>` is an accessible `<a>` that client-navigates on a plain click but defers to the browser for
 * modified clicks (cmd/ctrl/shift/middle — "open in new tab" must keep working).
 */
import { useSyncExternalStore, type MouseEvent, type ReactNode } from "react";

const listeners = new Set<() => void>();

export const APP_ROUTES = {
  home: "/",
  everyday: "/everyday",
  dashboard: "/dashboard",
  terms: "/terms",
  privacy: "/privacy",
} as const;

function path(): string {
  return window.location.pathname;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("popstate", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("popstate", onChange);
  };
}

/** Push a new path and notify subscribers. No-op if already there (avoids dead history entries). */
export function navigate(to: string): void {
  if (to === path()) return;
  window.history.pushState({}, "", to);
  for (const l of listeners) l();
}

/**
 * Replace the current path *in place* — no new history entry — then notify subscribers. Use this for
 * a redirect through an intermediate/transient route (e.g. the logged-out → /start → app-destination
 * hop in AuthGate): replacing the entry instead of pushing keeps the unauthorized/intermediate URL out
 * of the back-stack, so Back can't return the visitor to a dead route that immediately bounces forward.
 */
export function replace(to: string): void {
  if (to === path()) return;
  window.history.replaceState({}, "", to);
  // PopStateEvent is the same signal browser back/forward emits, so every useRoute() subscriber re-reads
  // the (replaced) location — no separate notify path that could drift from real navigation.
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** The current pathname, kept in sync with navigate() and browser back/forward. */
export function useRoute(): string {
  return useSyncExternalStore(subscribe, path, () => "/");
}

export interface LinkProps {
  href: string;
  className?: string;
  children: ReactNode;
  "aria-label"?: string;
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
}

/** Returns true for clicks the browser should handle itself (new tab / window / non-primary button). */
function isModifiedClick(e: MouseEvent<HTMLAnchorElement>): boolean {
  return e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
}

export function Link({ href, className, children, onClick, ...rest }: LinkProps): React.JSX.Element {
  return (
    <a
      href={href}
      className={className}
      aria-label={rest["aria-label"]}
      onClick={(e) => {
        onClick?.(e);
        if (isModifiedClick(e)) return; // let the browser open a new tab / window
        e.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}
