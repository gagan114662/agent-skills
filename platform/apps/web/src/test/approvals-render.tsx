/** Render an approvals component against a fake backend, bootstrapped to `ready` with an identity. */
import { render, type RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import type { Identity, ServerEvent } from "../api/types.js";
import { createStore, type Store } from "../store/store.js";
import { StoreProvider } from "../store/StoreContext.js";
import { makeFakeApprovalDeps, type ApprovalFixtureOverrides } from "./approvals-fixtures.js";
import { TEST_IDENTITY } from "./utils.js";

export interface RenderApprovalsOptions extends ApprovalFixtureOverrides {
  /** Caller kind — drives human-only RBAC in the UI. Default human. */
  as?: "human" | "agent";
  /** Override the caller's member id (e.g. to make them the requester). Default `me1`. */
  memberId?: string;
}

/**
 * Bootstraps the store BEFORE rendering so the identity (and the seeded pending queue) are present
 * when the component mounts and runs its load effects.
 */
export async function renderApprovals(
  ui: ReactNode,
  opts: RenderApprovalsOptions = {},
): Promise<RenderResult & { store: Store; fire: (e: ServerEvent) => void; approvals: ReturnType<typeof makeFakeApprovalDeps>["approvals"] }> {
  const { as = "human", memberId = "me1", ...over } = opts;
  const { deps, rt, approvals } = makeFakeApprovalDeps(over);
  const identity: Identity = { ...TEST_IDENTITY, memberId, kind: as };
  deps.api.me = vi.fn(async () => identity);
  const store = createStore(deps);
  await store.bootstrap();
  const result = render(<StoreProvider store={store}>{ui}</StoreProvider>);
  return { ...result, store, fire: rt.fire, approvals };
}
