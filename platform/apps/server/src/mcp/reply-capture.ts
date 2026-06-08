import type { FastifyReply } from "fastify";

/**
 * A fake `FastifyReply` that records the first `(code, body)` an access helper sends, instead of
 * writing to a socket (#10, ADR-0010 decision 2). The existing access guards
 * (`requireChannelCapability`, `requireTaskInWorkspace`, `requireMemoryCapability`) decide allow/deny
 * by *sending* an error response and returning a falsy value. The MCP tools have no HTTP reply, so
 * they pass this shim: the **same** guard makes the decision, and the tool turns a captured non-2xx
 * into an MCP tool error. One access-control implementation, two transports — they can never drift.
 */
export interface CapturedReply {
  /** Cast to `FastifyReply` for the guards; only `code()`/`send()` are exercised. */
  reply: FastifyReply;
  /** The captured `{ code, body }` if the guard sent an error, else null (i.e. it allowed). */
  denial(): { code: number; body: { error?: string } } | null;
}

export function captureReply(): CapturedReply {
  let status = 200;
  let captured: { code: number; body: { error?: string } } | null = null;
  const fake = {
    code(c: number) {
      status = c;
      return fake;
    },
    send(body: unknown) {
      captured = { code: status, body: (body ?? {}) as { error?: string } };
      return fake;
    },
    header() {
      return fake;
    },
  };
  return {
    reply: fake as unknown as FastifyReply,
    denial: () => captured,
  };
}
