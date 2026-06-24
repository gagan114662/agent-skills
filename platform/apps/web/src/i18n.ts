import { LANDING } from "./brand.js";

export const LOCALES = ["en", "fr"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

export type LandingCopy = Omit<typeof LANDING, "anchors" | "hero" | "sections" | "steps"> & {
  readonly anchors: ReadonlyArray<{ readonly href: string; readonly label: string }>;
  readonly hero: {
    readonly eyebrow: string;
    readonly sub: string;
    readonly ctaPrimary: string;
    readonly ctaSecondary: string;
  };
  readonly sections: { readonly [K in keyof typeof LANDING.sections]: string };
  readonly steps: ReadonlyArray<{ readonly n: string; readonly title: string; readonly body: string }>;
};

export interface LocaleCopy {
  readonly label: string;
  readonly landing: LandingCopy;
  readonly navToggle: string;
  readonly navLabel: string;
}

export const I18N: Record<Locale, LocaleCopy> = {
  en: {
    label: "English",
    landing: LANDING,
    navToggle: "Open section navigation",
    navLabel: "On this page",
  },
  fr: {
    label: "Francais",
    navToggle: "Ouvrir la navigation des sections",
    navLabel: "Sur cette page",
    landing: {
      ...LANDING,
      anchors: [
        { href: "#how", label: "Comment ca marche" },
        { href: "#agents", label: "Agents" },
        { href: "#pricing", label: "Tarifs" },
        { href: "#faq", label: "FAQ" },
      ],
      hero: {
        ...LANDING.hero,
        eyebrow: "Une equipe marketing IA complete",
        ctaPrimary: "Commencer gratuitement",
        ctaSecondary: "Se connecter",
        sub:
          "Scout, Quill, Echo et le reste du departement recherchent, redigent et planifient pendant que vous gardez le dernier mot.",
      },
      sections: {
        ...LANDING.sections,
        howTitle: "Comment ca marche",
        howSub: "Vous donnez l'objectif, les agents transforment le travail en livrables, puis vous approuvez ce qui sort.",
        fleetTitle: "Rencontrez le departement",
        fleetSub: "Chaque agent a un role clair, une file de travail, et une limite: rien de public ne part sans votre accord.",
        pricingTitle: "Choisissez votre pop",
        pricingSub: "Commencez petit, gardez le controle des depenses, et augmentez quand le travail le merite.",
        pricingCta: "Voir tous les forfaits",
        ctaTitle: "Pret a donner un objectif a l'equipe?",
        ctaSub: "Lancez le departement, regardez le premier livrable, puis decidez quoi publier.",
        ctaButton: "Commencer gratuitement",
      },
      steps: [
        {
          n: "01",
          title: "Decrivez le resultat",
          body: "Dites ce que vous voulez obtenir: plus de prospects, une page plus claire, ou une campagne a lancer.",
        },
        {
          n: "02",
          title: "Les agents font le travail",
          body: "Ils recherchent, redigent, coordonnent et vous montrent les preuves au lieu de cacher le processus.",
        },
        {
          n: "03",
          title: "Vous approuvez les sorties",
          body: "Les envois, depenses et publications attendent une decision humaine avant de partir.",
        },
      ],
    },
  },
} as const;

export function normalizeLocale(value: string | null | undefined): Locale {
  const lang = (value ?? "").toLowerCase().split("-")[0];
  return LOCALES.includes(lang as Locale) ? (lang as Locale) : DEFAULT_LOCALE;
}

export function localeFromUrl(search: string, navLanguage?: string): Locale {
  const params = new URLSearchParams(search);
  return normalizeLocale(params.get("lang") ?? navLanguage);
}

export function currentLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  return localeFromUrl(window.location.search, window.navigator.language);
}

export function dateLocale(locale: Locale): string {
  return locale === "fr" ? "fr-FR" : "en-US";
}

export function hreflangLinks(origin: string, path: string): string {
  const cleanPath = path === "/" ? "/" : path.replace(/\/+$/, "");
  const base = `${origin}${cleanPath === "/" ? "/" : cleanPath}`;
  const perLocale = LOCALES.map((locale) => {
    const href = `${base}${locale === DEFAULT_LOCALE ? "" : `?lang=${locale}`}`;
    return `  <link rel="alternate" hreflang="${locale}" href="${href}" />`;
  });
  // x-default points search engines at the unparameterised default-locale URL for unmatched languages.
  perLocale.push(`  <link rel="alternate" hreflang="x-default" href="${base}" />`);
  return perLocale.join("\n");
}
