import { describe, it, expect } from "vitest";
import { resolveCatalogCaps, CATALOG_DEFAULTS } from "../../src/catalog/caps.js";
import { isCatalogKind, isCatalogStatus, isCatalogProvenance } from "../../src/catalog/types.js";

describe("catalog caps (#152)", () => {
  it("defaults to OFF with a hard entry cap", () => {
    expect(resolveCatalogCaps(undefined)).toEqual(CATALOG_DEFAULTS);
    expect(resolveCatalogCaps(undefined).enabled).toBe(false);
  });

  it("an explicit config overrides only the set fields", () => {
    const caps = resolveCatalogCaps({ enabled: true });
    expect(caps.enabled).toBe(true);
    expect(caps.maxEntries).toBe(CATALOG_DEFAULTS.maxEntries);
  });
});

describe("catalog type guards (#152)", () => {
  it("validates kinds", () => {
    expect(isCatalogKind("site")).toBe(true);
    expect(isCatalogKind("analytics_property")).toBe(true);
    expect(isCatalogKind("nope")).toBe(false);
    expect(isCatalogKind(3)).toBe(false);
  });

  it("validates statuses + provenance", () => {
    expect(isCatalogStatus("active")).toBe(true);
    expect(isCatalogStatus("deleted")).toBe(false);
    expect(isCatalogProvenance("agent")).toBe(true);
    expect(isCatalogProvenance("robot")).toBe(false);
  });
});
