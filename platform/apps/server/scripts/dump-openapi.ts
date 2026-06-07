// Regenerate the committed agent OpenAPI snapshot (#11) from the in-code source of truth.
// Run: pnpm --filter @reload/server openapi:dump
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument } from "../src/agent-interface/openapi.js";

const out = fileURLToPath(new URL("../../../docs/api/openapi.json", import.meta.url));
writeFileSync(out, JSON.stringify(buildOpenApiDocument(), null, 2) + "\n");
process.stdout.write(`wrote ${out}\n`);
