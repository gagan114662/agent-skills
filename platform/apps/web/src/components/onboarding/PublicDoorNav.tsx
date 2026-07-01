import { BRAND, COMPANY, LEGAL } from "../../brand.js";
import { APP_ROUTES } from "../../routing.js";
import { PopMark } from "../PopMark.js";
import { Wordmark } from "../Wordmark.js";
import { TELEGRAM_BOT_URL } from "./messaging-entry.js";

const DOOR_ACTIONS = [
  { key: "login", label: "Login", href: "/login?return=" + encodeURIComponent(APP_ROUTES.everyday) },
  { key: "love", label: "Love", href: "/demo" },
  { key: "dashboard", label: "Dashboard", href: APP_ROUTES.dashboard },
] as const;

export function PublicDoorNav({
  className = "",
  startHref = TELEGRAM_BOT_URL,
}: {
  className?: string;
  startHref?: string;
}): React.JSX.Element {
  return (
    <header className={["onboard__nav", className].filter(Boolean).join(" ")}>
      <a href={APP_ROUTES.home} className="onboard__brand" aria-label={BRAND.name}>
        <PopMark className="onboard__brand-mark" size={42} />
        <Wordmark className="onboard__brand-word" />
        <span className="onboard__brand-proof">marketing team in your messages</span>
      </a>
      <DoorActions startHref={startHref} />
    </header>
  );
}

export function PublicDoorFooter({ className = "" }: { className?: string }): React.JSX.Element {
  return (
    <footer className={["onboard__footer", "public-door-footer", className].filter(Boolean).join(" ")}>
      <nav className="public-door-footer__links" aria-label="Public footer">
        <a href="/demo">Demo</a>
        <a href="/pricing">Pricing</a>
        <a href={COMPANY.href}>Company</a>
        <a href={LEGAL.terms.href}>Terms</a>
        <a href={LEGAL.privacy.href}>Privacy</a>
      </nav>
    </footer>
  );
}

function DoorActions({ startHref }: { startHref: string }): React.JSX.Element {
  return (
    <nav className="onboard-door-actions" aria-label="homepage actions">
      {DOOR_ACTIONS.map((action) => (
        <a
          key={action.key}
          className="onboard-door-action"
          data-kind={action.key}
          href={action.href}
          aria-label={action.key === "love" ? "Love: watch a demo" : undefined}
        >
          <span className="onboard-door-action__mark" aria-hidden="true" />
          <span className="onboard-door-action__label">{action.label}</span>
        </a>
      ))}
      <a className="onboard-door-action" data-kind="start" href={startHref}>
        <span className="onboard-door-action__mark" aria-hidden="true" />
        <span className="onboard-door-action__label">Start</span>
      </a>
    </nav>
  );
}
