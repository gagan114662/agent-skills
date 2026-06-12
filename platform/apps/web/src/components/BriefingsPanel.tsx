/**
 * Founder Briefings pane (#173) — the company's report to its owner, rendered in the Founder Console.
 * Three sections: the **daily brief** (brand-voice text + spend), the unified **decision queue**
 * (approvals + #172 escalations + #146 constitution flags, ordered by impact then age, with escalation
 * badges), and the **weekly founder report** (per-venture P&L + kill/scale recommendations + next-week
 * backlog). Presentational: it takes the three DTOs (fetched via `api.getFounderBriefing*`) so it renders
 * deterministically and is unit-tested without a store or network. It NEVER mutates — acting on a
 * decision happens on its own surface via the item's one-tap link.
 */
import type { DailyBriefDto, DecisionQueueDto, WeeklyReportDto } from "../api/types.js";
import { EmptyState } from "./EmptyState.js";

function dollars(cents: number | null): string {
  return cents === null ? "—" : `$${(cents / 100).toFixed(2)}`;
}

function age(seconds: number): string {
  if (seconds >= 86_400) return `${Math.floor(seconds / 86_400)}d`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
  return `${seconds}s`;
}

/** Level 0 fresh → no badge; 1–3 escalate the visual urgency. */
const ESCALATION_LABEL = ["", "aging", "stale", "critical"] as const;

export interface BriefingsPanelProps {
  daily: DailyBriefDto | null;
  decisionQueue: DecisionQueueDto | null;
  weekly: WeeklyReportDto | null;
}

export function BriefingsPanel({ daily, decisionQueue, weekly }: BriefingsPanelProps): React.JSX.Element {
  return (
    <section className="briefings" aria-label="Founder briefings">
      <header className="briefings__head">Founder Briefings</header>

      {/* Daily brief — the brand-voice summary the owner gets each morning. */}
      <article className="briefings__daily" aria-label="Daily brief">
        <h3>Daily brief</h3>
        {daily ? (
          <>
            <p className="briefings__text">{daily.text}</p>
            <p className="briefings__spend">
              Spend {dollars(daily.spend.estimatedCostCents)}
              {daily.spend.budgetCents > 0 ? ` / ${dollars(daily.spend.budgetCents)}` : ""}
              {daily.spend.overBudget ? " · over budget" : ""}
            </p>
          </>
        ) : (
          <EmptyState>The daily brief renders once briefings are wired.</EmptyState>
        )}
      </article>

      {/* The ONE decision queue — anything requiring the owner, ordered, never silently rotting. */}
      <article className="briefings__decisions" aria-label="Decision queue">
        <h3>Decisions waiting{decisionQueue && decisionQueue.total > 0 ? ` (${decisionQueue.total})` : ""}</h3>
        {decisionQueue && decisionQueue.total > 0 ? (
          <ul className="briefings__queue">
            {decisionQueue.items.map((d) => (
              <li key={d.id} className={`briefings__item briefings__item--${d.impact}`}>
                <span className="briefings__kind">{d.kind.replace(/_/g, " ")}</span>
                <span className="briefings__title">
                  {d.link ? <a href={d.link}>{d.title}</a> : d.title}
                </span>
                <span className="briefings__age">{age(d.ageSeconds)}</span>
                {d.escalationLevel > 0 ? (
                  <span className={`briefings__badge briefings__badge--${d.escalationLevel}`}>
                    {ESCALATION_LABEL[d.escalationLevel]}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>No approvals, escalations, or flags need you.</EmptyState>
        )}
      </article>

      {/* Weekly founder report — per-venture P&L + recommendations + next week. */}
      <article className="briefings__weekly" aria-label="Weekly founder report">
        <h3>Weekly report</h3>
        {weekly ? (
          <>
            <p className="briefings__text">{weekly.text}</p>
            {weekly.ventures.length > 0 ? (
              <table className="briefings__pnl">
                <thead>
                  <tr>
                    <th>Venture</th>
                    <th>Decision</th>
                    <th>Score Δ</th>
                    <th>Revenue</th>
                    <th>Cost</th>
                    <th>Net</th>
                    <th>Margin</th>
                  </tr>
                </thead>
                <tbody>
                  {weekly.ventures.map((v) => (
                    <tr key={v.ideaId}>
                      <td>{v.ideaId}</td>
                      <td>{v.decision ?? "—"}</td>
                      <td>{v.scoreDelta === null ? "—" : `${v.scoreDelta > 0 ? "+" : ""}${v.scoreDelta}`}</td>
                      <td>{dollars(v.revenueCents)}</td>
                      <td>{dollars(v.costCents)}</td>
                      <td>{dollars(v.netCents)}</td>
                      <td>{v.marginPct === null ? "—" : `${v.marginPct.toFixed(0)}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="briefings__muted">No ventures to report yet.</p>
            )}
            {weekly.backlog.length > 0 ? (
              <p className="briefings__backlog">
                Next week: {weekly.backlog.map((b) => b.title).join(", ")}
              </p>
            ) : null}
          </>
        ) : (
          <EmptyState>The weekly report renders once briefings are wired.</EmptyState>
        )}
      </article>
    </section>
  );
}
