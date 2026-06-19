/**
 * Agent→browser tool bridge (#388 slice 2, ADR-0388 §Slice-2). Exposes the seven #174 browser tools
 * (navigate / read_page / screenshot / scroll / wait / click / type) to a fleet agent as MCP-shaped tool
 * definitions, with EVERY call routed through {@link BrowserSessionManager} → {@link BrowserSession.step}.
 * Nothing here re-implements the gate: the session's single `step()` path enforces the caps + domain
 * lists + the side-effect classification, asks the #13 approval gate for `click`/`type`, hard-forbids
 * credential entry, and records a receipt + screenshot for every step. The bridge is a THIN adapter — it
 * opens one session (lazily, with slice-1 session injection) and forwards each tool call.
 *
 * Gating (default-OFF, owner-first — unchanged behavior when off):
 *   - The whole bridge is gated on the workspace's `[browser]` `enabled` flag (via {@link BrowserCaps}).
 *     When the browser is OFF, {@link createBrowserAgentBridge} returns `{ tools: [] }` — the bridge is
 *     not offered, so today's behavior is byte-for-byte unchanged.
 *   - The session is opened WITH the `target`, so the slice-1 manager injects the per-workspace logged-in
 *     `storageState` ONLY when the session-injection flag is active for the workspace (else authless).
 *
 * The SUBMIT (a `click` on a post/submit control, or any side-effectful `type`/`click`) stays #13-gated:
 * the bridge has NO autonomous post path. An unapproved side-effectful tool call returns `ok:false` with
 * the pending approval id — exactly the smoke-test posture — and the driver is never touched.
 *
 * This module is a pure factory over its injected deps (no clock, no I/O of its own — all I/O is the
 * session manager's). It is deliberately NOT yet wired into the live MCP server (`mcp/server.ts`); the
 * `BrowserBridgeTool[]` it returns are the adapters that slice's wiring will register. See ADR-0388.
 */
import { BROWSER_TOOLS, type BrowserToolName } from "./tools.js";
import type { BrowserCaps } from "./caps.js";
import type { BrowserSession, BrowserStepResult } from "./session.js";

/**
 * The minimal structural slice of {@link BrowserSessionManager} the bridge needs. Declared as an
 * interface (not the concrete class) so the unit job drives the bridge with a fake manager and asserts
 * the delegation contract without a real driver.
 */
export interface BrowserSessionOpener {
  open(input: { sessionId: string; workspaceId: string; target?: string }): Promise<BrowserSession>;
}

/** The arguments an agent passes to one bridge tool. Only the fields a given tool reads are used. */
export interface BrowserToolArgs {
  /** `navigate` — the URL to load. */
  url?: string;
  /** `click` / `type` — the target element selector. */
  selector?: string;
  /** `type` — the text to enter. */
  text?: string;
  /**
   * `type` — mark the field a credential/password input. The session HARD-forbids this (never
   * gated-then-allowed): the agent browser never enters credentials (ADR-0174 §2). Pass-through only.
   */
  credentialEntry?: boolean;
  /** `scroll` — scroll to a named edge. */
  to?: "top" | "bottom";
  /** `scroll` — scroll by a pixel delta. */
  deltaY?: number;
  /** `wait` — milliseconds to wait. */
  ms?: number;
}

/** One bridge tool: its name, whether it mutates remote state, a description, and its async handler. */
export interface BrowserBridgeTool {
  name: BrowserToolName;
  /** True iff the tool can mutate remote state (a `click`/`type`) — always #13-gated by the session. */
  sideEffectful: boolean;
  description: string;
  /** Invoke the tool — opens the session on first use and delegates to the matching session method. */
  invoke(args: BrowserToolArgs): Promise<BrowserStepResult>;
}

export interface BrowserAgentBridge {
  /** The exposed tools — EMPTY when the browser is disabled for the workspace (bridge not offered). */
  tools: BrowserBridgeTool[];
}

export interface BrowserAgentBridgeDeps {
  /** Opens (and owns the lifecycle of) the browser session — the slice-1 manager. */
  manager: BrowserSessionOpener;
  /** The workspace the agent acts in (tenant scope — passed straight through to the manager). */
  workspaceId: string;
  /** The agent's session id — one browser per session (the manager enforces at most one). */
  sessionId: string;
  /** The per-workspace browser policy. `enabled:false` ⇒ no tools are exposed. */
  caps: BrowserCaps;
  /**
   * The site the agent will operate. Passed to `manager.open` so the slice-1 session injection can load
   * the per-workspace logged-in `storageState` (when its flag is active); omit for an authless session.
   */
  target?: string;
}

/**
 * Build the agent→browser bridge for one `(workspace, session)`. Returns `{ tools: [] }` when the
 * browser is disabled for the workspace — so a flag-off deployment never offers the bridge and behavior
 * is unchanged. When enabled, it exposes the seven tools; the underlying browser session is opened
 * LAZILY on the first tool call (so building the bridge allocates no browser) and reused for the rest.
 */
export function createBrowserAgentBridge(deps: BrowserAgentBridgeDeps): BrowserAgentBridge {
  if (!deps.caps.enabled) return { tools: [] };

  // Lazily-opened, memoised session. The manager enforces "one browser per session"; opening here on
  // first use means an enabled-but-unused bridge never spins a context. `target` flows into open() so the
  // slice-1 injection loads the logged-in storageState when its flag is active for the workspace.
  let sessionPromise: Promise<BrowserSession> | null = null;
  const session = (): Promise<BrowserSession> => {
    if (!sessionPromise) {
      sessionPromise = deps.manager.open({
        sessionId: deps.sessionId,
        workspaceId: deps.workspaceId,
        ...(deps.target !== undefined ? { target: deps.target } : {}),
      });
    }
    return sessionPromise;
  };

  const run = (fn: (s: BrowserSession) => Promise<BrowserStepResult>) => async (): Promise<BrowserStepResult> => {
    const s = await session();
    return fn(s);
  };

  // Each handler delegates to the matching session method — every step (read OR side-effect) funnels
  // through BrowserSession.step(), which is the ONLY place the gate / approval / receipt / credential
  // forbid live. The bridge adds no policy of its own; it cannot bypass the gate by construction.
  const handlers: Record<BrowserToolName, BrowserBridgeTool["invoke"]> = {
    navigate: (args) => run((s) => s.navigate(String(args.url ?? "")))(),
    read_page: () => run((s) => s.readPage())(),
    screenshot: () => run((s) => s.takeScreenshot())(),
    scroll: (args) =>
      run((s) =>
        s.scroll(
          args.to !== undefined
            ? { to: args.to }
            : args.deltaY !== undefined
              ? { deltaY: args.deltaY }
              : undefined,
        ),
      )(),
    wait: (args) => run((s) => s.wait(Number(args.ms ?? 0)))(),
    click: (args) => run((s) => s.click(String(args.selector ?? "")))(),
    type: (args) =>
      run((s) =>
        s.type(String(args.selector ?? ""), String(args.text ?? ""), {
          credentialEntry: args.credentialEntry === true,
        }),
      )(),
  };

  const tools: BrowserBridgeTool[] = BROWSER_TOOLS.map((spec) => ({
    name: spec.name,
    sideEffectful: spec.sideEffectful,
    description: spec.description,
    invoke: handlers[spec.name],
  }));

  return { tools };
}
