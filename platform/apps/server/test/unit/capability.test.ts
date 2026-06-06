import { describe, it, expect } from "vitest";
import { satisfies, effectiveCapability } from "../../src/auth/access.js";

describe("capability ladder (read < write < propagate)", () => {
  it("satisfies is true only when the held rank meets or exceeds the needed rank", () => {
    expect(satisfies("read", "read")).toBe(true);
    expect(satisfies("write", "read")).toBe(true);
    expect(satisfies("propagate", "write")).toBe(true);
    expect(satisfies("read", "write")).toBe(false);
    expect(satisfies("write", "propagate")).toBe(false);
  });

  it("effective capability: explicit grant wins, else members default to write", () => {
    expect(effectiveCapability("read", true)).toBe("read"); // explicit downgrade
    expect(effectiveCapability("propagate", true)).toBe("propagate"); // explicit upgrade
    expect(effectiveCapability(null, true)).toBe("write"); // member default (preserves #4)
  });

  it("a non-member has no capability regardless of any stale grant", () => {
    expect(effectiveCapability(null, false)).toBeNull();
    expect(effectiveCapability("propagate", false)).toBeNull();
  });
});
