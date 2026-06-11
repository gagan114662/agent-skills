/**
 * The `/brand` assets page (#153): the pop marks, wordmark, palette, and voice — the public face of the
 * brand book (docs/brand/ipop-brand-identity.html). All copy + colours come from `brand.ts` so the page
 * carries no hardcoded brand strings (brand.test scans this directory).
 */
import { BRAND_ASSETS, DEPARTMENT_SPECTRUM, FLEET } from "../../brand.js";
import { Wordmark } from "../Wordmark.js";
import { PopMark } from "../PopMark.js";

export function Brand(): React.JSX.Element {
  return (
    <article className="site-page brand-page">
      <header className="site-page__head">
        <p className="site-page__eyebrow">{BRAND_ASSETS.eyebrow}</p>
        <h1 className="site-page__title">{BRAND_ASSETS.title}</h1>
        <p className="site-page__sub">{BRAND_ASSETS.sub}</p>
      </header>

      <section className="brand-block">
        <h2 className="brand-block__title">{BRAND_ASSETS.markTitle}</h2>
        <div className="brand-marks">
          <PopMark burst size={64} />
          <p className="brand-block__body">{BRAND_ASSETS.markBody}</p>
        </div>
      </section>

      <section className="brand-block">
        <h2 className="brand-block__title">{BRAND_ASSETS.wordmarkTitle}</h2>
        <div className="brand-marks">
          <Wordmark className="brand-wordmark" />
          <p className="brand-block__body">{BRAND_ASSETS.wordmarkBody}</p>
        </div>
      </section>

      <section className="brand-block">
        <h2 className="brand-block__title">{BRAND_ASSETS.paletteTitle}</h2>
        <ul className="brand-swatches">
          {BRAND_ASSETS.palette.map((sw) => (
            <li key={sw.hex} className="brand-swatch">
              <span className="brand-swatch__chip" style={{ background: sw.hex }} aria-hidden="true" />
              <span className="brand-swatch__name">{sw.name}</span>
              <span className="brand-swatch__hex">{sw.hex}</span>
              <span className="brand-swatch__usage">{sw.usage}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="brand-block">
        <h2 className="brand-block__title">{BRAND_ASSETS.spectrumTitle}</h2>
        <p className="brand-block__body">{BRAND_ASSETS.spectrumBody}</p>
        <ul className="brand-spectrum">
          {FLEET.map((agent) => {
            const hue = DEPARTMENT_SPECTRUM[agent.department];
            return (
              <li key={agent.handle} className="brand-spectrum__item">
                <span className="brand-spectrum__chip" style={{ background: hue }} aria-hidden="true" />
                <span className="brand-spectrum__name">{agent.name}</span>
                <span className="brand-spectrum__hex">{hue}</span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="brand-block">
        <h2 className="brand-block__title">{BRAND_ASSETS.voiceTitle}</h2>
        <p className="brand-block__body">{BRAND_ASSETS.voiceBody}</p>
      </section>
    </article>
  );
}
