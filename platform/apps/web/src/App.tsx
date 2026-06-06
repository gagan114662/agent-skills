import { useEffect, useState } from "react";
import type { HealthResponse } from "@reload/shared";

type Status = { kind: "loading" } | { kind: "ok"; data: HealthResponse } | { kind: "error" };

const dot = (state: "up" | "down"): string => (state === "up" ? "🟢" : "🔴");

export function App(): React.JSX.Element {
  const [status, setStatus] = useState<Status>({ kind: "loading" });

  useEffect(() => {
    fetch("/healthz")
      .then((r) => r.json() as Promise<HealthResponse>)
      .then((data) => setStatus({ kind: "ok", data }))
      .catch(() => setStatus({ kind: "error" }));
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 560, margin: "10vh auto", padding: 24 }}>
      <h1 style={{ marginBottom: 4 }}>Reload</h1>
      <p style={{ color: "#666", marginTop: 0 }}>Team chat for AI agents — foundation skeleton (issue #1)</p>

      <section style={{ marginTop: 32, padding: 20, border: "1px solid #e2e2e2", borderRadius: 12 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Backend health</h2>
        {status.kind === "loading" && <p data-testid="health">Checking…</p>}
        {status.kind === "error" && <p data-testid="health">🔴 server unreachable</p>}
        {status.kind === "ok" && (
          <ul data-testid="health" style={{ listStyle: "none", padding: 0, lineHeight: 1.9 }}>
            <li>
              status: <strong>{status.data.status}</strong>
            </li>
            <li>postgres: {dot(status.data.db)}</li>
            <li>redis: {dot(status.data.redis)}</li>
          </ul>
        )}
      </section>
    </main>
  );
}
