import { describe, it, expect } from "vitest";
import { composeStatusPage, type StatusInput } from "../../src/reliability/status/compose.js";

const NOW = new Date("2026-06-11T12:00:00Z");

function inc(overrides: Record<string, unknown> = {}) {
  return {
    service: "api",
    sloKind: "availability",
    severity: "warning" as "warning" | "critical",
    status: "firing" as "firing" | "escalated" | "resolved",
    observedValue: 0.5,
    targetValue: 0.99,
    openedAt: new Date("2026-06-11T11:50:00Z"),
    resolvedAt: null as Date | null,
    ...overrides,
  };
}

function base(overrides: Partial<StatusInput> = {}): StatusInput {
  return {
    workspaceName: "Acme",
    components: [
      { name: "api", healthy: true },
      { name: "db", healthy: true },
      { name: "redis", healthy: true },
    ],
    incidents: [],
    now: NOW,
    ...overrides,
  };
}

describe("composeStatusPage — overall status", () => {
  it("reports operational when all components are up and no incident is active", () => {
    expect(composeStatusPage(base()).overall).toBe("operational");
  });

  it("reports major_outage when a component is down", () => {
    const page = composeStatusPage(base({ components: [{ name: "db", healthy: false }] }));
    expect(page.overall).toBe("major_outage");
    expect(page.components[0].status).toBe("major_outage");
  });

  it("reports degraded for an active warning incident", () => {
    expect(composeStatusPage(base({ incidents: [inc()] })).overall).toBe("degraded");
  });

  it("reports major_outage for an active critical incident", () => {
    expect(composeStatusPage(base({ incidents: [inc({ severity: "critical", status: "escalated" })] })).overall).toBe(
      "major_outage",
    );
  });

  it("ignores resolved incidents in the overall status", () => {
    const resolved = inc({ status: "resolved", resolvedAt: new Date("2026-06-11T11:59:00Z") });
    expect(composeStatusPage(base({ incidents: [resolved] })).overall).toBe("operational");
  });
});

describe("composeStatusPage — redaction", () => {
  it("never leaks observed/target internals in the incident history", () => {
    const page = composeStatusPage(base({ incidents: [inc({ severity: "critical" })] }));
    const item = page.incidents[0];
    expect(item).not.toHaveProperty("observedValue");
    expect(item).not.toHaveProperty("targetValue");
    expect(item.service).toBe("api");
    expect(item.severity).toBe("critical");
    expect(item.status).toBe("firing");
    expect(item.title).toContain("api");
    expect(JSON.stringify(item)).not.toContain("0.5"); // observed value absent
  });

  it("stamps the generated time and echoes the workspace name", () => {
    const page = composeStatusPage(base());
    expect(page.generatedAt).toBe(NOW.toISOString());
    expect(page.workspaceName).toBe("Acme");
  });
});
