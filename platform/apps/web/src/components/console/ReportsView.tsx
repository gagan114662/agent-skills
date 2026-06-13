/**
 * The Reports view: the daily brief, the calls that need you (one-tap dispatch through the real #13
 * gate), and the weekly numbers. Built on the live Founder Console roll-up (#104) — the closest real
 * seam to a daily brief — so every number is true. Approving a handover calls the parent, which decides
 * through `store.decideApprove` (gate intact). Presentational + deterministic for tests.
 */
import type { FounderConsoleDto } from "../../api/types.js";
import { CONSOLE, VOICE } from "../../brand.js";
import { PopLoader } from "../PopLoader.js";
import { fmtCents } from "./model.js";

export interface ReportsViewProps {
  console: FounderConsoleDto | null;
  onApprove: (id: string, e: React.MouseEvent) => void;
  onPeekBrief: () => void;
  decidingId: string | null;
}

export function ReportsView({ console: data, onApprove, onPeekBrief, decidingId }: ReportsViewProps): React.JSX.Element {
  if (!data) {
    return (
      <div className="reports">
        <PopLoader label={VOICE.loading} />
      </div>
    );
  }

  const { fleet, budget, revenue, venturePipeline, pendingApprovals, attention } = data;
  const brief = attention.required
    ? attention.reasons.join(" · ")
    : `${fleet.activeSessions} in motion · ${pendingApprovals.length} waiting · ${fmtCents(budget.estimatedCostCents)} spent this window`;

  return (
    <div className="reports">
      <section className="reports__col">
        <header className="board__colh">
          <span className="board__colt">{CONSOLE.reports.overnightTitle}</span>
        </header>

        <article className="card reports__brief" style={{ ["--hue" as string]: "var(--dept-brand)" } as React.CSSProperties} onClick={onPeekBrief}>
          <div className="card__ttl">{CONSOLE.reports.briefTitle}</div>
          <div className="card__meta">{brief}</div>
        </article>

        <header className="board__colh">
          <span className="board__colt">{CONSOLE.reports.handoversTitle}</span>
          <span className="board__coln">{pendingApprovals.length}</span>
        </header>

        {pendingApprovals.length === 0 ? (
          <div className="board__clear" role="status">
            <b>{CONSOLE.reports.handoverEmpty}</b>
          </div>
        ) : (
          pendingApprovals.map((a) => (
            <article key={a.id} className="card card--need" style={{ ["--hue" as string]: "var(--accent)" } as React.CSSProperties}>
              <div className="card__ttl">{a.summary}</div>
              <div className="card__meta">
                {a.actionType}
                {a.amount != null && <span className="card__amount"> · {fmtCents(a.amount)}</span>}
              </div>
              <div className="card__actions">
                <button className="btn" disabled={decidingId === a.id} onClick={(e) => onApprove(a.id, e)}>
                  {CONSOLE.reports.handoverDispatch}
                </button>
              </div>
            </article>
          ))
        )}

        <header className="board__colh">
          <span className="board__colt">{CONSOLE.reports.plTitle}</span>
        </header>
        <article className="card" style={{ ["--hue" as string]: "var(--dept-analytics)" } as React.CSSProperties}>
          <div className="reports__pl">
            <div>
              <dt>Revenue</dt>
              <dd>{fmtCents(revenue.totalCents)}</dd>
            </div>
            <div>
              <dt>Payments</dt>
              <dd>{revenue.paymentCount}</dd>
            </div>
            <div>
              <dt>Funded</dt>
              <dd>{venturePipeline.funded}</dd>
            </div>
            <div>
              <dt>Killed</dt>
              <dd>{venturePipeline.killed}</dd>
            </div>
            <div>
              <dt>Spent</dt>
              <dd>
                {fmtCents(budget.estimatedCostCents)}
                {budget.budgetCents > 0 && <> / {fmtCents(budget.budgetCents)}</>}
              </dd>
            </div>
          </div>
        </article>
      </section>
    </div>
  );
}
