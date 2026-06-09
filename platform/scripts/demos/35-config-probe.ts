/**
 * Config-layering probe for the #58 demo. Resolves the layered config (env < user < repo < managed)
 * for an optional workspace id and prints the result as one JSON line. Layer file paths come from the
 * RELOAD_*_CONFIG env vars the demo sets, so the same binary shows precedence, the managed lock, and
 * the per-tenant managed override just by varying inputs.
 *
 *   tsx scripts/demos/35-config-probe.ts [workspaceId]
 */
import { loadConfig } from "../../apps/server/src/config/loader.js";
import { egressAllowed } from "../../apps/server/src/config/egress.js";

const workspaceId = process.argv[2] || undefined;
const cfg = loadConfig(workspaceId);
process.stdout.write(JSON.stringify({ workspaceId: workspaceId ?? null, ...cfg, egressAllowed: egressAllowed(cfg) }) + "\n");
