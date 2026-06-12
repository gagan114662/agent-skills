# #169 evidence — shell overflow, pricing skeleton, dead kill-switch toggles

Captured from a faithful static reproduction of the workspace shell (the real `styles.css` linked into
a hand-built topbar + panel DOM), driven headlessly at the issue's target viewports.

## Bug 10 — shell layout overflow / clipping

Objective measurement of horizontal overflow (`documentElement.scrollWidth − clientWidth`) and whether
the page can scroll sideways (`window.scrollX` after scrolling right):

| view      | width | before | after |
|-----------|-------|--------|-------|
| settings  | 800   | (n/a)  | 0px, not scrollable |
| settings  | 901   | 106px  | 0px, not scrollable |
| settings  | 1280  | 2px    | 0px, not scrollable |
| approvals | 800   | (n/a)  | 0px, not scrollable |
| approvals | 901   | 106px  | 0px, not scrollable |
| approvals | 1280  | 2px    | 0px, not scrollable |

- `before-settings-901.png` / `after-settings-901.png` — the headline 901×628 pair. Before: the topbar
  overflows, "Sign out" wraps, count badges fly to the corner. After: full nav, badges anchored, nothing
  clipped.
- `before-settings-1280.png` / `after-settings-1280.png` — 1280×800 pair.
- `before-approvals-901.png` / `after-approvals-901.png` — the Approvals "Pending" tab (read it fully).

Regression guard: `apps/web/src/shell-layout.test.ts` (jsdom has no layout engine, so it asserts the CSS
declarations that keep the shell from scrolling sideways).

## Bug 11 — pricing skeleton

`pricing-loading-1280.png` — the three-dot pop loader + "Loading plans…" now fills the first-open wait
instead of a blank table. Plans are cached at module scope so a re-open is instant. Tests:
`apps/web/src/components/PricingPanel.test.tsx`.

## Bug 12 — kill-switch / maintenance toggles

`founder-switches-1280.png` — the switches are now interactive: a click opens a confirm step
(shown mid-confirm for maintenance), confirming applies an optimistic flip and calls the real,
human-gated endpoint (`POST …/autonomy/kill|resume`, `POST /maintenance`), reverting on failure.
No fake toggles: when the flag store is unavailable the control stays read-only. Tests:
`apps/web/src/components/FounderPanel.test.tsx` + `FounderDashboard.test.tsx`.
