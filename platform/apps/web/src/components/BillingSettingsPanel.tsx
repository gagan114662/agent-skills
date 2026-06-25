/**
 * Settings → Billing panel (#215) — container. Fetches the workspace's active plan (the un-gated #125
 * catalog) and this-window usage (#71), renders the pure {@link BillingSettings} summary, and embeds the
 * existing {@link PricingPanel} so the customer can upgrade right here in Settings (the conversion path that
 * was missing). Kept separate from the store — a view-local settings concern — and mirrors the
 * container/presentational split of {@link ConnectClaudePanel}.
 */
import { useEffect, useState } from "react";
import type { ActivePlanDto, BillingInvoiceDto, PlanDto } from "@reload/shared";
import type { UsageReport } from "../api/types.js";
import { useAppState } from "../store/StoreContext.js";
import { api } from "../api/client.js";
import { BillingSettings } from "./BillingSettings.js";
import { PricingPanel } from "./PricingPanel.js";

export function BillingSettingsPanel(): React.JSX.Element {
  const { identity } = useAppState();
  const workspaceId = identity?.workspaceId;
  const [plans, setPlans] = useState<PlanDto[]>([]);
  const [current, setCurrent] = useState<ActivePlanDto | null>(null);
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [invoices, setInvoices] = useState<BillingInvoiceDto[]>([]);
  // #481 go-live: whether real payments are on (stripe + live mode). Defaults to false → the test-mode note.
  const [goLive, setGoLive] = useState(false);

  useEffect(() => {
    if (!workspaceId) return;
    let mounted = true;
    // All reads are best-effort: a transient failure just leaves the summary on its trial/empty/test default
    // and self-heals on the next open. The embedded PricingPanel fetches the catalog on its own too.
    void api.billing
      .listPlans(workspaceId)
      .then((res) => {
        if (!mounted) return;
        setPlans(res.plans);
        setCurrent(res.current);
      })
      .catch(() => {});
    void api
      .getScaleUsage(workspaceId)
      .then((u) => mounted && setUsage(u))
      .catch(() => {});
    void api.billing
      .status(workspaceId)
      .then((s) => mounted && setGoLive(s.live))
      .catch(() => {});
    void api.billing
      .listInvoices(workspaceId)
      .then((res) => mounted && setInvoices(res.invoices))
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [workspaceId]);

  return (
    <div className="billing-settings-panel">
      <BillingSettings current={current} plans={plans} usage={usage} live={goLive} invoices={invoices} />
      <PricingPanel />
    </div>
  );
}
