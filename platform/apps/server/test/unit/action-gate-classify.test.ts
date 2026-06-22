/**
 * Unit tests for the pure action-gate classifier (issue #670). The classifier is the load-bearing decision:
 * is a proposed action PUBLIC or IRREVERSIBLE (→ must pause for a recorded human approval) or internal+reversible
 * (→ autonomous)? These tests pin the verb sets, the explicit-flag overrides, the fail-closed default, and the
 * replay-proof fingerprint.
 */

import { describe, it, expect } from "vitest";
import {
  classifyAction,
  requiresConfirmation,
  actionFingerprint,
} from "../../src/action-gate/classify.js";

describe("classifyAction — the issue #670 scope (publish / send / post / delete)", () => {
  for (const verb of ["publish", "send", "post", "delete"]) {
    it(`gates a bare "${verb}"`, () => {
      const c = classifyAction({ action: verb });
      expect(c.mustConfirm).toBe(true);
    });
  }

  it("resolves namespaced + compound verbs to their real operation", () => {
    expect(classifyAction({ action: "email.send" }).mustConfirm).toBe(true);
    expect(classifyAction({ action: "social.publish_post" }).mustConfirm).toBe(true);
    expect(classifyAction({ action: "blog.delete" }).mustConfirm).toBe(true);
    expect(classifyAction({ action: "DB.READ" }).mustConfirm).toBe(false);
  });

  it("labels public vs irreversible vs both", () => {
    expect(classifyAction({ action: "email.send" }).klass).toBe("public+irreversible");
    expect(classifyAction({ action: "db.delete" }).klass).toBe("irreversible"); // destructive but internal
    expect(classifyAction({ action: "page.publish" }).klass).toBe("public+irreversible");
  });
});

describe("classifyAction — internal + reversible actions run autonomously", () => {
  for (const verb of ["read", "get", "list", "fetch", "preview", "draft", "validate", "render"]) {
    it(`does not gate a bare "${verb}"`, () => {
      expect(requiresConfirmation({ action: verb })).toBe(false);
    });
  }

  it("does not gate a read even with a surface attached", () => {
    expect(requiresConfirmation({ action: "report.read", surface: "dashboard" })).toBe(false);
  });
});

describe("classifyAction — explicit flags override the verb inference", () => {
  it("an explicit reversible:false forces a confirmation on an otherwise-safe verb", () => {
    expect(classifyAction({ action: "draft", reversible: false }).mustConfirm).toBe(true);
  });

  it("an explicit public:true forces a confirmation on an otherwise-safe verb", () => {
    const c = classifyAction({ action: "preview", public: true });
    expect(c.mustConfirm).toBe(true);
    expect(c.visibility).toBe("public");
  });

  it("an explicit reversible:true + public:false opts a known-unknown verb OUT of the gate", () => {
    // "generate" is not on any verb list → would fail closed; the caller declares it safe.
    expect(classifyAction({ action: "report.generate" }).mustConfirm).toBe(true);
    expect(classifyAction({ action: "report.generate", reversible: true, public: false }).mustConfirm).toBe(false);
  });

  it("an irreversible verb stays gated even when the caller claims it is reversible", () => {
    // The verb wins on the danger side: an explicit reversible:true cannot UN-gate a `delete`.
    const c = classifyAction({ action: "delete", reversible: true });
    expect(c.reversibility).toBe("irreversible");
    expect(c.mustConfirm).toBe(true);
  });
});

describe("classifyAction — fail-closed on uncertainty", () => {
  it("gates an unknown verb with no hints", () => {
    const c = classifyAction({ action: "frobnicate" });
    expect(c.mustConfirm).toBe(true);
    expect(c.klass).toBe("uncertain");
    expect(c.reversibility).toBe("unknown");
    expect(c.visibility).toBe("unknown");
  });

  it("gates an empty / malformed action descriptor", () => {
    expect(classifyAction({ action: "" }).mustConfirm).toBe(true);
    // @ts-expect-error — exercising the runtime guard against a non-object input
    expect(classifyAction(null).mustConfirm).toBe(true);
  });
});

describe("classifyAction — policy can only tighten the gate", () => {
  it("extra irreversible verbs broaden the danger list", () => {
    expect(classifyAction({ action: "archive" }).mustConfirm).toBe(true); // unknown → already fail-closed
    const c = classifyAction({ action: "archive" }, { extraIrreversibleVerbs: ["archive"] });
    expect(c.reversibility).toBe("irreversible");
  });

  it("extra safe verbs let a deployment mark its own internal ops autonomous", () => {
    expect(classifyAction({ action: "reindex" }).mustConfirm).toBe(true);
    expect(classifyAction({ action: "reindex" }, { extraSafeVerbs: ["reindex"] }).mustConfirm).toBe(false);
  });
});

describe("actionFingerprint — binds an approval to one exact action", () => {
  it("is stable across payload key order", () => {
    const a = actionFingerprint({ action: "email.send", payload: { to: "x@y.z", count: 3 } });
    const b = actionFingerprint({ action: "email.send", payload: { count: 3, to: "x@y.z" } });
    expect(a).toBe(b);
  });

  it("differs when the payload differs (no cross-action replay)", () => {
    const five = actionFingerprint({ action: "record.delete", payload: { id: 5 } });
    const ninetynine = actionFingerprint({ action: "record.delete", payload: { id: 99 } });
    expect(five).not.toBe(ninetynine);
  });

  it("differs when the verb differs", () => {
    expect(actionFingerprint({ action: "page.publish" })).not.toBe(actionFingerprint({ action: "page.delete" }));
  });
});
