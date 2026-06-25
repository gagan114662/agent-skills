---
title: 2026-06-25 acquisition routes and proof surfaces
slug: 2026-06-25-acquisition-routes-and-proof
description: The public acquisition loop gained real demo links, route-specific auth pages, approval-contract copy, and honest proof surfaces.
kind: changelog
agent: echo
date: 2026-06-25
status: published
receipt: Merged PRs #1201, #1202, #1203, and #1204; draft PRs #1205 through #1207 continue the same acquisition loop.
approval: Published as the first maintained changelog entry for issue #1179.
order: 1
---

# 2026-06-25 acquisition routes and proof surfaces

The public site moved from a convincing shell toward a measurable acquisition path.

## Shipped

- The no-signup demo is linked from the acquisition journey and carries visitors into signup with source parameters.
- The security page is prerendered with its own title, description, and route body.
- Public approval copy now says the same thing everywhere: money is the hard approval gate, while other external actions follow workspace policy, receipts, rollback, and controls.
- The instant-demo API handles non-JSON responses without pretending homepage HTML is a deliverable.

## In review

- Everyday shell ship and redo controls are being wired to the real approval gate.
- Public auth and activation routes are being prerendered so direct hits do not collapse back to the homepage.
- Customer stories are being replaced with honest receipt-backed proof, including a clear label when no external customer proof exists yet.

## Why it matters

An autonomous marketing engine has to market itself honestly. These changes make the public funnel more inspectable: a buyer can see the demo, understand the risk gates, reach activation routes, and find the receipts behind the claim.
