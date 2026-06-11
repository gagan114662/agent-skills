/**
 * The marketing-site bundle entry (#153). One lazy-loaded component routes every public marketing path
 * (`/compare`, `/stories`, `/guides`, `/changelog`, `/brand`, and their `/section/slug` documents) to
 * the right page inside the shared {@link SiteShell}. Code-split so it never ships in the signed-in app
 * bundle. Public: it renders for logged-out *and* logged-in visitors (AuthGate matches it first).
 */
import { COMPARE, STORIES, GUIDES, CHANGELOG } from "../../brand.js";
import { useRoute } from "../../routing.js";
import { SiteShell } from "./SiteShell.js";
import { SectionPage, type SectionCopy } from "./SectionPage.js";
import { Brand } from "./Brand.js";
import { parseMarketingPath } from "./paths.js";

const SECTION_COPY: Record<string, SectionCopy> = {
  compare: COMPARE,
  stories: STORIES,
  guides: GUIDES,
  changelog: CHANGELOG,
};

export default function MarketingSite(): React.JSX.Element {
  const path = useRoute();
  const { section, slug } = parseMarketingPath(path);

  let page: React.JSX.Element;
  if (section === "brand") {
    page = <Brand />;
  } else if (SECTION_COPY[section]) {
    page = <SectionPage section={section} slug={slug} copy={SECTION_COPY[section]!} />;
  } else {
    // Defensive: AuthGate only routes known marketing paths here, but fall back to the compare index.
    page = <SectionPage section="compare" copy={COMPARE} />;
  }

  return <SiteShell>{page}</SiteShell>;
}
