/**
 * The owner BRIEF composer (#235) — the working control that lights up the board.
 *
 * The board used to sit passive ("the team is between tasks — @mention a lead to kick off the next piece of
 * work") with no input anywhere, so nothing ever got pointed at a goal. This is that input: pick a
 * department lead, hand them a goal ("get us our first paying customers"), and the fleet opens a REAL,
 * approval-gated task — a session spawns and the "Work in progress" lane fills. It only renders + raises
 * intent: the actual launch (and every gate behind it — #68 auth → #59 RBAC → #96 venture → #71 admission)
 * lives on the server. Nothing leaves the building without the owner's yes; the briefed agents carry only
 * draft tools, so a brief can never itself send/post/spend.
 *
 * Every word comes from `brand.ts` (the console-chrome brand-cleanliness rule).
 */
import { useState } from "react";
import {
  CONSOLE,
  agentColor,
  consoleBriefLaunched,
  consoleBriefConnect,
  type ConsoleBriefLead,
} from "../../brand.js";

/** What a brief did: a session launched, a connect-prompt was posted, or it failed. */
export type BriefOutcomeKind = "launched" | "connect" | "error";

export interface BriefComposerProps {
  leads: readonly ConsoleBriefLead[];
  /** Post the brief + launch the lead; resolves to the outcome kind. Must not throw. */
  onBrief: (lead: string, goal: string) => Promise<BriefOutcomeKind>;
}

export function BriefComposer({ leads, onBrief }: BriefComposerProps): React.JSX.Element {
  const [leadHandle, setLeadHandle] = useState(leads[0]?.handle ?? "");
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [needGoal, setNeedGoal] = useState(false);
  const [outcome, setOutcome] = useState<{ kind: BriefOutcomeKind; name: string } | null>(null);

  const selected = leads.find((l) => l.handle === leadHandle) ?? leads[0];

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (busy || !selected) return;
    const trimmed = goal.trim();
    if (!trimmed) {
      setNeedGoal(true);
      return;
    }
    setNeedGoal(false);
    setBusy(true);
    setOutcome(null);
    const kind = await onBrief(selected.handle, trimmed);
    setBusy(false);
    setOutcome({ kind, name: selected.name });
    if (kind !== "error") setGoal("");
  }

  return (
    <form className="brief" onSubmit={submit}>
      <div className="brief__head">
        <span className="brief__eyebrow">{CONSOLE.brief.eyebrow}</span>
        <b className="brief__title">{CONSOLE.brief.title}</b>
        <span className="brief__sub">{CONSOLE.brief.sub}</span>
      </div>

      <div className="brief__leads" role="radiogroup" aria-label={CONSOLE.brief.leadLabel}>
        {leads.map((l) => {
          const on = l.handle === leadHandle;
          return (
            <button
              type="button"
              key={l.handle}
              role="radio"
              aria-checked={on}
              className={`brief__lead${on ? " brief__lead--on" : ""}`}
              style={{ ["--hue" as string]: agentColor(l.name) ?? "var(--line)" } as React.CSSProperties}
              onClick={() => setLeadHandle(l.handle)}
            >
              <b className="brief__leadn">{l.name}</b>
              <span className="brief__leadd">{l.dept}</span>
              <span className="brief__leadb">{l.blurb}</span>
            </button>
          );
        })}
      </div>

      <div className="brief__row">
        <textarea
          className="brief__goal"
          value={goal}
          rows={2}
          placeholder={CONSOLE.brief.placeholder}
          aria-label={CONSOLE.brief.title}
          onChange={(e) => {
            setGoal(e.target.value);
            if (needGoal) setNeedGoal(false);
          }}
        />
        <button type="submit" className="brief__send" disabled={busy}>
          {busy ? CONSOLE.brief.submitting : CONSOLE.brief.submit}
        </button>
      </div>

      {needGoal && (
        <p className="brief__hint" role="alert">
          {CONSOLE.brief.goalRequired}
        </p>
      )}
      {outcome && (
        <p className={`brief__outcome brief__outcome--${outcome.kind}`} role="status">
          {outcome.kind === "launched" && consoleBriefLaunched(outcome.name)}
          {outcome.kind === "connect" && consoleBriefConnect(outcome.name)}
          {outcome.kind === "error" && CONSOLE.brief.error}
        </p>
      )}
    </form>
  );
}
