import { describe, expect, it } from "vitest";
import { formatAge, formatTtl, isExpired } from "./ttl.js";

const NOW = Date.parse("2026-06-08T12:00:00Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const ahead = (ms: number): string => new Date(NOW + ms).toISOString();

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("formatAge", () => {
  it("renders compact relative ages", () => {
    expect(formatAge(ago(5 * SEC), NOW)).toBe("just now");
    expect(formatAge(ago(3 * MIN), NOW)).toBe("3m ago");
    expect(formatAge(ago(2 * HOUR), NOW)).toBe("2h ago");
    expect(formatAge(ago(3 * DAY), NOW)).toBe("3d ago");
  });
});

describe("formatTtl / isExpired", () => {
  it("returns null when there is no expiry", () => {
    expect(formatTtl(null, NOW)).toBeNull();
    expect(isExpired(null, NOW)).toBe(false);
  });

  it("counts down while pending", () => {
    expect(formatTtl(ahead(5 * MIN), NOW)).toBe("5m left");
    expect(formatTtl(ahead(2 * HOUR), NOW)).toBe("2h left");
    expect(isExpired(ahead(5 * MIN), NOW)).toBe(false);
  });

  it("flags an elapsed expiry", () => {
    expect(formatTtl(ago(1 * MIN), NOW)).toBe("expired");
    expect(isExpired(ago(1 * MIN), NOW)).toBe(true);
  });
});
