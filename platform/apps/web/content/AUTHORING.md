# Writing for the ipop blog — Quill's authoring guide (#527)

This is the skill Quill (and any content agent) follows to ship a publishable post. The one rule that
makes everything else work:

> **Channel reasoning is not the artifact.** What you say in the thread — picking a keyword, flagging a
> truncated handoff, negotiating an SEO title with Scout, "drafted in #content for a human to grab" — is
> coordination. It is *for the channel*. None of it belongs in the committed `.md` file. The file contains
> only the finished post.

The seven content PRs that prompted this guide each leaked the channel into the artifact: agent chatter in
the `description`, `@scout` handoff notes as the opening paragraph, a slug that was really a chat message.
The [content gate](../scripts/content-gate.mjs) now blocks all of that automatically — this guide is how you
clear it on the first try.

## The two surfaces

| Surface | Lives in | Who reads it | Contains |
| --- | --- | --- | --- |
| **Channel reasoning** | the chat thread / your scratchpad | the fleet + the human steering you | keyword rationale, the handoff from Scout, "here's my draft for review", open questions |
| **The committed artifact** | `content/blog/<slug>.md` | the public + search crawlers | only the finished post: clean frontmatter + body |

Do your thinking in the channel. Commit only the artifact.

## The workflow

1. **Decide the keyword and angle in the channel.** Post your rationale to the thread, not the file.
2. **Copy `_template.md`** to `content/blog/<slug>.md`. The filename (minus `.md`) *is* the slug — they must match.
3. **Fill the frontmatter.** All six keys are required: `title`, `slug`, `description`, `author`, `date`, `status`.
   - `description` is the public meta description (≤ ~160 chars). It is **not** a place for notes to a reviewer.
   - `status: draft` — always. Drafting is the default; see the publish gate below.
4. **Write the body.** Real article from the first line. No "Got the handoff from…", no `#content`, no
   "for a human to review". Bare agent names in prose ("Scout reads your site like a crawler does") are fine —
   it's the `@handle`, the channel tag, and the coordination phrases that are banned.
5. **Run the gate locally:** `pnpm --filter @reload/web content:gate` (or `node scripts/content-gate.mjs`).
   Fix anything it flags. The same gate runs in CI and blocks the PR.
6. **Open the PR** with `status: draft`. A human reviews the rendered draft.

## The publish gate

A post goes live **only** when a human adds its slug to
[`published-allowlist.txt`](./published-allowlist.txt) and flips `status: published`, in a reviewed commit.
An agent never publishes itself: a PR that ships `status: published` for a slug not already in the allowlist
fails the gate. This is the deliberate, auditable line between "the agents drafted it" and "a human shipped it".

## What the gate checks (and how to pass)

| Rule | Pass by |
| --- | --- |
| `missing-frontmatter` | declare all six required keys, non-empty |
| `slug-filename-mismatch` | make `slug:` exactly the filename without `.md` |
| `internal-marker` | keep `@scout`, `@quill`, `handoff`, `#content`, "drop it", "my pipe", "for a human to grab", "A2A", "for human review", "nothing leaves the building" out of the title/description/body |
| `unauthorized-publish` | ship as `status: draft`; publish via the allowlist + a human |
| `duplicate-topic` | check `content/blog/` first — don't re-cover a topic an existing post already owns |

## Install the pre-PR hook (optional, recommended)

Catch issues before they leave your machine:

```sh
ln -sf ../../platform/apps/web/scripts/hooks/pre-push "$(git rev-parse --git-path hooks/pre-push)"
```

The hook runs the gate (`--changed`) on every `git push` and aborts the push on a violation.
