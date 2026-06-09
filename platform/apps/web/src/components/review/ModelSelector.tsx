/**
 * Model / provider / effort / Auto selection control (#52).
 *
 * A small, fully-controlled presentational widget: it collects a {@link ModelSelection} (provider,
 * model, effort tier, and single-vs-Auto mode) that a session-launch flow passes to
 * `api.review.launchSession`. It holds no state and talks to no store, so it drops into any launch
 * surface and is trivial to test. The server validates the choice against the tenant's policy and
 * rejects a disallowed selection with a 400 — this widget only gathers intent.
 */
import type { AgentSessionSummary, EffortLevel, ModelSelection, ProviderKind, SessionMode } from "../../api/types.js";

const PROVIDERS: ProviderKind[] = ["anthropic", "openai", "bedrock", "vertex", "custom"];
const EFFORTS: EffortLevel[] = ["off", "low", "medium", "high"];

/** A sensible default selection for a fresh launch form (single-mode Anthropic, no thinking budget). */
export const DEFAULT_SELECTION: ModelSelection = {
  provider: "anthropic",
  model: "",
  effort: "off",
  mode: "single",
};

export function ModelSelector({
  value,
  onChange,
}: {
  value: ModelSelection;
  onChange: (next: ModelSelection) => void;
}): React.JSX.Element {
  const auto = value.mode === "auto";
  return (
    <div className="modelsel" role="group" aria-label="Model selection">
      <label className="modelsel__field">
        <span>Provider</span>
        <select
          aria-label="Provider"
          value={value.provider}
          onChange={(e) => onChange({ ...value, provider: e.target.value as ProviderKind })}
        >
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>

      <label className="modelsel__field">
        <span>Model</span>
        <input
          aria-label="Model"
          placeholder={auto ? "(Auto: set by policy)" : "claude-sonnet-4-6"}
          value={value.model}
          disabled={auto}
          onChange={(e) => onChange({ ...value, model: e.target.value })}
        />
      </label>

      <label className="modelsel__field">
        <span>Effort</span>
        <select
          aria-label="Effort"
          value={value.effort}
          onChange={(e) => onChange({ ...value, effort: e.target.value as EffortLevel })}
        >
          {EFFORTS.map((eff) => (
            <option key={eff} value={eff}>
              {eff}
            </option>
          ))}
        </select>
      </label>

      <label className="modelsel__auto">
        <input
          type="checkbox"
          aria-label="Auto mode"
          checked={auto}
          onChange={(e) => onChange({ ...value, mode: (e.target.checked ? "auto" : "single") as SessionMode })}
        />
        <span>Auto (Opus plans → Sonnet implements)</span>
      </label>
    </div>
  );
}

/** A compact read-only badge showing the selection a session ran with (null fields are omitted). */
export function ModelBadge({ session }: { session: AgentSessionSummary }): React.JSX.Element | null {
  if (!session.provider && !session.model && !session.mode) return null;
  const parts = [session.provider, session.model].filter(Boolean);
  return (
    <span className="modelsel__badge" title="Model / provider selection">
      {parts.join(" · ")}
      {session.mode === "auto" ? " · auto" : ""}
      {session.effort && session.effort !== "off" ? ` · ${session.effort}` : ""}
    </span>
  );
}
