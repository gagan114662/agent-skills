/**
 * The product-true section visuals (#165) that sit beside the numbered story sections — each a small,
 * faithful slice of the console rather than a stock illustration:
 *
 *  - {@link DepartmentChips}  (story 01) — the seven specialists as spectrum-coloured chips.
 *  - {@link MissionControl}   (story 02) — the #147 mission-control strip: live sessions + running spend.
 *  - {@link ApprovalsDrawer}  (story 03) — a staged approvals drawer that flips pending → approved with
 *                                          the confetti micro-burst, then loops.
 *  - {@link MemoryLedger}     (story 04) — the append-only decision log.
 *
 * Every word comes from `brand.ts` and every colour from {@link DEPARTMENT_SPECTRUM} (brand.test scans
 * this file). Animation is gated by {@link usePrefersReducedMotion}: with it on, the drawer shows its
 * approved end-state and nothing moves.
 */
import {
  APPROVALS_VIGNETTE,
  DEPARTMENT_SPECTRUM,
  FLEET,
  MEMORY_LEDGER,
  MISSION_CONTROL,
} from "../../brand.js";
import { usePrefersReducedMotion } from "./useReducedMotion.js";
import { useEffect, useState } from "react";

export function DepartmentChips(): React.JSX.Element {
  return (
    <ul className="vig-chips" aria-label="The department">
      {FLEET.map((agent) => {
        const color = DEPARTMENT_SPECTRUM[agent.department];
        return (
          <li key={agent.handle} className="vig-chip" style={{ ["--dept" as string]: color }}>
            <span className="vig-chip__dot" style={{ background: color }} aria-hidden="true" />
            <span className="vig-chip__name">{agent.name}</span>
            <span className="vig-chip__handle">@{agent.handle}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function MissionControl(): React.JSX.Element {
  return (
    <div className="vig-mission" aria-label={MISSION_CONTROL.title}>
      <div className="vig-mission__head">
        <span className="vig-mission__live">
          <span className="vig-mission__pulse" aria-hidden="true" />
          {MISSION_CONTROL.liveLabel}
        </span>
        <span className="vig-mission__spend">
          <span className="vig-mission__spend-val">{MISSION_CONTROL.spend}</span>{" "}
          <span className="vig-mission__spend-cap">{MISSION_CONTROL.spendCap}</span>
        </span>
      </div>
      <ul className="vig-mission__list">
        {MISSION_CONTROL.sessions.map((s) => {
          const color = DEPARTMENT_SPECTRUM[s.dept];
          return (
            <li key={s.who} className="vig-mission__row">
              <span className="vig-mission__dot" style={{ background: color }} aria-hidden="true" />
              <span className="vig-mission__who" style={{ color }}>
                {s.who}
              </span>
              <span className="vig-mission__task">{s.task}</span>
              <span className="vig-mission__elapsed">{s.elapsed}</span>
            </li>
          );
        })}
      </ul>
      <p className="vig-mission__foot">
        {MISSION_CONTROL.decisionsLabel}: <strong>{MISSION_CONTROL.decisions}</strong>
      </p>
    </div>
  );
}

const FLIP_MS = 2200;

export function ApprovalsDrawer(): React.JSX.Element {
  const reduced = usePrefersReducedMotion();
  // The top item cycles pending → approved → pending… so visitors see the "tap to approve" moment.
  const [approved, setApproved] = useState(reduced);
  useEffect(() => {
    if (reduced) {
      setApproved(true);
      return;
    }
    setApproved(false);
    const id = window.setInterval(() => setApproved((a) => !a), FLIP_MS);
    return () => window.clearInterval(id);
  }, [reduced]);

  return (
    <div className="vig-approvals" aria-label={APPROVALS_VIGNETTE.title}>
      <p className="vig-approvals__sub">{APPROVALS_VIGNETTE.subtitle}</p>
      <ul className="vig-approvals__list">
        {APPROVALS_VIGNETTE.items.map((item, i) => {
          const color = DEPARTMENT_SPECTRUM[item.dept];
          const isApproved = i === 0 && approved;
          return (
            <li
              key={item.id}
              className={`vig-approval${isApproved ? " is-approved" : ""}`}
              style={{ ["--dept" as string]: color }}
            >
              <div className="vig-approval__main">
                <span className="vig-approval__who" style={{ color }}>
                  {item.who}
                </span>
                <span className="vig-approval__what">{item.what}</span>
              </div>
              {isApproved ? (
                <span className="vig-approval__state">
                  {APPROVALS_VIGNETTE.approvedTag}
                  <span className="vig-approval__confetti confetti" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </span>
                </span>
              ) : (
                <span className="vig-approval__actions" aria-hidden="true">
                  <span className="vig-approval__btn vig-approval__btn--no">
                    {APPROVALS_VIGNETTE.rejectLabel}
                  </span>
                  <span className="vig-approval__btn vig-approval__btn--yes">
                    {APPROVALS_VIGNETTE.approveLabel}
                  </span>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function MemoryLedger(): React.JSX.Element {
  return (
    <div className="vig-memory" aria-label={MEMORY_LEDGER.title}>
      <p className="vig-memory__sub">{MEMORY_LEDGER.subtitle}</p>
      <ul className="vig-memory__list">
        {MEMORY_LEDGER.rows.map((row, i) => (
          <li key={i} className="vig-memory__row">
            <span className="vig-memory__time">{row.time}</span>
            <span className="vig-memory__text">{row.text}</span>
            <span
              className={`vig-memory__tag${
                row.tag === APPROVALS_VIGNETTE.approvedTag ? " is-approved" : " is-returned"
              }`}
            >
              {row.tag}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
