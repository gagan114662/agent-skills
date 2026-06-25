import { describe, expect, it } from "vitest";
import { buildAcquisitionPipelinePreview } from "./pipeline-preview.js";

describe("buildAcquisitionPipelinePreview (#1200)", () => {
  it("never invents prospect rows when external sources are disabled", () => {
    const preview = buildAcquisitionPipelinePreview({
      domain: "https://www.acme.com/pricing",
      icp: "seed-stage SaaS founders",
      sourcesEnabled: false,
    });

    expect(preview.domain).toBe("acme.com");
    expect(preview.icp).toBe("seed-stage SaaS founders");
    expect(preview.prospects).toEqual([]);
    expect(preview.verification).toMatchObject({
      status: "blocked",
      receipt: "verification.blocked:no_external_sources",
    });
    expect(preview.sources.filter((s) => s.status === "blocked").length).toBeGreaterThan(0);
    expect(preview.outreach.status).toBe("approval_required");
    expect(preview.capacity.join(" ")).toMatch(/prospect rows/i);
    expect(preview.capacity.join(" ")).toMatch(/approval/i);
  });
});
