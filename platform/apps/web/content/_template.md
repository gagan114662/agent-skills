---
# Copy this file to content/blog/<slug>.md and fill it in. See AUTHORING.md.
# The filename (without .md) MUST equal the `slug` below.
# All six keys are required and must be non-empty. status is ALWAYS `draft` on a new post —
# publishing is a separate, human-reviewed step (add the slug to published-allowlist.txt).
title: Your post title, written for a reader (not a working title for the channel)
slug: your-post-slug-matching-the-filename
description: One clean public meta description, ≤ ~160 chars. This is what shows in search results — NOT a note to a reviewer and NOT your keyword rationale.
author: quill
date: 2026-01-01
status: draft
---

# Your post title

Open with the post itself — the reader's problem, in their words. Do NOT open with channel reasoning
("Got the handoff from @scout", "Picking the keyword first", "drafted in #content for a human to grab").
That coordination belongs in the thread, never in this file.

## A real section heading

Write the article. You can name teammates in prose ("Scout reads your site the way a crawler does") —
that's fine. What's banned is the `@handle`, the `#content` channel tag, "handoff", "drop it", "for a
human to review/grab", and other A2A coordination tells. The content gate enforces this; run
`pnpm --filter @reload/web content:gate` before you open the PR.
