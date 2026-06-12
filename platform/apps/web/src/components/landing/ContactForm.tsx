/**
 * The closing contact block (#165): "a short reply, not a deck." A small, honest form — name, email, and
 * one open question. It's client-only (no backend wired yet), so on submit it shows a candid note that
 * says exactly that rather than faking a success state. All copy from `brand.ts` (brand.test scans this
 * file).
 */
import { useState, type FormEvent } from "react";
import { CONTACT } from "../../brand.js";

export function ContactForm(): React.JSX.Element {
  const [sent, setSent] = useState(false);

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    setSent(true);
  }

  return (
    <section id="contact" className="landing__section landing__contact" aria-labelledby="contact-title">
      <div className="landing__contact-inner">
        <p className="landing__eyebrow">{CONTACT.eyebrow}</p>
        <h2 id="contact-title" className="landing__section-title landing__contact-title">
          {CONTACT.title}
        </h2>
        <p className="landing__contact-body">{CONTACT.body}</p>
        <form className="contact-form" onSubmit={onSubmit}>
          <div className="contact-form__row">
            <label className="field">
              {CONTACT.nameLabel}
              <input type="text" name="name" autoComplete="name" />
            </label>
            <label className="field">
              {CONTACT.emailLabel}
              <input type="email" name="email" autoComplete="email" />
            </label>
          </div>
          <label className="field">
            {CONTACT.messageLabel}
            <textarea name="message" rows={3} placeholder={CONTACT.messagePlaceholder} />
          </label>
          <button className="btn btn--primary contact-form__submit" type="submit">
            {CONTACT.submitLabel}
          </button>
          {sent && (
            <p className="contact-form__sent" role="status">
              {CONTACT.sentNote}
            </p>
          )}
        </form>
      </div>
    </section>
  );
}
