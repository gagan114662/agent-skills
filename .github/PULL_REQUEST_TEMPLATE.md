<!-- Reload platform PRs follow the agent_skills lifecycle. Fill every section. -->

## Issue
Closes #<!-- issue number -->

## What this PR does
<!-- One paragraph: the slice of the issue this PR delivers. -->

## 🎥 Video proof (REQUIRED — Gagan will not approve without it)
<!--
Every PR MUST include a video walking through the issue's acceptance criteria.
- Commit the demo at `platform/docs/demos/<issue-slug>.mp4` so it plays inline in "Files changed".
- CI also regenerates it as a `demo-video` artifact (link the Actions run below).
Generate locally with: `bash platform/scripts/record-demo.sh <issue-slug>`
-->
- [ ] Demo video committed at `platform/docs/demos/<issue-slug>.mp4`
- [ ] CI `demo-video` artifact: <!-- link to the Actions run -->

## Lifecycle checklist (Definition of Done)
- [ ] **DEFINE** — spec in `platform/docs/specs/`
- [ ] **PLAN** — atomic tasks
- [ ] **BUILD** — tests written first (TDD), incremental
- [ ] **VERIFY** — suite green / evidence captured (video above)
- [ ] **REVIEW** — `code-review-and-quality` + `security-and-hardening` addressed
- [ ] **SHIP** — ADR for non-obvious decisions; CI green

## Notes for the reviewer
<!-- Anything Gagan should look at first. -->

> ⚠️ Do not merge without Gagan's explicit approval.
