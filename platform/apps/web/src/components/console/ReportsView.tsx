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

  const {
    fleet,
    budget,
    revenue,
    venturePipeline,
    pendingApprovals,
    attention,
    growth,
    discoveryPipeline,
    outreach,
    attribution,
    proofScorecard,
  } = data;
  const stageLabel = (stage: string): string =>
    stage.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const compactLabel = (value: string): string =>
    value.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const trendGlyph = (trend: string): string =>
    trend === "up" ? "▲" : trend === "down" ? "▼" : trend === "flat" ? "▬" : "";
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

        {proofScorecard && (
          <>
            <header className="board__colh">
              <span className="board__colt">{CONSOLE.reports.proofTitle}</span>
              <span className="board__coln">
                {proofScorecard.connectedCount}/{proofScorecard.total} connected
              </span>
            </header>
            <div className="reports__proof">
              {proofScorecard.tiles.map((t) => (
                <article
                  key={t.department}
                  className={`card proof-tile proof-tile--${t.connection}`}
                  style={{ ["--hue" as string]: `var(--dept-${t.department})` } as React.CSSProperties}
                >
                  <div className="proof-tile__dept">
                    {t.agent} · {t.title}
                  </div>
                  <div className="proof-tile__metric">{t.metricLabel}</div>
                  <div className="proof-tile__value">{t.display}</div>
                  {t.trend !== "none" && (
                    <div
                      className={`proof-tile__trend proof-tile__trend--${
                        t.improving === null ? "flat" : t.improving ? "up" : "down"
                      }`}
                    >
                      {trendGlyph(t.trend)} {t.trendDetail}
                    </div>
                  )}
                  <div className="proof-tile__source">
                    {t.source}
                    {t.note ? ` · ${t.note}` : ""}
                  </div>
                </article>
              ))}
            </div>
          </>
        )}

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

        {growth && (
          <>
            <header className="board__colh">
              <span className="board__colt">Growth</span>
            </header>
            <article className="card" style={{ ["--hue" as string]: "var(--dept-analytics)" } as React.CSSProperties}>
              <div className="reports__pl">
                <div>
                  <dt>Acquisition</dt>
                  <dd>{growth.acquisition}</dd>
                </div>
                <div>
                  <dt>Activation</dt>
                  <dd>{growth.activation}</dd>
                </div>
                <div>
                  <dt>Conversion</dt>
                  <dd>{growth.conversion}</dd>
                </div>
                <div>
                  <dt>Score</dt>
                  <dd>{growth.score}</dd>
                </div>
              </div>
            </article>
          </>
        )}

        {attribution && (
          <>
            <header className="board__colh">
              <span className="board__colt">Attributed revenue</span>
              <span className="board__coln">{attribution.attributedPaymentCount} payments</span>
            </header>
            <article className="card" style={{ ["--hue" as string]: "var(--dept-analytics)" } as React.CSSProperties}>
              <div className="reports__pl">
                <div>
                  <dt>Attributed</dt>
                  <dd>{fmtCents(attribution.totalAttributedCents)}</dd>
                </div>
                <div>
                  <dt>Unattributed</dt>
                  <dd>{attribution.unattributedPaymentCount}</dd>
                </div>
              </div>
              {attribution.topArtifacts.length === 0 ? (
                <div className="reports__empty" role="status">
                  No attributed payments yet
                </div>
              ) : (
                <div className="reports__artifact-list">
                  {attribution.topArtifacts.map((artifact) => (
                    <div
                      key={artifact.artifactId + ":" + artifact.currency}
                      className="reports__artifact-row"
                    >
                      <span>
                        {compactLabel(artifact.artifactKind)} · {compactLabel(artifact.channel)}
                      </span>
                      <strong>{fmtCents(artifact.attributedCents)}</strong>
                      <small>
                        {artifact.paymentCount} payments · {artifact.artifactId}
                      </small>
                    </div>
                  ))}
                </div>
              )}
            </article>
          </>
        )}

        {discoveryPipeline && (
          <>
            <header className="board__colh">
              <span className="board__colt">Discovery pipeline</span>
              <span className="board__coln">{discoveryPipeline.pqlCount} PQL</span>
            </header>
            <article className="card" style={{ ["--hue" as string]: "var(--dept-brand)" } as React.CSSProperties}>
              <div className="reports__pl">
                {discoveryPipeline.stages.map((s) => (
                  <div key={s.stage}>
                    <dt>{stageLabel(s.stage)}</dt>
                    <dd>{s.prospects}</dd>
                  </div>
                ))}
              </div>
            </article>
          </>
        )}

        {outreach && (
          <>
            <header className="board__colh">
              <span className="board__colt">Outreach</span>
              <span className="board__coln">{outreach.experimentsRunning} experiments</span>
            </header>
            <article className="card" style={{ ["--hue" as string]: "var(--dept-brand)" } as React.CSSProperties}>
              <div className="reports__pl">
                <div>
                  <dt>Awaiting approval</dt>
                  <dd>{outreach.messagesPendingApproval}</dd>
                </div>
                <div>
                  <dt>Sent</dt>
                  <dd>{outreach.messagesSent}</dd>
                </div>
                <div>
                  <dt>Replies</dt>
                  <dd>{outreach.replies}</dd>
                </div>
                <div>
                  <dt>Meetings</dt>
                  <dd>{outreach.meetings}</dd>
                </div>
                <div>
                  <dt>Signups</dt>
                  <dd>{outreach.signups}</dd>
                </div>
              </div>
            </article>
          </>
        )}
      </section>
    </div>
  );
}
