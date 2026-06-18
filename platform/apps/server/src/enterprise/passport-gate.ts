/**
 * The Passport gate WIRING (#340, ADR-0340) — composes the pure {@link decidePassport} over the existing
 * `resolveIdentity` auth so the v5 console + department agents sit behind the customer's IdP/SSO. Registered
 * as a Fastify `onRequest` hook; default-OFF and owner-workspace-first, so it is a NO-OP unless the workspace
 * has the Passport gate enabled — existing auth is unchanged until an owner turns it on.
 *
 * The IdP assertion is resolved through an INJECTED {@link IdpAssertionResolver}. The default resolver returns
 * null (no verified SSO assertion is wired in this slice), so an owner who enables the gate before wiring a
 * real IdP resolver gets a fully-dark surface — which is the correct fail-closed posture ("nothing internal is
 * publicly exposed"). Wiring a real resolver (reading a verified server-side SSO session marker, e.g. the #260
 * Google sign-in) is the owner-gated follow-up. `verified` is always a trusted server-side fact, never a header.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { resolveIdentity } from "../auth/middleware.js";
import type { Identity } from "../auth/identity.js";
import { decidePassport, type IdpAssertion } from "./passport.js";
import { isPassportEnabledForWorkspace, type EnterpriseCaps } from "./caps.js";

/** Resolve the caller's verified IdP assertion (or null). `verified` MUST be a trusted server-side fact. */
export type IdpAssertionResolver = (
  req: FastifyRequest,
  identity: Identity,
) => IdpAssertion | null | Promise<IdpAssertion | null>;

export interface PassportHookDeps {
  /** Resolve the workspace's enterprise policy (production: `enterpriseCapsFor`). */
  loadCaps: (workspaceId: string) => EnterpriseCaps;
  /** Resolve the caller's IdP assertion. Default: null (fail-closed until a real IdP resolver is wired). */
  resolveAssertion?: IdpAssertionResolver;
}

/**
 * Build a Fastify `onRequest` hook enforcing the Passport gate. It only acts when the gate is enabled for the
 * caller's workspace; otherwise it returns immediately (no-op). An unauthenticated caller is left to the
 * route's own `requireIdentity` (the gate never weakens auth); an authenticated caller without a verified,
 * allow-listed IdP assertion is refused with 403.
 */
export function createEnterprisePassportHook(deps: PassportHookDeps) {
  const resolveAssertion: IdpAssertionResolver = deps.resolveAssertion ?? (() => null);
  return async function enterprisePassportHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const identity = await resolveIdentity(req);
    if (!identity) return; // no identity → the route's requireIdentity returns 401; nothing exposed here.
    const caps = deps.loadCaps(identity.workspaceId);
    if (!isPassportEnabledForWorkspace(caps, identity.workspaceId)) return; // gate off → no-op.

    const assertion = await resolveAssertion(req, identity);
    const decision = decidePassport({
      enabled: true,
      identityPresent: true,
      assertion,
      allowedProviders: caps.allowedIdpProviders,
    });
    if (!decision.allow) {
      await reply.code(403).send({ error: "passport_required", status: decision.status, reason: decision.reason });
    }
  };
}
