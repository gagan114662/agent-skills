/**
 * Dev-only screenshot harness for issue #145 (the motion/polish pass). NOT part of the product build:
 * it lives outside `src/` (so tsconfig + `vite build` ignore it) and is served only by `vite dev` at
 * /gallery/gallery.html. It seeds a REAL store with a hand-rolled fake backend so every product surface
 * (Chat, Approvals, Pricing, Login) renders with representative data for before/after comparison.
 *
 * Pick a surface with the URL hash: #chat (default), #approvals, #pricing, #login.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { ApprovalRequestDto, PlanDto } from "@reload/shared";
import { App } from "../src/App.js";
import { createStore, type StoreDeps } from "../src/store/store.js";
import { StoreProvider } from "../src/store/StoreContext.js";
import { Workspace } from "../src/components/Workspace.js";
import { ApprovalsPanel } from "../src/components/approvals/ApprovalsPanel.js";
import { PricingTable } from "../src/components/PricingTable.js";
import { AutomationsPanel } from "../src/components/automations/AutomationsPanel.js";
import { Composer } from "../src/components/Composer.js";
import { Landing } from "../src/components/landing/Landing.js";
import { applyBrand } from "../src/brand.js";
import "../src/styles.css";

applyBrand();

const IDENTITY = { workspaceId: "ws_demo", memberId: "me1", kind: "human" as const, displayName: "Ada Lovelace" };

// Seven department channels (names key the spectrum) + a couple of shared rooms + one DM.
const CHANNELS = [
  { id: "c_general", workspaceId: "ws_demo", kind: "public" as const, name: "general", isArchived: false },
  { id: "c_seo", workspaceId: "ws_demo", kind: "public" as const, name: "seo", isArchived: false },
  { id: "c_social", workspaceId: "ws_demo", kind: "public" as const, name: "social", isArchived: false },
  { id: "c_content", workspaceId: "ws_demo", kind: "public" as const, name: "content", isArchived: false },
  { id: "c_email", workspaceId: "ws_demo", kind: "public" as const, name: "email", isArchived: false },
  { id: "c_ads", workspaceId: "ws_demo", kind: "public" as const, name: "ads", isArchived: false },
  { id: "c_analytics", workspaceId: "ws_demo", kind: "public" as const, name: "analytics", isArchived: false },
  { id: "c_brand", workspaceId: "ws_demo", kind: "public" as const, name: "brand", isArchived: false },
  { id: "c_dm", workspaceId: "ws_demo", kind: "dm" as const, name: null, isArchived: false },
];

const ROSTER = [
  { id: "me1", kind: "human" as const, displayName: "Ada Lovelace" },
  { id: "ag_scout", kind: "agent" as const, displayName: "Scout" },
  { id: "ag_echo", kind: "agent" as const, displayName: "Echo" },
  { id: "ag_quill", kind: "agent" as const, displayName: "Quill" },
];

const MESSAGES = [
  { id: "m1", channelId: "c_general", authorMemberId: "ag_scout", parentMessageId: null, alsoSentToChannel: false, body: "Morning! We've already drafted three blog briefs and queued a keyword sweep. Want a look?" },
  { id: "m2", channelId: "c_general", authorMemberId: "me1", parentMessageId: null, alsoSentToChannel: false, body: "Yes please — send the top one over." },
  { id: "m3", channelId: "c_general", authorMemberId: "ag_echo", parentMessageId: null, alsoSentToChannel: false, body: "On it. I'll also tee up a matching social thread so they ship together." },
  { id: "m4", channelId: "c_general", authorMemberId: "ag_quill", parentMessageId: null, alsoSentToChannel: false, body: "Draft's in your queue. Nothing leaves the building until you approve it 👍" },
];

const PENDING: ApprovalRequestDto[] = [
  {
    id: "rq1", workspaceId: "ws_demo", requesterMemberId: "ag_echo", actionType: "external.send",
    payload: {}, amount: null, summary: "Publish the launch thread to X (@ipop)", status: "pending",
    reason: null, decidedByMemberId: null, decidedAt: null, expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    result: null, error: null, createdAt: new Date(Date.now() - 240_000).toISOString(), updatedAt: new Date().toISOString(),
  },
  {
    id: "rq2", workspaceId: "ws_demo", requesterMemberId: "ag_scout", actionType: "ads.spend",
    payload: {}, amount: 250, summary: "Boost the top-performing post for the weekend", status: "pending",
    reason: null, decidedByMemberId: null, decidedAt: null, expiresAt: new Date(Date.now() + 7200_000).toISOString(),
    result: null, error: null, createdAt: new Date(Date.now() - 60_000).toISOString(), updatedAt: new Date().toISOString(),
  },
];

const PLANS: PlanDto[] = [
  { key: "starter", name: "Starter", tagline: "A tidy crew to get the words out the door.", priceCents: 4900, currency: "usd", interval: "month", agentSeats: 3, monthlySessionBudgetCents: 20000, fleetSize: 3, highlights: ["3 agents", "Drafts land in your inbox", "Email support"], featured: false },
  { key: "pro", name: "Pro", tagline: "The full department — SEO, social, content, the lot.", priceCents: 19900, currency: "usd", interval: "month", agentSeats: 7, monthlySessionBudgetCents: 100000, fleetSize: 7, highlights: ["7 named agents", "All seven departments", "Approvals + audit trail", "Priority support"], featured: true },
  { key: "agency", name: "Agency", tagline: "Run pops for your clients. We'll never tell.", priceCents: 49900, currency: "usd", interval: "month", agentSeats: 20, monthlySessionBudgetCents: 400000, fleetSize: 20, highlights: ["20 agents", "Multi-brand workspaces", "Dedicated success human"], featured: false },
];

const realtime: StoreDeps["realtime"] = {
  connect() {}, close() {}, subscribe() {}, unsubscribe() {}, presence() {}, on() { return () => {}; },
};

// The #167 panels (AutomationsPanel, TemplatePicker) call the `api` singleton, which hits the real
// fetch — there's no backend here, so stub it with canned data so the flows render for screenshots.
const TASK_TEMPLATES = [
  {
    key: "seo_audit", department: "seo", title: "SEO audit",
    description: "Crawl the site and report the highest-impact SEO fixes.",
    body: "Run an SEO audit of {{site}}. Draft the top 10 fixes — post as a draft, do not send.",
    params: [{ key: "site", label: "Site URL", placeholder: "our website" }], agentHandle: "scout",
  },
  {
    key: "content_calendar", department: "seo", title: "Content calendar",
    description: "Draft a content calendar for the next stretch.",
    body: "Draft a content calendar covering the next {{weeks}} weeks on \"{{topic}}\". Post as a draft.",
    params: [{ key: "topic", label: "Theme", placeholder: "our product" }, { key: "weeks", label: "Weeks", placeholder: "4" }],
    agentHandle: "scout",
  },
];
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (method === "GET" && url.includes("/task-templates")) return json(200, TASK_TEMPLATES);
  if (method === "GET" && url.includes("/automations")) return json(200, []);
  if (method === "POST" && url.includes("/automations")) {
    return json(201, { id: "a1", name: "Monday SEO audit", triggerKind: "schedule", templateKey: "seo_audit", agentHandle: "scout", enabled: true, nextRunAt: new Date(Date.now() + 86_400_000).toISOString() });
  }
  return json(200, []);
}) as typeof fetch;

const anon = window.location.hash === "#login";

const api = {
  me: async () => { if (anon) throw new Error("unauthorized"); return IDENTITY; },
  login: async () => ({ ok: true }) as const,
  signup: async () => ({ ok: true }) as const,
  logout: async () => ({ ok: true }) as const,
  listChannels: async () => CHANNELS,
  createChannel: async (_w: string, name: string) => ({ id: `c_${name}`, workspaceId: "ws_demo", kind: "public" as const, name, isArchived: false }),
  listMessages: async (channelId: string) => MESSAGES.filter((m) => m.channelId === channelId),
  postMessage: async (channelId: string, body: string) => ({ id: `p${Date.now()}`, channelId, authorMemberId: "me1", parentMessageId: null, alsoSentToChannel: false, body }),
  getThread: async () => ({ root: MESSAGES[0], replies: [], replyCount: 0 }),
  postReply: async (channelId: string, rootId: string, body: string) => ({ id: `r${Date.now()}`, channelId, authorMemberId: "me1", parentMessageId: rootId, alsoSentToChannel: false, body }),
  searchMembers: async (_w: string, q: string) => ROSTER.filter((m) => m.displayName.toLowerCase().includes(q.toLowerCase())),
  listAgents: async () => ROSTER.filter((m) => m.kind === "agent").map((m) => ({ id: m.id, name: m.displayName, framework: "claude", ownerUserId: null, deactivatedAt: null, createdAt: "2026-01-01T00:00:00Z" })),
  listMyMentions: async () => [],
  approvals: {
    list: async (_w: string, status: string) => (status === "pending" ? PENDING : []),
    get: async (id: string) => PENDING.find((r) => r.id === id) ?? PENDING[0],
    events: async () => [],
    approve: async (id: string) => ({ status: "executed" as const, result: {}, request: { ...PENDING[0], id, status: "executed" as const } }),
    reject: async (id: string, reason: string) => ({ status: "rejected" as const, request: { ...PENDING[0], id, status: "rejected" as const, reason } }),
    listPolicies: async () => [],
    upsertPolicy: async () => ({ id: "p1", actionType: "external.send", requireApproval: true, maxAutoAmount: null, createdAt: "", updatedAt: "" }),
    deletePolicy: async () => ({ ok: true }) as const,
    submitAction: async () => ({ status: "pending" as const, reason: "policy", request: PENDING[0] }),
  },
  review: { listSessions: async () => [], listPullRequests: async () => [] },
  run: {},
  deploy: { status: async () => null, history: async () => [] },
} as unknown as StoreDeps["api"];

const store = createStore({ api, realtime });

function Surface(): React.JSX.Element {
  const hash = window.location.hash;
  // #165: the public landing renders standalone (no store needed) — the full workspace simulation.
  if (hash === "#landing") return <Landing />;
  if (hash === "#approvals") return <div className="workspace"><ApprovalsPanel /></div>;
  if (hash === "#pricing") {
    return (
      <div className="workspace">
        <div className="workspace__panel">
          <PricingTable plans={PLANS} current={null} onChoose={() => {}} />
        </div>
      </div>
    );
  }
  if (hash === "#login") return <App />;
  if (hash === "#bug167") {
    // #167 repro surface: the Automations form (Create validation) + a channel composer (template
    // variable prompt + Steer confirmation). Backed by the canned fetch stub above.
    return (
      <div className="workspace" style={{ display: "grid", gap: 16, padding: 16 }}>
        <AutomationsPanel />
        <div className="workspace__panel">
          <h2>Channel composer</h2>
          <p className="muted">Open Templates ▾ to fill a brief's variables; use Steer for a confirmation.</p>
          <Composer queue />
        </div>
      </div>
    );
  }
  return <Workspace />;
}

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");
// Drive the store to "ready" for the authed surfaces before first paint of those panels.
void store.bootstrap().finally(() => {
  createRoot(root).render(
    <StrictMode>
      <StoreProvider store={store}>
        <Surface />
      </StoreProvider>
    </StrictMode>,
  );
});
