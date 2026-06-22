import { describe, it, expect } from "vitest";
import {
  fingerprintTemplate,
  evaluateTemplate,
  InMemoryTemplateApprovalRegistry,
} from "../../src/outbound-email/template-approval.js";

const NOW = 2_000_000;

const T = { id: "welcome-v1", subject: "Hi {{name}}", body: "Welcome aboard.\n" };

describe("fingerprintTemplate", () => {
  it("is stable across calls for identical content", () => {
    expect(fingerprintTemplate(T)).toBe(fingerprintTemplate({ ...T }));
  });

  it("ignores insignificant whitespace but changes when content changes", () => {
    const a = fingerprintTemplate({ id: "x", subject: " Hi ", body: "Body" });
    const b = fingerprintTemplate({ id: "x", subject: "Hi", body: "Body" });
    expect(a).toBe(b); // trimmed/normalized
    const c = fingerprintTemplate({ id: "x", subject: "Hi", body: "Body changed" });
    expect(c).not.toBe(b);
  });

  it("is scoped by template id (same content, different id ⇒ different fingerprint)", () => {
    expect(fingerprintTemplate({ id: "one", subject: "s", body: "b" })).not.toBe(
      fingerprintTemplate({ id: "two", subject: "s", body: "b" }),
    );
  });
});

describe("evaluateTemplate (per-template approval for NEW templates)", () => {
  it("blocks an unknown (new) template until it is approved", () => {
    const reg = new InMemoryTemplateApprovalRegistry();
    const d = evaluateTemplate(reg, T);
    expect(d.approved).toBe(false);
    expect(d.requiresApproval).toBe(true);
    expect(d.reason).toMatch(/approval/i);
  });

  it("allows a template once its exact content is approved", () => {
    const reg = new InMemoryTemplateApprovalRegistry();
    reg.approve(fingerprintTemplate(T), { approvedBy: "owner", at: NOW });
    const d = evaluateTemplate(reg, T);
    expect(d.approved).toBe(true);
    expect(d.requiresApproval).toBe(false);
  });

  it("requires RE-approval when an approved template's content is modified", () => {
    const reg = new InMemoryTemplateApprovalRegistry();
    reg.approve(fingerprintTemplate(T), { approvedBy: "owner", at: NOW });
    const modified = { ...T, body: "Welcome aboard. (now with a P.S.)" };
    const d = evaluateTemplate(reg, modified);
    expect(d.approved).toBe(false);
    expect(d.requiresApproval).toBe(true);
  });

  it("revoking approval blocks the template again", () => {
    const reg = new InMemoryTemplateApprovalRegistry();
    const fp = fingerprintTemplate(T);
    reg.approve(fp, { approvedBy: "owner", at: NOW });
    expect(evaluateTemplate(reg, T).approved).toBe(true);
    reg.revoke(fp);
    expect(evaluateTemplate(reg, T).approved).toBe(false);
  });
});
