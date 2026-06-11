/**
 * The trial funnel's soft paywall (#153). It surfaces when a tenant cap is actually hit (#71 admission
 * 402/429) — the store flips a flag, and this nudges the user toward a plan instead of showing a raw
 * error. It's honest: it reads the REAL current plan from the billing surface (#125) and links to the
 * REAL pricing page. Nothing is lost; the agents are just waiting on more room to work.
 */
import { useEffect, useState } from "react";
import { api } from "../../api/client.js";
import { PAYWALL } from "../../brand.js";
import { PopMark } from "../PopMark.js";

export function SoftPaywall({
  workspaceId,
  onSeePlans,
  onDismiss,
}: {
  workspaceId: string;
  onSeePlans: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  const [planName, setPlanName] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.billing
      .listPlans(workspaceId)
      .then((res) => {
        if (!live) return;
        const current = res.current ? res.plans.find((p) => p.key === res.current?.planKey) : null;
        setPlanName(current?.name ?? "Free");
      })
      .catch(() => live && setPlanName("Free"));
    return () => {
      live = false;
    };
  }, [workspaceId]);

  return (
    <div className="paywall" role="dialog" aria-modal="true" aria-labelledby="paywall-title">
      <div className="paywall__card">
        <PopMark burst className="paywall__mark" />
        <h2 id="paywall-title" className="paywall__title">
          {PAYWALL.title}
        </h2>
        <p className="paywall__body">{PAYWALL.body}</p>
        {planName && <p className="paywall__plan">{PAYWALL.onPlan(planName)}</p>}
        <div className="paywall__actions">
          <button type="button" className="btn btn--primary" onClick={onSeePlans}>
            {PAYWALL.cta}
          </button>
          <button type="button" className="btn paywall__dismiss" onClick={onDismiss}>
            {PAYWALL.dismiss}
          </button>
        </div>
      </div>
    </div>
  );
}
