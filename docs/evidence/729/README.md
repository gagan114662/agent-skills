# #729 — Premium workspace chrome polish (evidence)

Before/after screenshots for the workspace-chrome polish (channels rail, message rows, inline task +
approval cards, composer, the floating command dock, and the light/dark theme toggle).

- `compare-light.png` / `compare-dark.png` — before (origin/main) above, after (#729) below.
- `before-*.png` / `after-*.png` — the individual frames, light and dark.

## How these were rendered

The authed workspace chrome (`ConsoleView`) needs a logged-in session + live backend, so the frames are
rendered from a static harness that loads the **real `src/styles.css`** (before = `origin/main`, after =
this branch) over markup that mirrors the actual component class names — `ChannelSidebar` / `MessagePane` /
`Composer` / `Board` (running + `card--need` approval card) / `ReviewRow` / `CommandDock`. So the diff you
see is exactly the CSS + dock change, not a redesign of the harness. Captured at 1200px wide via the gstack
headless browser. The harness itself lives under the gitignored workspace `.context/` and is not committed.
