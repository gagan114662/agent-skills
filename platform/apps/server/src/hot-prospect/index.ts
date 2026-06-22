/**
 * Hot-prospect alerting (issue #622) — module barrel: import everything from here.
 *
 * The problem #622 fixes: a prospect's highest-intent moment ("visited pricing 3x today") passes unnoticed and
 * the outreach agent reaches out late. The shape of the fix in code, end to end:
 *
 *   1. Build the service over its seams (or use the prod factory in `./default.js`):
 *        const svc = new HotProspectService({ source, store: new InMemoryAlertStore(), gate });
 *   2. Scan a workspace — detects threshold crossings, queues a tailored follow-up, PARKS the notification:
 *        const { alerts } = await svc.scan(workspaceId);
 *        // each alert: .reason (why), .followUp (the tailored draft), .approvalRequestId (the gate it's behind)
 *   3. Nothing is sent. The outbound notification only goes out when a human approves the parked request.
 *
 * Default **OFF and inert** (`HOT_PROSPECT_ALERTING_ENABLED` unset/0): scans return no alerts and send nothing.
 *
 * Self-contained, parallel-merge-safe (no migration, no schema barrel, no app-wiring registry, no web UI) —
 * the same conflict-free shape as #611 lead-scoring, #674 content-guard, #670 budget-governor, #585
 * memory-graph.
 *
 * This barrel deliberately does NOT re-export the Postgres binding (`PgAlertStore` /
 * `createDefaultHotProspectService`): that lives in `./default.js` and pulls in the `pg` pool, so it is
 * imported only by the (future) route wiring. Keeping the barrel free of the DB dependency means any module or
 * test can import the detector + service + in-memory store without standing up Postgres.
 */

export * from "./types.js";
export {
  detectIntent,
} from "./detect.js";
export {
  buildAlert,
  buildFollowUp,
  DEFAULT_ROUTES,
} from "./alert.js";
export {
  resolveHotProspectPolicy,
  DEFAULT_INTENT_RULES,
  HOT_PROSPECT_DEFAULTS,
  type HotProspectPolicy,
  type IntentRule,
} from "./caps.js";
export {
  FixtureSignalSource,
  simulateHighIntent,
  type SignalSource,
} from "./source.js";
export {
  RecordingApprovalGate,
  RecordingNotifier,
  type ApprovalGate,
  type AlertNotifier,
  type NotificationRequest,
  type NotificationReceipt,
  type ParkedApproval,
  type PendingNotification,
} from "./notify.js";
export {
  InMemoryAlertStore,
  type AlertStore,
  type AlertRecord,
  type NewAlertRecord,
} from "./store.js";
export {
  HotProspectService,
  type HotProspectDeps,
  type RaisedAlert,
  type ScanResult,
} from "./service.js";
