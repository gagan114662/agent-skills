/**
 * Settings → "What are we marketing?" panel (#502). The owner points the fleet at a marketing TARGET — the
 * workspace's own product OR any external app/URL — and captures the brief (name, URL, one-line positioning,
 * target customer, competitors). This is the single source of truth: once saved, every briefed agent's task
 * is enriched with it server-side so the department markets THAT product instead of inferring ipop.
 *
 * The panel previews the exact brief the agents read (`state.preamble`) so what-you-see is what-they-get. All
 * copy comes from {@link MARKETING_TARGET} so this chrome carries no hardcoded brand strings (brand.test.ts).
 */
import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import type { MarketingTargetState } from "../api/types.js";
import { MARKETING_TARGET } from "../brand.js";

export function MarketingTargetPanel(): React.JSX.Element {
  const [state, setState] = useState<MarketingTargetState | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [positioning, setPositioning] = useState("");
  const [audience, setAudience] = useState("");
  const [competitors, setCompetitors] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    void api
      .getMarketingTarget()
      .then((s) => {
        if (!live) return;
        setState(s);
        setName(s.target.name ?? "");
        setUrl(s.target.url ?? "");
        setPositioning(s.target.positioning ?? "");
        setAudience(s.target.audience ?? "");
        setCompetitors(s.target.competitors ?? "");
      })
      .catch(() => live && setState({ configured: false, target: { name: null, url: null, positioning: null, audience: null, competitors: null }, preamble: null }));
    return () => {
      live = false;
    };
  }, []);

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await api.setMarketingTarget({
        name: name.trim(),
        url: url.trim(),
        positioning: positioning.trim(),
        audience: audience.trim(),
        competitors: competitors.trim(),
      });
      setState(next);
      setSaved(true);
    } catch {
      setError(MARKETING_TARGET.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="workspace__panel marketing-target-panel">
      <header className="marketing-target-panel__head">
        <h2>{MARKETING_TARGET.title}</h2>
        <span
          className={`marketing-target-panel__badge marketing-target-panel__badge--${state?.configured ? "on" : "off"}`}
        >
          {state?.configured ? MARKETING_TARGET.configuredBadge : MARKETING_TARGET.unsetBadge}
        </span>
      </header>
      <p className="marketing-target-panel__hint">{MARKETING_TARGET.hint}</p>

      <label className="marketing-target-panel__field">
        <span>{MARKETING_TARGET.nameLabel}</span>
        <input value={name} placeholder={MARKETING_TARGET.namePlaceholder} onChange={(e) => setName(e.target.value)} />
      </label>

      <label className="marketing-target-panel__field">
        <span>{MARKETING_TARGET.urlLabel}</span>
        <input
          value={url}
          placeholder={MARKETING_TARGET.urlPlaceholder}
          autoComplete="url"
          inputMode="url"
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>

      <label className="marketing-target-panel__field">
        <span>{MARKETING_TARGET.positioningLabel}</span>
        <input
          value={positioning}
          placeholder={MARKETING_TARGET.positioningPlaceholder}
          onChange={(e) => setPositioning(e.target.value)}
        />
      </label>

      <label className="marketing-target-panel__field">
        <span>{MARKETING_TARGET.audienceLabel}</span>
        <textarea
          value={audience}
          placeholder={MARKETING_TARGET.audiencePlaceholder}
          onChange={(e) => setAudience(e.target.value)}
        />
      </label>

      <label className="marketing-target-panel__field">
        <span>{MARKETING_TARGET.competitorsLabel}</span>
        <input
          value={competitors}
          placeholder={MARKETING_TARGET.competitorsPlaceholder}
          onChange={(e) => setCompetitors(e.target.value)}
        />
      </label>

      <section className="marketing-target-panel__preview" aria-label={MARKETING_TARGET.previewLabel}>
        <h3>{MARKETING_TARGET.previewLabel}</h3>
        {state?.preamble ? (
          <pre className="marketing-target-panel__brief">{state.preamble}</pre>
        ) : (
          <p className="marketing-target-panel__brief-empty">{MARKETING_TARGET.previewEmpty}</p>
        )}
      </section>

      {error && <p className="marketing-target-panel__error">{error}</p>}
      {saved && !error && <p className="marketing-target-panel__saved">{MARKETING_TARGET.saved}</p>}

      <button type="button" className="marketing-target-panel__save" disabled={busy} onClick={() => void save()}>
        {busy ? MARKETING_TARGET.saving : MARKETING_TARGET.save}
      </button>
    </div>
  );
}
