/** Workspace approval policies (#13): which action types pause for a human, and the spend threshold
 * (`maxAutoAmount`) under which they auto-execute. List is visible to all members; add/remove is
 * human-only (mirrors the server `requireHuman`; the server still enforces it — see ADR-0026). */
import { useState } from "react";
import type { ApprovalActionType } from "@reload/shared";
import { useAppState, useStore } from "../../store/StoreContext.js";

const ACTION_TYPES: ApprovalActionType[] = ["chat.post_message", "external.send"];

export function PolicyManager(): React.JSX.Element {
  const { identity, approvals } = useAppState();
  const store = useStore();
  const [actionType, setActionType] = useState<ApprovalActionType>("external.send");
  const [threshold, setThreshold] = useState("");
  const [busy, setBusy] = useState(false);

  const isHuman = identity?.kind === "human";

  async function add(): Promise<void> {
    setBusy(true);
    const maxAutoAmount = threshold.trim() === "" ? null : Number(threshold);
    await store.addPolicy({ actionType, requireApproval: true, maxAutoAmount });
    setBusy(false);
    setThreshold("");
  }

  return (
    <div className="policy-manager">
      <h3>Approval policies</h3>
      {approvals.error && (
        <p className="review-queue__error" role="alert">
          {approvals.error}
        </p>
      )}

      {approvals.policies.length === 0 ? (
        <p className="review-queue__empty">
          No custom policy rules — external sends still require approval by default; other actions
          auto-execute. Add a rule below to change this.
        </p>
      ) : (
        <ul className="policy-list">
          {approvals.policies.map((p) => (
            <li key={p.id} className="policy-row">
              <span className="policy-row__action">{p.actionType}</span>
              <span className="policy-row__rule">
                {p.requireApproval ? "requires approval" : "auto"}
                {p.maxAutoAmount !== null && ` over $${p.maxAutoAmount}`}
              </span>
              {isHuman && (
                <button
                  className="btn btn--danger btn--small"
                  aria-label={`Remove policy for ${p.actionType}`}
                  onClick={() => void store.removePolicy(p.id)}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {isHuman ? (
        <form
          className="policy-form"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <label>
            Action type
            <select value={actionType} onChange={(e) => setActionType(e.target.value as ApprovalActionType)}>
              {ACTION_TYPES.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
          <label>
            Auto-approve under (spend threshold)
            <input
              type="number"
              min="0"
              placeholder="always require"
              aria-label="Spend threshold"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
            />
          </label>
          <button type="submit" className="btn btn--primary" disabled={busy}>
            Add rule
          </button>
        </form>
      ) : (
        <p className="policy-manager__note">Only human members can manage policies.</p>
      )}
    </div>
  );
}
