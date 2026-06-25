# Spec: Company Information Surface (#866)

## Objective
Add a public company-info surface for buyers, processors, and legal teams. The surface must list the contracting entity details, jurisdiction, postal-notice path, and principal, and it must be linked from the public footer.

## Tech Stack
- React public landing components in platform/apps/web/src/components/landing/
- Brand/copy source of truth in platform/apps/web/src/brand.ts
- Public routing in platform/apps/web/src/components/AuthGate.tsx
- SSR/prerender coverage in platform/apps/web/src/entry-server.tsx

## Commands
- Focused tests: pnpm --filter @reload/web exec vitest run --config vitest.config.ts src/brand.test.ts src/components/AuthGate.test.tsx src/entry-server.test.tsx
- Typecheck: pnpm -C platform run --if-present typecheck
- Lint: pnpm -C platform run --if-present lint
- Diff check: git diff --check

## Project Structure
- src/brand.ts carries company facts and footer links.
- src/components/landing/CompanyPage.tsx renders the public page.
- src/components/AuthGate.tsx serves /company to anonymous and signed-in visitors.
- src/entry-server.tsx prerenders /company.

## Code Style
COMPANY in brand.ts is the source of truth for href, labels, detail rows, and legal links. Components stay structural and read all text from brand.ts.

## Testing Strategy
Pin the footer link, public route, and prerendered page. The factual company values are env-overridable so deployment can publish owner-verified legal facts without editing React code.

## Boundaries
- Always: keep legal facts centralized and public route unauthenticated.
- Ask first: inventing a registered entity, address, or officer details not supplied by the owner.
- Never: hide Terms, Privacy, Security, or refund links from the company page.

## Success Criteria
- A public /company page lists legal entity, jurisdiction, postal address/notices, and principal.
- The page is linked from the public landing footer.
- The page is included in prerender/SEO coverage.
- Focused tests and static checks pass.
