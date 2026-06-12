/**
 * The FAQ section (#165): SEO-grade, substantive Q&As in the house voice, rendered as native
 * `<details>` accordions so they work without JavaScript and are crawlable (the answer text is always
 * in the DOM). The first item is open by default. All copy from `brand.ts` (brand.test scans this file).
 */
import { FAQ } from "../../brand.js";

export function Faq(): React.JSX.Element {
  return (
    <section id="faq" className="landing__section landing__faq" aria-labelledby="faq-title">
      <h2 id="faq-title" className="landing__section-title">
        {FAQ.title}
      </h2>
      <p className="landing__section-sub">{FAQ.subtitle}</p>
      <div className="faq__list">
        {FAQ.items.map((item, i) => (
          <details key={item.q} className="faq__item" open={i === 0}>
            <summary className="faq__q">
              <span>{item.q}</span>
              <span className="faq__chev" aria-hidden="true" />
            </summary>
            <p className="faq__a">{item.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
