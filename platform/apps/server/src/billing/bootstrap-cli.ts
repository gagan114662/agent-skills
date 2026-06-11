/**
 * `billing:bootstrap` (#125, ADR-0125) — idempotently create the Stripe products/prices for every plan.
 *
 *   pnpm -C platform/apps/server billing:bootstrap <workspaceId>
 *
 * With `BILLING_PROVIDER` unset/`none` it mints synthetic ids and makes **zero network calls** (dev/CI
 * never spend). With `BILLING_PROVIDER=stripe` and `STRIPE_SECRET_KEY` resolvable for the workspace it
 * creates each product/price **exactly once** — a second run is a pure no-op (the `(workspace, plan,
 * provider)` registry PK). It **never prints a secret value**: only ids/counts are logged.
 *
 * The owner pastes the key out-of-band first (the agent never handles key material):
 *   fly secrets set STRIPE_SECRET_KEY=sk_live_…  --app ipop-api
 *   fly ssh console --app ipop-api -C "pnpm -C platform/apps/server billing:bootstrap <workspaceId>"
 */
import { createDefaultBilling } from "./default.js";
import type { SessionLogger } from "../runtime/manager.js";

const consoleLogger: SessionLogger = {
  child: () => consoleLogger,
  info: (obj: unknown, msg?: string) => console.log(msg ?? "", obj ?? ""),
  warn: (obj: unknown, msg?: string) => console.warn(msg ?? "", obj ?? ""),
  error: (obj: unknown, msg?: string) => console.error(msg ?? "", obj ?? ""),
};

async function main(): Promise<void> {
  const workspaceId = process.argv[2];
  if (!workspaceId) {
    console.error("usage: billing:bootstrap <workspaceId>");
    process.exit(2);
  }

  const { planService } = createDefaultBilling(consoleLogger);
  const result = await planService.bootstrap(workspaceId);

  if (result.provider === "none") {
    console.log(
      `[billing:bootstrap] provider=none — zero network, synthetic ids (dev/CI never spend).`,
    );
  }
  console.log(
    `[billing:bootstrap] workspace=${workspaceId} provider=${result.provider} ` +
      `created=[${result.created.join(",")}] existing=[${result.existing.join(",")}]`,
  );
  // The script logs only plan keys + counts — never a secret value, never a price/product id either.
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    // Errors from the provider are already redacted by the service before they surface here.
    console.error("[billing:bootstrap] failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
