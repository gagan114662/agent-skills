---
id: design/taste-skill
kind: reference
source: https://github.com/Leonxlnx/taste-skill
license: MIT
version: 1.0.0
description: Governed routing notes for using Leonxlnx Taste Skill as optional design-taste guidance for ipop agents.
---

# Taste Skill routing notes

Taste Skill is an upstream MIT-licensed agent-skill collection by Leonxlnx:
https://github.com/Leonxlnx/taste-skill. Its own install path is
npx skills add https://github.com/Leonxlnx/taste-skill, but ipop agents should treat this page as the
governed router. Do not install packages during a customer task. Do not fetch upstream instructions unless
the workspace/tooling explicitly allows that. Use the concepts here as drafting guidance, then keep every
public artifact behind ipop's brand, fact, content, publish, send, spend, and approval queue gates.

## Default versus opt-in

Use design-taste-frontend as the default taste lens for public product surfaces: landing pages, pricing
pages, onboarding, approval queues, demo flows, dashboards, case-study pages, and other brand-heavy screens.
The goal is to avoid generic AI-looking UI by checking hierarchy, spacing, typography, density, motion, and
whether the page has a specific design point of view.

Use redesign-existing-projects when the brief is to improve an existing ipop surface. Start with an audit:
name the current visual problem, the intended user, the highest-risk layout or copy flaw, and the smallest
set of changes that would make the surface feel intentional. Then draft the proposed fix; do not publish it.

Use image-to-code only when there is an explicit image-first workflow: reference frames, visual matching,
or a supplied mock. The image is evidence, not authority. If it contradicts ipop brand rules, product facts,
accessibility, or approval boundaries, call that out before implementing.

Keep gpt-taste, high-end-visual-design, minimalist-ui, and industrial-brutalist-ui opt-in. Reach for them
only when the human brief names a stronger direction, or when @mark has already approved the art direction.
full-output-enforcement is useful when a draft contains placeholder sections, TODO copy, or half-finished UI.

Image-generation helpers (imagegen-frontend-web, imagegen-frontend-mobile, brandkit) are reference
generators only. A generated frame can help align taste, but it does not approve a logo, claim, customer
metric, outbound post, email, ad, or production publish.

## How agents should use it

1. Restate the surface and audience in one line.
2. Pick one Taste Skill lens: default, redesign, image-to-code, or a named style variant.
3. Map the lens back to ipop: Paper / Ink / Pop Vermilion, house voice, real proof, human approvals, and
   no fake metrics.
4. Draft concrete changes with receipts: what changed, why it fits the user, and what still needs human
   review.
5. Stop at draft/recommendation unless a separate approved publish path exists.

## Boundaries

Taste Skill is taste guidance, not permission. It cannot authorize sending, posting, spending, publishing,
changing prices, claiming customer results, weakening accessibility, or bypassing the brand/fact gate. If a
visual recommendation would make ipop prettier but less true, reject it. If a recommendation needs a real
asset, ask @mark or the human owner to approve the direction first.

made by robots, steered by humans.
