#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const MAX_FILE_BYTES = 1_500_000;
const MAX_BATCH_SIGNALS = 40;

const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".vercel",
  ".turbo",
  ".cache",
  ".pnpm-store",
]);

const EXCLUDED_FILES = new Set([
  "scripts/security-swarm.mjs",
  "docs/qa/security-threat-model.md",
  "docs/qa/security-swarm.md",
]);

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".env",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const selectors = [
  {
    id: "route-declaration",
    description: "Fastify route declarations and route-table registration points",
    patterns: [
      /\bapp\.(?:get|post|put|patch|delete)\s*\(/,
      /\bserver\.(?:get|post|put|patch|delete)\s*\(/,
      /\.route\s*\(/,
      /\bregister\([^)]*Routes\b/,
    ],
  },
  {
    id: "auth-boundary",
    description: "Authentication and tenant-boundary checks",
    patterns: [
      /\brequireIdentity\s*\(/,
      /\bassertWorkspace\s*\(/,
      /\bresolveIdentity\s*\(/,
      /\bworkspaceId\b/,
      /\bmemberId\b/,
      /\bAuthorization\b|\bBearer\b|\bcookie\b/i,
    ],
  },
  {
    id: "outbound-fetch",
    description: "Outbound HTTP calls and provider transports",
    patterns: [
      /\bfetch\s*\(/,
      /\baxios\s*\./,
      /\bgot\s*\(/,
      /\bundici\b/,
      /\brequest\s*\(/,
      /\bapiBase\b|\bbaseUrl\b|\btokenUrl\b|\bwebhookUrl\b/i,
    ],
  },
  {
    id: "ssrf-url-parse",
    description: "URL parsing, hostname validation, DNS resolution, and redirect handling",
    patterns: [
      /\bnew URL\s*\(/,
      /\.hostname\b|\bhostname\b/,
      /\bdnsLookup\b|\blookup\s*\(/,
      /\bredirect\b|\blocation\b/i,
      /\bhttp:\b|\bhttps:\b/,
      /\bisIP\s*\(/,
    ],
  },
  {
    id: "deserialization",
    description: "Structured-input parsing that may cross a trust boundary",
    patterns: [
      /\bJSON\.parse\s*\(/,
      /\byaml\.load\s*\(/,
      /\bdeserialize\s*\(/,
      /\bparse\w*\(\s*req\.(?:body|query|params)/,
      /\breadFileSync\([^)]*\)\s*as\b/,
    ],
  },
  {
    id: "dangerous-api",
    description: "Process execution or dynamic code execution surfaces",
    patterns: [
      /\bspawn\s*\(/,
      /\bexecFile\s*\(/,
      /\bexec\s*\(/,
      /\beval\s*\(/,
      /\bnew Function\s*\(/,
      /\bvm\./,
      /\bchild_process\b/,
    ],
  },
  {
    id: "secret-env",
    description: "Secrets, tokens, passwords, keys, connection strings, and env fallbacks",
    patterns: [
      /\bprocess\.env\b/,
      /\b(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|DATABASE_URL|REDIS_URL)\b/,
      /postgres(?:ql)?:\/\/|redis:\/\//i,
      /sk_(?:live|test)_|xox[baprs]-|gh[pousr]_|AAE[A-Za-z0-9_-]{20,}/,
    ],
  },
  {
    id: "approval-gate",
    description: "Approval action names and executor registration",
    patterns: [
      /\bApproval\b|\bapproval\b/,
      /\bAPPROVAL_EXECUTOR_ACTION_TYPES\b/,
      /\bmakeRecordedOnlyApproval\b/,
      /\bexternal\.send\b|\bcustomer_spend\b|\bprovisioning\.customer_spend\b/,
    ],
  },
  {
    id: "cors-origin",
    description: "CORS and browser origin controls",
    patterns: [
      /\bCORS\b|\bcors\b/,
      /\borigin\b/,
      /\bAccess-Control-Allow-Origin\b/,
      /\bPUBLIC_APP_ORIGIN\b|\bSITE_ORIGIN\b|\bAPI_BASE_URL\b/,
    ],
  },
  {
    id: "console-log",
    description: "Server-side console logging that may leak sensitive data",
    patterns: [
      /\bconsole\.(?:log|warn|error|info|debug)\s*\(/,
    ],
  },
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    const rel = path.relative(ROOT, abs).split(path.sep).join("/");
    if (entry.isDirectory()) {
      walk(abs, out);
      continue;
    }
    if (!entry.isFile()) continue;
    out.push({ abs, rel });
  }
  return out;
}

function isTextCandidate(file) {
  if (EXCLUDED_FILES.has(file.rel)) return false;
  if (file.rel.includes("/fixtures/") || file.rel.includes("/__snapshots__/")) return false;
  const ext = path.extname(file.rel);
  return TEXT_EXTENSIONS.has(ext) || file.rel.endsWith(".env.example");
}

function readText(file) {
  const stats = statSync(file.abs);
  if (stats.size > MAX_FILE_BYTES) return null;
  const buf = readFileSync(file.abs);
  if (buf.includes(0)) return null;
  return buf.toString("utf8");
}

function areaFor(rel) {
  if (rel.startsWith("platform/apps/server/")) return "platform/apps/server";
  if (rel.startsWith("platform/apps/web/")) return "platform/apps/web";
  if (rel.startsWith("platform/packages/")) return "platform/packages";
  if (rel.startsWith("platform/cli/")) return "platform/cli";
  if (rel.startsWith("platform/scripts/")) return "platform/scripts";
  if (rel.startsWith("platform/")) return "platform/other";
  if (rel.startsWith(".github/")) return ".github";
  if (rel.startsWith("scripts/")) return "scripts";
  if (rel.startsWith("skills/") || rel.startsWith("agents/") || rel.startsWith(".claude/") || rel.startsWith(".gemini/")) {
    return "agent-instructions";
  }
  return "repo-docs-config";
}

function emitSignals(file, text) {
  const signals = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const selector of selectors) {
      if (!selector.patterns.some((pattern) => pattern.test(line))) continue;
      signals.push({
        selector: selector.id,
        path: file.rel,
        line: index + 1,
        evidence: line.trim().slice(0, 240),
        area: areaFor(file.rel),
      });
    }
  }
  return signals;
}

function batchSignals(signals) {
  const byArea = new Map();
  for (const signal of signals) {
    const key = signal.area;
    if (!byArea.has(key)) byArea.set(key, []);
    byArea.get(key).push(signal);
  }

  const batches = [];
  for (const [area, areaSignals] of [...byArea.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const byFile = new Map();
    for (const signal of areaSignals) {
      if (!byFile.has(signal.path)) byFile.set(signal.path, []);
      byFile.get(signal.path).push(signal);
    }

    let current = [];
    let batchIndex = 1;
    for (const [filePath, fileSignals] of [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      void filePath;
      if (current.length > 0 && current.length + fileSignals.length > MAX_BATCH_SIGNALS) {
        batches.push({ id: area + "#" + batchIndex, area, signalCount: current.length, signals: current });
        batchIndex += 1;
        current = [];
      }
      current.push(...fileSignals);
    }
    if (current.length > 0) {
      batches.push({ id: area + "#" + batchIndex, area, signalCount: current.length, signals: current });
    }
  }
  return batches;
}

const allFiles = walk(ROOT);
const candidateFiles = allFiles.filter(isTextCandidate);
const signals = [];
let scannedFiles = 0;
let skippedLargeOrBinary = 0;

for (const file of candidateFiles) {
  const text = readText(file);
  if (text === null) {
    skippedLargeOrBinary += 1;
    continue;
  }
  scannedFiles += 1;
  signals.push(...emitSignals(file, text));
}

const matchedFiles = new Set(signals.map((signal) => signal.path));
const selectorCounts = selectors.map((selector) => ({
  id: selector.id,
  description: selector.description,
  signals: signals.filter((signal) => signal.selector === selector.id).length,
  files: new Set(signals.filter((signal) => signal.selector === selector.id).map((signal) => signal.path)).size,
}));

const batches = batchSignals(signals);

const result = {
  generatedAt: new Date().toISOString(),
  repoRoot: ROOT,
  totalFilesAfterExcludes: allFiles.length,
  textCandidateFiles: candidateFiles.length,
  scannedFiles,
  skippedLargeOrBinary,
  matchedFiles: matchedFiles.size,
  totalSignals: signals.length,
  maxBatchSignals: MAX_BATCH_SIGNALS,
  selectors: selectorCounts,
  batches,
};

process.stdout.write(JSON.stringify(result, null, 2) + "\n");
