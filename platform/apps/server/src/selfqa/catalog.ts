import type { QaCheck, QaSuite } from "./types.js";

/**
 * The synthetic-user QA catalog (#171, ADR-0171) — **pure data**: the script a human QA follows, encoded
 * once. Each check is one observable expectation drawn from the owner's hand-test report (#166–#169):
 * sign in, switch channels, insert templates, @mention an agent, open every tab, click every primary
 * action, and assert the invariants a human notices — no horizontal overflow, no dead buttons, no stuck
 * popovers, and that a launched session actually replies.
 *
 * `smoke` ⊂ `full`: the smoke subset is exactly the critical/high checks, so a post-deploy run is fast
 * and only fires on regressions that matter; the nightly `full` run adds the medium/low surface sweep.
 */
export const QA_CATALOG: QaCheck[] = [
  {
    id: "auth-sign-in",
    surface: "auth",
    suites: ["smoke", "full"],
    title: "Sign in reaches the workspace",
    steps: [
      "Open the live web console.",
      "Enter the synthetic account credentials and submit the sign-in form.",
      "Wait for the AuthGate to resolve.",
    ],
    expectation: "The workspace shell renders (the channel sidebar and top-bar nav are present).",
    severityOnFail: "critical",
  },
  {
    id: "channels-switch",
    surface: "channels",
    suites: ["smoke", "full"],
    title: "Switching channels loads that channel's messages",
    steps: [
      "From the workspace, click a second channel in the sidebar.",
      "Observe the message pane.",
    ],
    expectation: "The active channel changes and its message pane renders (no blank pane, no error).",
    severityOnFail: "high",
  },
  {
    id: "channels-add",
    surface: "channels",
    suites: ["full"],
    title: "The add-channel control stays reachable and opens",
    steps: ["Scroll the channel sidebar.", "Click the add-channel control."],
    expectation: "The add-channel control is sticky/visible and opens its input.",
    severityOnFail: "medium",
  },
  {
    id: "composer-template-insert",
    surface: "composer",
    suites: ["full"],
    title: "Inserting a template fills the composer with its text",
    steps: ["Open the composer template picker.", "Select a template."],
    expectation: "The composer is populated with the template body (variables prompted, not raw {{var}}).",
    severityOnFail: "high",
  },
  {
    id: "composer-mention-agent",
    surface: "composer",
    suites: ["smoke", "full"],
    title: "@mentioning an agent opens the mentions popover and resolves",
    steps: ["Type '@' in the composer.", "Pick an agent from the popover.", "Send the message."],
    expectation: "The mention popover lists agents, resolves a selection, and the message sends.",
    severityOnFail: "high",
  },
  {
    id: "composer-send-button",
    surface: "composer",
    suites: ["smoke", "full"],
    title: "The send button is live (a click sends, not nothing)",
    steps: ["Type a message in the composer.", "Click the send button."],
    expectation: "The message appears in the pane (the button is not dead).",
    severityOnFail: "high",
  },
  {
    id: "nav-open-every-tab",
    surface: "navigation",
    suites: ["smoke", "full"],
    title: "Every primary tab opens its panel",
    steps: ["Click each top-bar nav item in turn (chat, automations, approvals, founder)."],
    expectation: "Each tab switches the view and renders its panel without error.",
    severityOnFail: "high",
  },
  {
    id: "nav-no-dead-buttons",
    surface: "navigation",
    suites: ["full"],
    title: "No dead primary buttons (each click has an observable effect)",
    steps: ["Click each primary action button on the open panels.", "Observe for a state change."],
    expectation: "Every primary button produces an observable effect (navigation, modal, or state change).",
    severityOnFail: "medium",
  },
  {
    id: "automations-create",
    surface: "automations",
    suites: ["full"],
    title: "Creating an automation surfaces success or a real error",
    steps: ["Open the automations panel.", "Fill the create form.", "Click create."],
    expectation: "The create action either succeeds visibly or surfaces an actionable error (never silent).",
    severityOnFail: "medium",
  },
  {
    id: "approvals-approve-button",
    surface: "approvals",
    suites: ["smoke", "full"],
    title: "The approvals panel renders pending items with a live approve control",
    steps: ["Open the approvals panel.", "Locate a pending approval.", "Confirm the approve control is enabled."],
    expectation: "Pending approvals render and the approve/deny controls are interactive (not dead).",
    severityOnFail: "high",
  },
  {
    id: "popover-escape-closes",
    surface: "layout",
    suites: ["full"],
    title: "No stuck popovers (Escape / outside-click closes them)",
    steps: ["Open a popover (mentions, template picker).", "Press Escape, then click outside."],
    expectation: "The popover dismisses on Escape and on outside-click (it does not get stuck open).",
    severityOnFail: "medium",
  },
  {
    id: "layout-no-overflow",
    surface: "layout",
    suites: ["smoke", "full"],
    title: "No horizontal overflow on any primary surface",
    steps: ["Load each primary surface at a standard viewport.", "Measure document scrollWidth vs clientWidth."],
    expectation: "scrollWidth never exceeds clientWidth (no horizontal scrollbar / clipped content).",
    severityOnFail: "high",
  },
  {
    id: "sessions-produce-replies",
    surface: "sessions",
    suites: ["smoke", "full"],
    title: "A launched agent session actually produces a reply",
    steps: ["@mention an agent with a trivial task.", "Wait for the session to run.", "Observe the channel."],
    expectation: "The session posts a reply back to the channel within the timeout (not a silent 'exit n/a').",
    severityOnFail: "critical",
  },
];

/** The checks that run for a suite. `smoke` checks are those tagged `smoke`; `full` is everything. */
export function checksForSuite(suite: QaSuite): QaCheck[] {
  return QA_CATALOG.filter((c) => (suite === "full" ? true : c.suites.includes("smoke")));
}

/** Resolve a check by id, or `undefined` for an unknown id (classify drops unknowns, never guesses). */
export function getCheck(id: string): QaCheck | undefined {
  return QA_CATALOG.find((c) => c.id === id);
}
