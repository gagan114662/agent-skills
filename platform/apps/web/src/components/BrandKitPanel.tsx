/**
 * Settings → Brand kit panel (#271). The owner sets the brand identity ONCE here — name, colours
 * (palette), voice, and an optional logo asset. Mark enforces it server-side and the rest of the fleet
 * draws from it to generate on-brand images; setting it is also what flips the founder-console brand
 * proof tile to connected (#253). All copy comes from {@link BRAND_KIT} so this chrome carries no
 * hardcoded brand strings (enforced by brand.test.ts).
 */
import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import type { BrandKitState } from "../api/types.js";
import { BRAND_KIT } from "../brand.js";

export function BrandKitPanel(): React.JSX.Element {
  const [state, setState] = useState<BrandKitState | null>(null);
  const [name, setName] = useState("");
  const [palette, setPalette] = useState<string[]>([""]);
  const [voice, setVoice] = useState("");
  const [logoAssetId, setLogoAssetId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    void api
      .getBrandKit()
      .then((s) => {
        if (!live) return;
        setState(s);
        if (s.brandKit) {
          setName(s.brandKit.name);
          setPalette(s.brandKit.palette.length > 0 ? s.brandKit.palette : [""]);
          setVoice(s.brandKit.voice);
          setLogoAssetId(s.brandKit.logoAssetId ?? "");
        }
      })
      .catch(() => live && setState({ connected: false, brandKit: null }));
    return () => {
      live = false;
    };
  }, []);

  function setColor(i: number, value: string): void {
    setPalette((prev) => prev.map((c, idx) => (idx === i ? value : c)));
  }

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await api.setBrandKit({
        name,
        palette: palette.map((c) => c.trim()).filter((c) => c.length > 0),
        voice,
        logoAssetId: logoAssetId.trim() || null,
      });
      setState(next);
      setSaved(true);
    } catch {
      setError(BRAND_KIT.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="workspace__panel brand-kit-panel">
      <header className="brand-kit-panel__head">
        <h2>{BRAND_KIT.title}</h2>
        <span className={`brand-kit-panel__badge brand-kit-panel__badge--${state?.connected ? "on" : "off"}`}>
          {state?.connected ? BRAND_KIT.connectedBadge : BRAND_KIT.unsetBadge}
          {state?.connected && typeof state.assetCount === "number"
            ? ` · ${BRAND_KIT.assetCount(state.assetCount)}`
            : ""}
        </span>
      </header>
      <p className="brand-kit-panel__hint">{BRAND_KIT.hint}</p>

      <label className="brand-kit-panel__field">
        <span>{BRAND_KIT.nameLabel}</span>
        <input value={name} placeholder={BRAND_KIT.namePlaceholder} onChange={(e) => setName(e.target.value)} />
      </label>

      <fieldset className="brand-kit-panel__palette">
        <legend>{BRAND_KIT.paletteLabel}</legend>
        <p className="brand-kit-panel__hint">{BRAND_KIT.paletteHint}</p>
        {palette.map((color, i) => (
          <div key={i} className="brand-kit-panel__color">
            <input
              aria-label={`${BRAND_KIT.paletteLabel} ${i + 1}`}
              value={color}
              placeholder="#1a73e8"
              onChange={(e) => setColor(i, e.target.value)}
            />
            <span
              className="brand-kit-panel__swatch"
              style={{ background: /^#[0-9a-f]{6}$/i.test(color.trim()) ? color.trim() : "transparent" }}
            />
            {palette.length > 1 && (
              <button
                type="button"
                onClick={() => setPalette((prev) => prev.filter((_, idx) => idx !== i))}
              >
                {BRAND_KIT.removeColor}
              </button>
            )}
          </div>
        ))}
        <button type="button" onClick={() => setPalette((prev) => [...prev, ""])}>
          {BRAND_KIT.addColor}
        </button>
      </fieldset>

      <label className="brand-kit-panel__field">
        <span>{BRAND_KIT.voiceLabel}</span>
        <textarea value={voice} placeholder={BRAND_KIT.voicePlaceholder} onChange={(e) => setVoice(e.target.value)} />
      </label>

      <label className="brand-kit-panel__field">
        <span>{BRAND_KIT.logoLabel}</span>
        <input value={logoAssetId} placeholder={BRAND_KIT.logoPlaceholder} onChange={(e) => setLogoAssetId(e.target.value)} />
      </label>

      {error && <p className="brand-kit-panel__error">{error}</p>}
      {saved && !error && <p className="brand-kit-panel__saved">{BRAND_KIT.saved}</p>}

      <button type="button" className="brand-kit-panel__save" disabled={busy} onClick={() => void save()}>
        {busy ? BRAND_KIT.saving : BRAND_KIT.save}
      </button>
    </div>
  );
}
