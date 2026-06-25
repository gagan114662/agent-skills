import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client.js";
import type { SkillOptProposalDto } from "../../api/types.js";
import { CONSOLE } from "../../brand.js";

function pct(n: number | null): string {
  return n === null ? "n/a" : `${Math.round(n * 100)}%`;
}

function reading(p: SkillOptProposalDto): string {
  if (p.baseline === null || p.candidate === null || p.metric === null) return p.skipReason ?? "no reading";
  const dir = p.higherIsBetter === false ? "lower is better" : "higher is better";
  return `${p.metric}: ${p.baseline} -> ${p.candidate} (${pct(p.improvementRatio)}, ${dir})`;
}

export function SkillOptProposalsPanel(): React.JSX.Element {
  const copy = CONSOLE.settings.skillopt;
  const [proposals, setProposals] = useState<SkillOptProposalDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.skillopt.proposals();
      setProposals(res.proposals);
    } catch {
      setError(copy.error);
    } finally {
      setLoading(false);
    }
  }, [copy.error]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function decide(p: SkillOptProposalDto, decision: "adopt" | "reject"): Promise<void> {
    if (!p.requestId || busyId) return;
    setBusyId(p.id);
    setError(null);
    try {
      if (decision === "adopt") await api.approvals.approve(p.requestId, copy.adoptReason);
      else await api.approvals.reject(p.requestId, copy.rejectReason);
      await refresh();
    } catch {
      setError(copy.decisionError);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="skillopt-panel" aria-label={copy.title}>
      <div className="field">
        <div className="sheet__gate">
          <div className="sheet__gatetitle">{copy.title}</div>
          <div className="sheet__gatesub">{copy.hint}</div>
        </div>
      </div>

      {loading ? <p className="field__hint">{copy.loading}</p> : null}
      {error ? (
        <p className="field__hint" role="alert">
          {error}
        </p>
      ) : null}
      {!loading && proposals.length === 0 ? <p className="field__hint">{copy.empty}</p> : null}

      <ul className="sheet__roster">
        {proposals.map((p) => (
          <li key={p.id} className="sheet__agent">
            <span className="sheet__agentdot" aria-hidden="true" />
            <div>
              <div className="sheet__agentname">
                @{p.agentHandle} <span className="sheet__agenthandle">{p.status}</span>
              </div>
              <div className="sheet__agentbio">
                {p.skillId}
                {p.clusterKey ? ` - ${p.clusterKey}` : ""}
              </div>
              <div className="field__hint">{reading(p)}</div>
              <div className="field__hint">
                {p.externallyVerified ? copy.verified : copy.unverified}
                {p.sampleSize !== null ? ` - n=${p.sampleSize}` : ""}
                {p.currentDocSha ? ` - sha ${p.currentDocSha.slice(0, 8)}` : ""}
              </div>
              {p.status === "staged" && p.requestId ? (
                <div className="field__row">
                  <button
                    type="button"
                    className="btn btn--small"
                    disabled={busyId !== null}
                    onClick={() => void decide(p, "adopt")}
                  >
                    {busyId === p.id ? copy.working : copy.adopt}
                  </button>
                  <button
                    type="button"
                    className="btn btn--small"
                    disabled={busyId !== null}
                    onClick={() => void decide(p, "reject")}
                  >
                    {copy.reject}
                  </button>
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
