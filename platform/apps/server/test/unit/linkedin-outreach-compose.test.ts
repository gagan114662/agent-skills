/**
 * Unit tests for the pure outreach composer (#595). Asserts determinism, value-first structure, the
 * personalization fallback ladder, both kinds, and the per-kind character clamp/truncation.
 */

import { describe, it, expect } from "vitest";
import { composeOutreach } from "../../src/linkedin-outreach/compose.js";
import {
  CONNECTION_NOTE_MAX,
  MESSAGE_MAX,
  type OutreachContext,
  type Prospect,
} from "../../src/linkedin-outreach/types.js";

const PROSPECT: Prospect = {
  ref: "urn:li:person:1",
  name: "Dana Lopez",
  company: "Acme Cloud",
  title: "VP Engineering",
  industry: "DevTools",
  hook: "your recent post on usage-based pricing",
};

const CONTEXT: OutreachContext = {
  senderName: "Sam Rivera",
  senderCompany: "ipop",
  valueProposition: "a teardown of how 3 infra teams cut onboarding time 40%",
  resourceRef: "https://ipop.ai/teardown",
  callToAction: "open to a quick swap of notes?",
};

describe("composeOutreach (#595)", () => {
  it("is deterministic — same inputs produce identical output", () => {
    const a = composeOutreach("message", PROSPECT, CONTEXT);
    const b = composeOutreach("message", PROSPECT, CONTEXT);
    expect(a).toEqual(b);
  });

  it("connection draft greets by first name, personalizes on the hook, and only asks to connect", () => {
    const draft = composeOutreach("connection", PROSPECT, CONTEXT);
    expect(draft.kind).toBe("connection");
    expect(draft.body.startsWith("Hi Dana,")).toBe(true);
    expect(draft.body).toContain("your recent post on usage-based pricing");
    expect(draft.body).toContain("Would love to connect.");
    expect(draft.charCount).toBe(draft.body.length);
    expect(draft.charCount).toBeLessThanOrEqual(CONNECTION_NOTE_MAX);
  });

  it("connection draft is value-first: it carries the value proposition and no hard pitch/ask", () => {
    const draft = composeOutreach("connection", PROSPECT, CONTEXT);
    expect(draft.body).toContain(CONTEXT.valueProposition);
    // No demanding CTA / pitch language in a connection note.
    expect(draft.body.toLowerCase()).not.toContain("buy");
    expect(draft.body.toLowerCase()).not.toContain("demo");
  });

  it("message draft offers value up front, shares the resource, ends with one soft CTA, and is signed", () => {
    const draft = composeOutreach("message", PROSPECT, CONTEXT);
    expect(draft.kind).toBe("message");
    expect(draft.body.startsWith("Hi Dana,")).toBe(true);
    expect(draft.body).toContain(CONTEXT.valueProposition);
    expect(draft.body).toContain("https://ipop.ai/teardown");
    expect(draft.body).toContain("open to a quick swap of notes?");
    expect(draft.body).toContain("— Sam Rivera, ipop");
    expect(draft.charCount).toBeLessThanOrEqual(MESSAGE_MAX);
  });

  it("falls back through role/company → company → role → industry → neutral when there is no hook", () => {
    const base: Prospect = { ref: "r", name: "Lee" };
    const roleCompany = composeOutreach("connection", { ...base, company: "Acme", title: "CTO" }, CONTEXT);
    expect(roleCompany.body).toContain("your work as CTO at Acme");

    const companyOnly = composeOutreach("connection", { ...base, company: "Acme" }, CONTEXT);
    expect(companyOnly.body).toContain("the team at Acme");

    const roleOnly = composeOutreach("connection", { ...base, title: "CTO" }, CONTEXT);
    expect(roleOnly.body).toContain("your work as CTO");

    const industryOnly = composeOutreach("connection", { ...base, industry: "Fintech" }, CONTEXT);
    expect(industryOnly.body).toContain("your work in Fintech");

    const neutral = composeOutreach("connection", base, CONTEXT);
    expect(neutral.body).toContain("your work");
  });

  it("uses a neutral greeting when the name is blank", () => {
    const draft = composeOutreach("message", { ref: "r", name: "   " }, CONTEXT);
    expect(draft.body.startsWith("Hi there,")).toBe(true);
  });

  it("omits the resource sentence when no resourceRef is provided", () => {
    const draft = composeOutreach("message", PROSPECT, { ...CONTEXT, resourceRef: null });
    expect(draft.body).not.toContain("Happy to share it directly");
  });

  it("uses a default CTA when none is provided", () => {
    const draft = composeOutreach("message", PROSPECT, { ...CONTEXT, callToAction: null });
    expect(draft.body).toContain("Open to a quick swap of notes if it's relevant?");
  });

  it("clamps an over-long connection note to the limit and flags truncation", () => {
    const longProspect: Prospect = { ...PROSPECT, hook: "x".repeat(400) };
    const draft = composeOutreach("connection", longProspect, CONTEXT);
    expect(draft.truncated).toBe(true);
    expect(draft.charCount).toBeLessThanOrEqual(CONNECTION_NOTE_MAX);
    expect(draft.body.endsWith("…")).toBe(true);
  });

  it("does not flag truncation for a short draft", () => {
    const draft = composeOutreach("connection", PROSPECT, CONTEXT);
    expect(draft.truncated).toBe(false);
  });

  it("clamps an over-long message body to the message limit", () => {
    const draft = composeOutreach("message", PROSPECT, {
      ...CONTEXT,
      valueProposition: "y".repeat(2000),
    });
    expect(draft.truncated).toBe(true);
    expect(draft.charCount).toBeLessThanOrEqual(MESSAGE_MAX);
  });
});
