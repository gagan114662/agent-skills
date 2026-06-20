---
name: ads-cac-targets
kind: reference
domain: ads
description: Unit-economics discipline for ad spend — target CAC from margin and churn, the 3:1 LTV:CAC rule, payback, and creative-driven testing.
---

# CAC Targets & Unit Economics

You cannot responsibly plan spend without a **target CAC** derived from unit economics. Spend with no CAC ceiling is gambling. The discipline: compute the most you can pay for a customer *before* launching, then treat that number as the hard wall every campaign is measured against.

## The core metrics

- **CAC (Customer Acquisition Cost)** = total acquisition spend ÷ new customers acquired. Use *fully-loaded* spend (ad cost + tooling + any commission), not just media.
- **LTV (Lifetime Value)** = the gross-margin dollars a customer generates over their lifetime. The margin qualifier is non-negotiable — revenue LTV flatters you into overspending.

  **LTV = (ARPA × gross margin %) ÷ monthly churn rate**

- **LTV:CAC ratio** — the headline health number. **Aim ≥ 3:1.** Below 3:1 you're under-monetizing acquisition; *above ~5:1* you're likely **underspending** and leaving growth on the table (counterintuitively, too-high a ratio is a signal to spend *more*).
- **CAC payback period** = CAC ÷ (ARPA × gross margin %), in months. **Target < 12 months** for SMB SaaS; < 18 for enterprise. Payback is the cash-flow constraint — even great LTV:CAC kills you if payback is 24 months and you can't fund the gap.

## Computing a target CAC — worked example

Product: **$100/month**, **80% gross margin**, **5% monthly churn.**

1. **Average lifetime** = 1 ÷ churn = 1 ÷ 0.05 = **20 months.**
2. **LTV** = ARPA × margin × lifetime = $100 × 0.80 × 20 = **$1,600.**
   (Equivalently (100 × 0.80) ÷ 0.05 = $1,600.)
3. **Target CAC at 3:1** = LTV ÷ 3 = $1,600 ÷ 3 ≈ **$533.**
4. **Payback at that CAC** = $533 ÷ ($100 × 0.80) = $533 ÷ $80 ≈ **6.7 months.** ✓ under 12.

So this product can pay **up to ~$533** per customer and stay healthy. Plan campaigns to a **blended-CAC ceiling of $533**, and ideally a *target* of ~$400 to leave headroom for churn surprises and channel-CPM inflation.

If churn were 10%/month instead: lifetime = 10 months, LTV = $800, target CAC = $267 — **half the budget headroom.** This is why churn, not CPC, is often the real lever on what you can afford to spend. Always recompute target CAC when churn or margin moves.

## Why you can't scale until CAC < LTV with margin

Scaling drives **diminishing returns**: as you spend more, you reach less-qualified audiences and marginal CAC *rises*. If you start scaling while CAC already hovers near LTV, marginal CAC crosses LTV and you lose money on every *new* customer even if the blended number looks fine. **Rule: only scale a unit whose proven CAC sits comfortably below target (ideally ≤ 0.6 × target CAC), so there's room for marginal CAC to climb as you spend.**

## Creative is 80% of performance — test one variable at a time

In modern auction-optimized platforms, targeting and bidding are largely automated; **creative is the single biggest lever on CAC** — routinely a 2–5× swing between your best and worst ad while everything else is identical. So the cheapest way to lower CAC is almost always a better hook/angle, not a bid tweak.

Test discipline so results are causal:
- **One variable per test** (hook, or visual, or offer — never all three). If you change three things and CPA drops, you've learned nothing about *why*.
- **Test angles, not pixels.** "Save 10 hours/week" vs. "Stop losing leads" teaches more than two button colors.
- **Hold the test to significance** — don't crown a winner on a 3-conversion lead (see budget-pacing's ~30–50-conversion / CTR-significance thresholds).
- Winning creative fatigues; **frequency > ~3–4 (Meta) signals refresh.** Maintain a backlog of fresh angles — creative is a renewable pipeline, not a one-time asset.

made by robots, steered by humans.
