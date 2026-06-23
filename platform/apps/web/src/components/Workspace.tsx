/**
 * The authed shell (console v5). There is no top nav anymore — the whole product is the two-pane console
 * (left projects → sessions, center board, drawer to dive in). This wrapper exists only to host the
 * full-height `.workspace` frame; every surface, including the few off-board overlays (settings, pricing),
 * lives inside {@link ConsoleView}. The old multi-tab shell was superseded by the #199 → v5 redesign.
 */
import { CONSOLE } from "../brand.js";
import { useAppState, useStore } from "../store/StoreContext.js";
import { ConsoleView } from "./console/ConsoleView.js";
import { ExperienceOnboarding } from "./experience/ExperienceOnboarding.js";
import {
  IPOP_EXPERIENCE_ONBOARDING_ENABLED,
  IPOP_EXPERIENCE_OWNER_WORKSPACE_ID,
  shouldShowExperienceOnboarding,
} from "./experience/experience-onboarding-flag.js";

export function Workspace(): React.JSX.Element {
  const store = useStore();
  const { error, identity } = useAppState();
  const showExperienceOnboarding = shouldShowExperienceOnboarding({
    flagOn: IPOP_EXPERIENCE_ONBOARDING_ENABLED,
    ownerWorkspaceId: IPOP_EXPERIENCE_OWNER_WORKSPACE_ID,
    workspaceId: identity?.workspaceId,
  });

  return (
    <div className="workspace">
      {showExperienceOnboarding ? <ExperienceOnboarding /> : <ConsoleView />}
      {error && (
        <aside className="workspace-toast workspace-toast--error" role="alert" aria-label={CONSOLE.errorToast.title}>
          <div className="workspace-toast__body">
            <strong>{CONSOLE.errorToast.title}</strong>
            <p id="workspace-error-details">{error}</p>
          </div>
          <a className="workspace-toast__details" href="#workspace-error-details">
            {CONSOLE.errorToast.details}
          </a>
          <button className="workspace-toast__dismiss" type="button" onClick={() => store.dismissError()}>
            {CONSOLE.errorToast.dismiss}
          </button>
        </aside>
      )}
    </div>
  );
}
