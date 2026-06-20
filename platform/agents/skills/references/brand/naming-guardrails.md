---
name: brand-naming-guardrails
kind: reference
domain: brand
description: Rules for naming products and features, terminology consistency, and basic trademark sanity.
---

# Naming Guardrails

A name is a promise the user has to remember. Bad names tax every future conversation. These
rules keep the whole fleet naming the same things the same way.

## Naming principles

**1. Clear beats clever. Say what it is.** A name's job is recognition, not delight. "Approval
Queue" beats "GateKeeper." "Spend Cap" beats "Sentinel." If a new user can't guess what a
feature does from its name, the name failed. Reserve cleverness for the brand line ("Made by
robots, steered by humans"), not for the nouns people navigate by.

**2. Describe the job, not the tech.** Name for what the user gets, not how it's built. "Weekly
Recap," not "LLM Digest Generator." Tech-flavored names age badly and confuse non-engineers.

**3. One name per thing, forever.** The single most expensive naming mistake is calling one
thing three names. "Workspace" / "account" / "org" for the same object splits documentation,
support, and trust. Pick one. Retire the others everywhere.

**4. Keep names short and pronounceable.** One or two words. If people will abbreviate it,
choose the abbreviation yourself. If they can't say it on a call, rename it.

## Capitalization and terminology consistency

Decide once, enforce everywhere:

- **Proper-noun features get Title Case:** the Approval Queue, the Weekly Recap, Spend Caps.
- **Generic actions stay lowercase:** approve a draft, connect an account, set a cap.
- **The product is `ipop`** — lowercase, always, even at the start of a sentence in body copy.
  Never "Ipop," "iPop," or "IPOP."
- **Agents are named with a role, not a cute label:** @mark (brand), @bid (ads). Consistent
  handle form, lowercase after the @.
- Pick American spelling, the serial comma, and sentence case for buttons/headings — and
  never mix them mid-product.

## Avoid name clutter

Every new name is a tax on memory. Before minting one, ask: **does this need a name at all?**
Most features don't — they're just buttons ("Connect account"). Name something only when users
will refer to it repeatedly across sessions. Prefer extending an existing name ("Recap" →
"Weekly Recap," "Monthly Recap") over inventing a new family. A product with 6 well-known names
beats one with 30 half-remembered ones. Sunset old names on sight; don't let synonyms accumulate.

## Basic trademark sanity

@mark is not a lawyer, but does these cheap checks before proposing any public-facing product
or company name — and flags anything risky to a human rather than committing the brand to it:

1. **Exact-match search** — Google the name + "app" / "software." If a funded company in an
   adjacent space owns it, drop it.
2. **Domain + handle check** — is the `.com` and the social handle reachably available? If the
   only option is a tortured spelling, the name will leak that pain forever.
3. **USPTO TESS quick search** (trademark database) for live marks in related classes. A live
   mark in the same category is a hard stop.
4. **No generic + no descriptive-only** — purely descriptive names ("Email Sender") are weak
   and unprotectable; coined or suggestive names are stronger.
5. **Slang / cross-language check** — make sure it isn't an embarrassing word elsewhere.

If any check trips, the name does not ship — escalate to a human owner. Naming is irreversible
in users' heads, so treat a public name like a one-way door.

## The terminology table

The fleet's anti-drift weapon. Maintain one table; everyone writes from it.

| Use this | Not these | Notes |
|----------|-----------|-------|
| ipop | Ipop, iPop, the platform | lowercase always |
| workspace | account, org, tenant | one object, one word |
| Approval Queue | gate, review queue, GateKeeper | Title Case feature |
| Spend Cap | budget limit, ceiling | the money guardrail |
| draft | output, generation, artifact | what an agent produces |
| approve | sign off, greenlight, OK | the user's action |

Add a row the moment a new term appears in product. If two surfaces disagree, the table wins.
This table is the source of truth — link it from every brief, and reconcile copy against it
before anything ships.

made by robots, steered by humans.
