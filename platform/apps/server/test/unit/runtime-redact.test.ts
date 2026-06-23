import { describe, it, expect } from "vitest";
import {
  redactSecrets,
  makeRedactor,
  redactPotentialSecrets,
  REDACTION_MASK,
} from "../../src/runtime/redact.js";

describe("secret redaction (#25 — secrets never in logs/output)", () => {
  it("replaces every occurrence of a secret value with the mask", () => {
    const out = redactSecrets("key=sk-abc123 again sk-abc123 done", ["sk-abc123"]);
    expect(out).toBe(`key=${REDACTION_MASK} again ${REDACTION_MASK} done`);
    expect(out).not.toContain("sk-abc123");
  });

  it("redacts longer secrets first so a contained secret isn't partially masked", () => {
    // "sk-abc" is a substring of "sk-abcdef"; the longer one must win.
    const out = redactSecrets("token sk-abcdef here", ["sk-abc", "sk-abcdef"]);
    expect(out).toBe(`token ${REDACTION_MASK} here`);
  });

  it("treats secret values as literals, not regex", () => {
    const out = redactSecrets("a.b.c matched", ["a.b.c"]);
    expect(out).toBe(`${REDACTION_MASK} matched`);
    // a regex interpretation of a.b.c would also match "axbxc"
    expect(redactSecrets("axbxc", ["a.b.c"])).toBe("axbxc");
  });

  it("ignores trivially short values (avoids masking noise)", () => {
    expect(redactSecrets("a a a", ["a"])).toBe("a a a");
  });

  it("makeRedactor is a no-op when there are no secrets", () => {
    const redact = makeRedactor({});
    expect(redact("nothing to hide")).toBe("nothing to hide");
  });

  it("makeRedactor scrubs all configured secret values", () => {
    const redact = makeRedactor({ A: "supersecretvalue", B: "anothersecret" });
    expect(redact("supersecretvalue / anothersecret")).toBe(`${REDACTION_MASK} / ${REDACTION_MASK}`);
  });

  it("redacts provider-shaped secrets even when no resolver handed us the value", () => {
    const out = redactPotentialSecrets(
      "OPENAI_API_KEY=sk-live-thisShouldDisappear and hook whsec_123456789abcdef",
    );
    expect(out).not.toContain("sk-live-thisShouldDisappear");
    expect(out).not.toContain("whsec_123456789abcdef");
    expect(out).toBe("OPENAI_API_KEY=" + REDACTION_MASK + " and hook " + REDACTION_MASK);
  });
});
