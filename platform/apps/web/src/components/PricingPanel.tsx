/**
 * The `/pricing` container (#125): fetches the plan catalog + active plan, and on a plan click opens a
 * real Stripe Checkout via the #98 seam. View-local state (a polled, page-scoped concern) lives here so
 * {@link PricingTable} stays a pure, unit-tested component — the same split as {@link UsagePanel}.
 */
import { useEffect, useState } from "react";
import type { ActivePlanDto, PlanDto, PlansResponseDto } from "@reload/shared";
import { useAppState } from "../store/StoreContext.js";
import { api, ApiError, isApiUnavailable } from "../api/client.js";
import { PricingTable } from "./PricingTable.js";
import { PopLoader } from "./PopLoader.js";

/**
 * The plan catalog rarely changes within a session, so we cache the first successful response per
 * workspace at module scope. Re-opening Pricing (a tab switch) then renders instantly from cache instead
 * of flashing blank for the ~3s the request takes — the loader only ever shows on the very first open
 * (#169 bug 11). A silent background refresh on each open keeps the active-plan badge current.
 */
const planCache = new Map<string, PlansResponseDto>();

/** Turn a server/Api error into a warm, customer-facing line (never a raw status). */
function humanizeCheckoutError(err: unknown): string {
  if (isApiUnavailable(err))
    return "We can't reach checkout right now — give it another go in a moment.";
  if (err instanceof ApiError && err.status === 409) {
    return "Checkout isn't switched on for this workspace yet. Ping the owner to flip it on.";
  }
  return "Something went sideways starting checkout. Mind trying again?";
}

export function PricingPanel(): React.JSX.Element {
  const { identity } = useAppState();
  const workspaceId = identity?.workspaceId;
  const cached = workspaceId ? planCache.get(workspaceId) : undefined;
  const [plans, setPlans] = useState<PlanDto[]>(cached?.plans ?? []);
  const [current, setCurrent] = useState<ActivePlanDto | null>(cached?.current ?? null);
  // Show the pop loader only while we have nothing to render yet — never on a cache hit.
  const [loading, setLoading] = useState(!cached);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    const hit = planCache.get(workspaceId);
    if (hit) {
      // Serve the cache immediately; refresh in the background without a loader.
      setPlans(hit.plans);
      setCurrent(hit.current);
      setLoading(false);
    } else {
      setLoading(true);
    }
    void api.billing
      .listPlans(workspaceId)
      .then((res) => {
        planCache.set(workspaceId, res);
        if (!live) return;
        setPlans(res.plans);
        setCurrent(res.current);
      })
      .catch(() => {
        /* leave the cache/empty state; a transient error self-heals on the next mount */
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [workspaceId]);

  async function choose(planKey: string): Promise<void> {
    if (!workspaceId) return;
    setError(null);
    setPendingKey(planKey);
    try {
      const { url } = await api.billing.startCheckout(workspaceId, planKey);
      // Send the customer to the hosted checkout (Stripe, or the no-network none URL in dev).
      window.location.assign(url);
    } catch (err) {
      setError(humanizeCheckoutError(err));
      setPendingKey(null);
    }
  }

  return (
    <div className="workspace__panel">
      {loading && plans.length === 0 ? (
        <div className="pricing pricing--loading">
          <PopLoader label="Loading plans…" />
        </div>
      ) : (
        <PricingTable
          plans={plans}
          current={current}
          onChoose={(key) => void choose(key)}
          pendingKey={pendingKey}
          error={error}
        />
      )}
    </div>
  );
}
