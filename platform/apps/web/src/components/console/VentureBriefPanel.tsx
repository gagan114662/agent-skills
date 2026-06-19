/**
 * Brief a venture (#387, ADR-0387) — the owner-facing surface that runs ANY company idea through the
 * already-built #96 venture loop (not just marketing). Five fields (idea, one-line pitch, target customer,
 * problem, why-now) map to the loop's product-agnostic `IdeaInput`; on submit they POST to the live
 * `POST /workspaces/:wid/ventures` via {@link api.submitVenture}.
 *
 * Gating: this panel mounts only when the default-OFF, owner-workspace-first `ventureIntake` web flag
 * resolves on for the workspace (see `venture-intake-flag.ts`), AND the server route itself is gated behind
 * its own default-OFF flag (409 when off) — fail-closed on both sides. With the flag unset (default / prod)
 * the panel never renders, so the console is byte-for-byte unchanged.
 *
 * #200: the typed fields are untrusted owner input — they are sent only as JSON DATA to the submit route
 * and rendered back as plain text (no markup execution). Submitting only SOURCES + scores the idea; the
 * funded build work still flows through the existing money/approval (#13) gates.
 *
 * Every word comes from `brand.ts` (the console-chrome brand-cleanliness rule).
 */
import { useState } from "react";
import { api } from "../../api/client.js";
import type { VentureIdeaDto } from "../../api/types.js";
import { CONSOLE } from "../../brand.js";

const COPY = CONSOLE.ventureBrief;

/** The five form fields, in display order. Keyed so the mapped output stays declarative + testable. */
const FIELDS = [
  { key: "name", multiline: false },
  { key: "pitch", multiline: false },
  { key: "targetUser", multiline: false },
  { key: "problem", multiline: true },
  { key: "whyNow", multiline: true },
] as const;

type FieldKey = (typeof FIELDS)[number]["key"];
type FormState = Record<FieldKey, string>;

const EMPTY_FORM: FormState = { name: "", pitch: "", targetUser: "", problem: "", whyNow: "" };

export interface VentureBriefPanelProps {
  /** The current workspace id (the brief targets `/workspaces/:wid/ventures`). */
  workspaceId: string;
}

export function VentureBriefPanel({ workspaceId }: VentureBriefPanelProps): React.JSX.Element {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<VentureIdeaDto | null>(null);

  function update(key: FieldKey, value: string): void {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (error) setError(null);
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    const trimmed: FormState = {
      name: form.name.trim(),
      pitch: form.pitch.trim(),
      targetUser: form.targetUser.trim(),
      problem: form.problem.trim(),
      whyNow: form.whyNow.trim(),
    };
    if (Object.values(trimmed).some((v) => v === "")) {
      setError(COPY.required);
      return;
    }
    setBusy(true);
    setError(null);
    setCreated(null);
    try {
      // Map the five owner-facing fields onto the venture loop's product-agnostic IdeaInput. The idea name
      // + one-line pitch together form the loop's "insight"; the rest map directly. `marketPath` carries the
      // wedge ("why now") since that is the go-to-market motion the loop reasons over.
      const idea = await api.submitVenture(workspaceId, {
        problem: trimmed.problem,
        targetUser: trimmed.targetUser,
        insight: `${trimmed.name} — ${trimmed.pitch}`,
        wedge: trimmed.pitch,
        marketPath: trimmed.whyNow,
      });
      setCreated(idea);
      setForm(EMPTY_FORM);
    } catch {
      setError(COPY.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="venturebrief" onSubmit={submit}>
      <div className="venturebrief__head">
        <span className="venturebrief__eyebrow">{COPY.eyebrow}</span>
        <b className="venturebrief__title">{COPY.title}</b>
        <span className="venturebrief__sub">{COPY.sub}</span>
      </div>

      {FIELDS.map(({ key, multiline }) => {
        const field = COPY.fields[key];
        const inputId = `venturebrief-${key}`;
        return (
          <label className="venturebrief__field" key={key} htmlFor={inputId}>
            <span className="venturebrief__label">{field.label}</span>
            {multiline ? (
              <textarea
                id={inputId}
                className="venturebrief__input"
                rows={2}
                value={form[key]}
                placeholder={field.placeholder}
                onChange={(e) => update(key, e.target.value)}
              />
            ) : (
              <input
                id={inputId}
                className="venturebrief__input"
                type="text"
                value={form[key]}
                placeholder={field.placeholder}
                onChange={(e) => update(key, e.target.value)}
              />
            )}
          </label>
        );
      })}

      <button type="submit" className="venturebrief__send" disabled={busy}>
        {busy ? COPY.submitting : COPY.submit}
      </button>

      {error && (
        <p className="venturebrief__hint" role="alert">
          {error}
        </p>
      )}
      {created && (
        <p className="venturebrief__outcome" role="status">
          {COPY.successPrefix} {created.id} ({created.status})
        </p>
      )}
    </form>
  );
}
