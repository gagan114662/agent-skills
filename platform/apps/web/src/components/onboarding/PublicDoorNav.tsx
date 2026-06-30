import { BRAND } from "../../brand.js";
import { APP_ROUTES } from "../../routing.js";
import { PopMark } from "../PopMark.js";
import { Wordmark } from "../Wordmark.js";

const DOOR_ACTIONS = [
  { key: "login", label: "Log in", href: "/login?return=" + encodeURIComponent(APP_ROUTES.everyday) },
  { key: "love", label: "Love", href: "/demo" },
  { key: "dashboard", label: "Dashboard", href: APP_ROUTES.dashboard },
  { key: "start", label: "Start", href: "#onboard-target" },
] as const;

export function PublicDoorNav({ className = "" }: { className?: string }): React.JSX.Element {
  return (
    <header className={["onboard__nav", className].filter(Boolean).join(" ")}>
      <a href={APP_ROUTES.home} className="onboard__brand" aria-label={BRAND.name}>
        <PopMark className="onboard__brand-mark" size={42} />
        <Wordmark className="onboard__brand-word" />
        <span className="onboard__brand-proof">marketing team in your messages</span>
      </a>
      <DoorActions />
    </header>
  );
}

function DoorActions(): React.JSX.Element {
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
    </nav>
  );
}
