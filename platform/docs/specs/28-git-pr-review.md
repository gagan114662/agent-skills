# Spec 28 — Git / PR / diff / review workflow (#51)

> Implements [#51](https://github.com/gagan114662/agent-skills/issues/51). Feature phase 4 — real
> execution & Conductor parity. **Depends on #50** (real harness) + #25 (cloud execution runtime) +
> #58 (per-session workspace). Lifecycle: **DEFINE** artifact (`spec-driven-development`). Built the
> agent_skills way — each stage governed by a skill in `skills/`. No merge without approval + video.

## Goal
Give each agent session a **git worktree/branch** and a **review surface**: per-turn and cumulative
diffs, a web diff viewer, GitHub PR creation, CI/Checks status, and review comments that route **back
to the agent as context**. Today the platform has a messaging backend with agent execution (#25/#50)
but none of the git/PR/review product surface that is Conductor's core loop.

## Background
`SessionManager` (#25) drives an agent run server-side; the #58 `WorkspaceProvisioner` seam decides
the per-session working dir (`cwd`) the harness (#50, real `claude` CLI) edits in. That dir is a plain
folder today — **no git**. There is no diff, PR, checks, or review-comment surface anywhere in the
codebase. #51 introduces all of it, reusing the existing seams (provisioner for `cwd`, channel
capabilities for auth, the #5 realtime bus for live updates, the SessionManager for the round-trip).

## In scope
- **Worktree/branch per session.** A `GitWorkspaceService` (shells out to `git`, no new dep — mirrors
  the runtime's `spawn` precedent) that creates an isolated worktree on branch `agent/<sessionId>` off
  a configured base branch. A `GitWorkspaceProvisioner` wires it into the #58 seam so the harness edits
  land on the session branch. Opt-in via config (`GIT_WORKSPACE_REPO`); default unchanged, so all
  existing #25/#58 sessions and tests are untouched.
- **Diff service + web diff viewer.** `git diff` for two modes — **cumulative** (`base...branch`, all
  the session's work) and **turn** (`HEAD~1..HEAD`, the latest commit) — returned as a unified patch +
  per-file numstat. A dependency-free `DiffView` React component renders it with add/remove coloring.
- **Create PR flow.** `POST …/pull-request` commits the session's work, creates a GitHub PR (title /
  description / draft) through a `GitHubProvider` seam, and persists a `pull_requests` row. Editable
  title/description/draft from the web client.
- **Checks status surface.** `GET/refresh …/checks` reflects GitHub CI (pass/fail/in-progress + run
  list) onto the PR row and the web Checks tab.
- **Review comment → agent round trip.** Multiline comments attach to a session's diff
  (`file_path`, `line_start..line_end`, `body`); a **deliver** action formats the undelivered comments
  into a task and launches a **new agent session** to address them — recording `delivered_to_session_id`
  as the round-trip evidence. A **fix-CI** action forwards the failing run logs to a new session the
  same way.
- **Realtime.** `pull_request` and `review_comment` `ServerEvent` variants ride the existing
  `rt:channel:<id>` key (the carrying row is already persisted — best-effort live nudge, no new gateway
  pattern), so the web surface updates live.

## Out of scope (follow-ups — file as sub-issues)
- **Automerge / merge-queue / draft→ready automation.**
- **Graphite-style stacked PRs.**
- **Semantic / syntax-highlighted diff** (we render plain unified diff with line coloring).
- **Per-turn commit granularity from the harness stream** (#50 follow-up: typed `stream-json` → turns).
  We model a "turn" as the latest commit; finer turn boundaries layer on top later.
- **Real GitHub calls in CI** — the `gh` adapter is behind config + a dynamic import; CI/tests use the
  `none` provider or an injected fake (no network, no token).

## Trust & safety boundary (why seams)
- **Git is shelled, never client-controlled.** Branch names are derived from the server-issued
  `sessionId` (`agent/<sessionId>`); worktree paths are `worktreesRoot/<sessionId>`. No client string
  reaches a git ref or a shell — args are passed as an argv array to `spawn` (no shell), exactly like
  the #50 harness rule.
- **The GitHub token never touches a snapshot, log, or response.** The `gh` adapter reads it from env
  in the execution environment only; the `none` default has no credentials at all.
- **Every route is identity + channel-capability gated** (`requireIdentity`, `requireChannelCapability`)
  and **IDOR-scoped**: a session/PR/comment is only ever fetched scoped to the channel in the URL, so a
  caller cannot read or mutate another channel's review state.

## Data model — migration `0026_git_pr_review` (+ down)
- **`agent_sessions`** (ALTER): add `branch text`, `base_branch text`, `head_sha text` — the session's
  git refs, set when the git provisioner prepares / on commit. Nullable (non-git sessions leave them).
- **`pull_requests`**: `id, workspace_id, channel_id, session_id(fk agent_sessions set null),
  number(int null), url(null), title, body, draft(bool), state('draft'|'open'|'merged'|'closed'),
  checks_status('unknown'|'pending'|'success'|'failure'), base_branch, head_branch, provider('none'|'gh'),
  created_by_member_id, created_at, updated_at`. Indexed by channel and by session. CHECK on state +
  checks_status + provider.
- **`review_comments`**: `id, workspace_id, channel_id, session_id(fk), pull_request_id(fk null),
  file_path, line_start(int null), line_end(int null), body, author_member_id,
  delivered_to_session_id(uuid null — the follow-up session this comment was forwarded to),
  created_at`. Indexed by channel and by session.

## The git seam — `apps/server/src/git/`
```
GitRunner.run(args: string[], opts: { cwd }) -> { stdout, stderr, code }     // argv spawn, no shell
GitWorkspaceService(repoRoot, worktreesRoot, baseBranch, runner)
  branchFor(sessionId)            -> `agent/<sessionId>`           (deterministic, server-issued)
  prepare(sessionId)             -> { cwd, branch, baseBranch }    (idempotent `git worktree add`)
  commitTurn(sessionId, message) -> headSha | null                (`add -A`; commit iff staged diff)
  diff(sessionId, 'cumulative'|'turn') -> { patch, files: DiffFileStat[] }
  removeWorktree(sessionId)
GitWorkspaceProvisioner implements WorkspaceProvisioner          (prepare -> { cwd })
```
- **Worktree = isolation.** Each session edits its own worktree; branches never collide (keyed by id).
- **Lazy commit.** Diff/PR routes call `commitTurn` first, so a session's uncommitted edits become a
  reviewable diff without changing the heavily-tested `SessionManager`. Zero blast radius on #25.

## The GitHub seam — `apps/server/src/github/`
```
GitHubProvider:
  createPullRequest({ repoRoot, baseBranch, headBranch, title, body, draft }) -> { number, url, state }
  getChecks({ repoRoot, headBranch }) -> { status, conclusion, runs: CheckRun[] }
  getFailingLogs({ repoRoot, headBranch }) -> string
NoneGitHubProvider   (default)  -> throws GitHubUnavailableError -> route 501 "github not configured"
GhCliGitHubProvider  (GITHUB_PROVIDER=gh) -> shells `gh pr create/checks/run view`; loaded only when set
```
Mirrors the #25 `SandboxProvider` discipline: a real adapter behind config + a fake/none for hermetic
tests. CI never calls GitHub.

## REST surface (capability- and tenant-gated, IDOR-scoped to `:cid`)
```
GET  /channels/:cid/agent-sessions/:id/diff?mode=cumulative|turn        read   -> { branch, baseBranch, mode, patch, files }
POST /channels/:cid/agent-sessions/:id/pull-request                     write  -> 201 { pullRequest }       (commit + provider + persist + event)
GET  /channels/:cid/pull-requests                                       read   -> PullRequestDto[]
GET  /channels/:cid/pull-requests/:id                                   read   -> PullRequestDto
POST /channels/:cid/pull-requests/:id/checks/refresh                    write  -> { checksStatus, runs }   (provider + persist + event)
POST /channels/:cid/pull-requests/:id/fix-ci                           write  -> 202 { sessionId }         (failing logs -> new session)
GET  /channels/:cid/agent-sessions/:id/review-comments                  read   -> ReviewCommentDto[]
POST /channels/:cid/agent-sessions/:id/review-comments                  write  -> 201 { comment } (+event)
POST /channels/:cid/agent-sessions/:id/review-comments/deliver          write  -> 202 { sessionId, deliveredCount }  (comments -> new session)
```

## Web surface — `apps/web`
- New top-bar `View` `"review"` + nav button (mirrors the Approvals view toggle).
- `ReviewPanel`: pick a session → `DiffView` (cumulative/turn toggle), a review-comment composer,
  a **Deliver to agent** button, a **Create PR** form (title/body/draft), a **Checks** tab with a
  refresh + **Fix CI** action.
- `DiffView`: dependency-free unified-diff renderer (hunk headers, `+`/`-`/context line coloring).
- One store slice (`review`) + `api.review` namespace + `pull_request`/`review_comment` event handling.
- All routes live under the already-proxied `/channels` prefix → no `vite.config.ts` change.

## Testing strategy
- **Unit (hermetic, no DB — `pnpm test`):**
  - `git/workspace.test.ts` — against a **real temp git repo** (git is on the dev/CI host, no network):
    prepare creates branch+worktree; commitTurn commits iff there are changes; cumulative vs turn diff;
    numstat parse. Deterministic, isolated in `mkdtemp`.
  - `git/diff.test.ts` — numstat/patch parsing is pure.
  - `github/provider.test.ts` — `NoneGitHubProvider` throws `GitHubUnavailableError`; a fake satisfies
    the interface contract.
  - `routes/git-review.test.ts` — full route behavior via `app.inject` with injected fakes
    (GitWorkspaceService + GitHubProvider + SessionManager + in-memory repos): diff, create-PR (incl.
    501 when provider is `none`), comment, **deliver → new session + delivered_to_session_id**, fix-CI,
    auth gating + IDOR (wrong channel → 404).
  - `realtime/git-events.test.ts` — `pull_request`/`review_comment` event construction.
  - web: `store/review.test.ts` (actions + event reducers over a fake api), `DiffView.test.tsx`
    (renders add/del/context lines), `ReviewPanel.test.tsx` (smoke).
- **Integration (real Postgres, `LocalRuntime`, temp git repo, no GitHub — `pnpm test:integration`):**
  configure the git provisioner with a temp repo; launch a session whose harness writes a file; join;
  `GET …/diff` shows the file; `POST …/review-comments` then `…/deliver` launches a new session and
  stamps `delivered_to_session_id`; `POST …/pull-request` with an **injected fake provider** persists a
  `pull_requests` row + emits the event. No real `gh`, no token, no network.

## Boundaries
- **Always:** derive every git ref from the server-issued `sessionId`; pass git args as argv (no shell);
  gate + IDOR-scope every route to `:cid`; keep the GitHub token out of logs/responses/snapshots; keep
  the git provisioner + `gh` adapter opt-in (default behavior unchanged); write the failing test first;
  attach the demo video.
- **Ask first:** turning on the git provisioner or `gh` provider by default; adding a real git/GitHub
  dependency loaded in CI; anything that pushes to a real remote in CI.
- **Never:** let a client string reach a git ref or a shell; run `gh` in CI; bake a token into a row,
  log, or response; merge without approval + video.

## Success criteria
1. Agent work appears as a **branch + reviewable diff** in the web client (provisioner + diff route +
   `DiffView`).
2. A user **opens a PR** from a session; **checks status reflects GitHub** (PR route + checks refresh).
3. A **diff comment is delivered to the agent** and it runs again to address it (deliver → new session,
   `delivered_to_session_id` set).
4. **Failing CI can be forwarded** to the agent (fix-CI → new session).
5. `pnpm -C platform typecheck && lint && test && build` green; integration green.
6. ADR-0028 + this spec + demo `docs/demos/28-git-pr-review.mp4`; PR links #51; **not** merged.

## Plan (atomic)
1. `0026` migration + schema (`pull_requests`, `review_comments`, `agent_sessions` branch cols) +
   repositories — *slice 1*.
2. `git/` — `GitRunner`, `GitWorkspaceService`, `GitWorkspaceProvisioner` + diff parse — *slice 2*.
3. `github/` — `GitHubProvider`, `NoneGitHubProvider`, `GhCliGitHubProvider`, errors — *slice 3*.
4. `routes/git-review.ts` + `ServerEvent` variants + bus publishers + `app.ts` wiring + injection —
   *slice 4*.
5. Web — shared DTOs, `api.review`, store slice, `DiffView`, `ReviewPanel`, nav view — *slice 5*.
6. Tests (unit + integration, fake provider) — interleaved per slice (TDD).
7. ADR-0028 + demo + PR — *ship*.

> Approach: DEFINE → PLAN → BUILD with TDD → VERIFY → demo → PR; reviewed and merged by @gagan114662
> on the video. No merge without approval.
