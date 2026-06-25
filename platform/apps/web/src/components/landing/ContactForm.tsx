/**
 * The closing contact block (#165): "a short reply, not a deck." A small, honest form — name, email, and
 * one open question. As of GAP 1 of the leads centre (ADR-0400) it is WIRED: on submit it POSTs to the
 * public `/inbound/leads` capture route, which persists the lead and best-effort feeds the #222 discovery
 * engine — so a real prospect is captured instead of dropped. No auth, no money, no send: just capture.
 * All copy from `brand.ts` (brand.test scans this file).
 */
import { useState, type FormEvent } from "react";
import { CONTACT, LEGAL } from "../../brand.js";
import { apiUrl } from "../../api/config.js";
import { Link } from "../../routing.js";

type Status = "idle" | "sending" | "sent" | "error";
type NextStep = { label: string; href: string };

function attributionFromLocation(): {
  source: string;
  trackingRef?: string;
} {
  if (typeof window === "undefined") return { source: "landing_form" };
  const params = new URLSearchParams(window.location.search);
  const ref = params.get("ref")?.trim();
  const utmSource = params.get("utm_source")?.trim();
  return {
    source: params.get("source")?.trim() || utmSource || "landing_form",
    ...(ref ? { trackingRef: ref } : {}),
  };
}

export function ContactForm(): React.JSX.Element {
  const [status, setStatus] = useState<Status>("idle");
  const [nextStep, setNextStep] = useState<NextStep | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (status === "sending") return;
    const form = e.currentTarget;
    const data = new FormData(form);
    const payload = {
      name: String(data.get("name") ?? ""),
      email: String(data.get("email") ?? ""),
      message: String(data.get("message") ?? ""),
      companyWebsite: String(data.get("companyWebsite") ?? ""),
      termsAccepted: data.get("termsAccepted") === "on",
      legalConsentVersion: LEGAL.consentVersion,
      legalConsentAt: new Date().toISOString(),
      ...attributionFromLocation(),
    };
    setStatus("sending");
    try {
      const res = await fetch(apiUrl("/inbound/leads"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        console.error("Inbound lead capture failed", { status: res.status });
        setStatus("error");
        return;
      }
      const body = (await res.json().catch(() => null)) as { nextStep?: Partial<NextStep> } | null;
      const maybeNextStep = body?.nextStep;
      setNextStep(
        typeof maybeNextStep?.label === "string" && typeof maybeNextStep.href === "string"
          ? { label: maybeNextStep.label, href: maybeNextStep.href }
          : null,
      );
      form.reset();
      setStatus("sent");
    } catch (err) {
      console.error("Inbound lead capture request failed", err);
      setStatus("error");
    }
  }

  return (
    <section
      id="contact"
      className="landing__section landing__contact"
      aria-labelledby="contact-title"
    >
      <div className="landing__contact-inner">
        <p className="landing__eyebrow">{CONTACT.eyebrow}</p>
        <h2 id="contact-title" className="landing__section-title landing__contact-title">
          {CONTACT.title}
        </h2>
        <p className="landing__contact-body">{CONTACT.body}</p>
        <div className="contact-form__cta-row" aria-label="Contact next steps">
          <a className="btn btn--primary" href={CONTACT.bookingHref}>
            {CONTACT.bookingCta}
          </a>
          <a className="btn contact-form__trial-link" href={CONTACT.trialHref}>
            {CONTACT.trialCta}
          </a>
        </div>
        <form className="contact-form" onSubmit={onSubmit}>
          <div className="contact-form__row">
            <label className="field">
              {CONTACT.nameLabel}
              <input type="text" name="name" autoComplete="name" />
            </label>
            <label className="field">
              {CONTACT.emailLabel}
              <input type="email" name="email" autoComplete="email" required />
            </label>
          </div>
          <label className="field">
            {CONTACT.messageLabel}
            <textarea name="message" rows={3} placeholder={CONTACT.messagePlaceholder} required />
          </label>
          <label className="contact-form__honeypot" aria-hidden="true">
            Company website
            <input type="text" name="companyWebsite" tabIndex={-1} autoComplete="off" />
          </label>
          <label className="contact-form__consent">
            <input type="checkbox" name="termsAccepted" required aria-required="true" />
            <span>
              {CONTACT.consentLabel}{" "}
              <Link href={LEGAL.terms.href} className="linklike">
                {LEGAL.terms.navLabel}
              </Link>{" "}
              /{" "}
              <Link href={LEGAL.privacy.href} className="linklike">
                {LEGAL.privacy.navLabel}
              </Link>{" "}
              /{" "}
              <Link href={LEGAL.dpa.href} className="linklike">
                {LEGAL.dpa.navLabel}
              </Link>
            </span>
          </label>
          <p className="contact-form__consent-help">{CONTACT.consentHelp}</p>
          <button
            className="btn btn--primary contact-form__submit"
            type="submit"
            disabled={status === "sending"}
          >
            {status === "sending" ? CONTACT.sendingLabel : CONTACT.submitLabel}
          </button>
          {status === "sent" && (
            <p className="contact-form__sent" role="status">
              {CONTACT.sentNote}
              {nextStep && (
                <>
                  {" "}
                  {CONTACT.nextStepIntro} <a href={nextStep.href}>{nextStep.label}</a>
                </>
              )}
            </p>
          )}
          {status === "error" && (
            <p className="contact-form__error" role="alert">
              {CONTACT.errorNote}
            </p>
          )}
        </form>
      </div>
    </section>
  );
}
