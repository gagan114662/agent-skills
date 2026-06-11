import { describe, it, expect } from "vitest";
import {
  incidentChannelName,
  detectedMessage,
  triageMessage,
  repagedMessage,
  resolvedMessage,
} from "../../src/reliability/timeline.js";

const incident = {
  id: "inc-1",
  service: "api",
  sloKind: "availability" as const,
  severity: "critical" as const,
  observedValue: 0.4,
  targetValue: 0.99,
};

describe("incidentChannelName", () => {
  it("zero-pads the sequence to three digits", () => {
    expect(incidentChannelName(1)).toBe("incident-001");
    expect(incidentChannelName(42)).toBe("incident-042");
    expect(incidentChannelName(1234)).toBe("incident-1234");
  });
});

describe("timeline message bodies", () => {
  it("the detected message names the service, SLO, and severity", () => {
    const body = detectedMessage(incident);
    expect(body).toContain("api");
    expect(body).toContain("availability");
    expect(body).toContain("critical");
    expect(body.toLowerCase()).toContain("detected");
  });

  it("the triage message references the launched session", () => {
    expect(triageMessage("sess-9")).toContain("sess-9");
  });

  it("the repaged message signals a sustained, still-firing breach", () => {
    expect(repagedMessage(incident).toLowerCase()).toContain("still");
  });

  it("the resolved message links the postmortem path", () => {
    const body = resolvedMessage(incident, "docs/postmortems/2026-06-11-api.md");
    expect(body.toLowerCase()).toContain("resolved");
    expect(body).toContain("docs/postmortems/2026-06-11-api.md");
  });
});
