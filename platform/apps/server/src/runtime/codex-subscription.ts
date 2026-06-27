import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  CodexSubscriptionStatus,
  CodexSubscriptionStatusProvider,
} from "../routes/team.js";

const execFileAsync = promisify(execFile);

interface DoctorCheck {
  status?: string;
  details?: Record<string, unknown>;
}

interface CodexDoctorReport {
  checks?: Record<string, DoctorCheck | undefined>;
}

export interface CodexDoctorStatusProviderOptions {
  codexBin?: string;
  authJson?: string | null;
  codexHome?: string;
  timeoutMs?: number;
  runDoctor?: () => Promise<string>;
}

function detail(check: DoctorCheck | undefined, key: string): string | undefined {
  const value = check?.details?.[key];
  return typeof value === "string" ? value : undefined;
}

function baseStatus(overrides: Partial<CodexSubscriptionStatus>): CodexSubscriptionStatus {
  return {
    connected: false,
    reason:
      "Codex subscription auth is not connected for this workspace yet. " +
      "Sign into Codex with ChatGPT subscription auth before starting the agent room.",
    selectedHarness: "codex",
    userAuthenticated: true,
    workspaceAuthenticated: true,
    runtimeAuth: "missing",
    fallback: "none",
    apiKeySatisfies: false,
    ...overrides,
  };
}

export function codexStatusFromDoctor(stdout: string): CodexSubscriptionStatus {
  let report: CodexDoctorReport;
  try {
    const parsed = JSON.parse(stdout);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return baseStatus({ reason: "Codex doctor did not return a valid JSON report object." });
    }
    report = parsed as CodexDoctorReport;
  } catch {
    return baseStatus({ reason: "Codex doctor did not return parseable JSON." });
  }

  const auth = report.checks?.["auth.credentials"];
  const websocket = report.checks?.["network.websocket_reachability"];
  const storedMode = detail(auth, "stored auth mode");
  const hasChatGptTokens = detail(auth, "stored ChatGPT tokens") === "true";
  const websocketAuthMode = detail(websocket, "auth mode");
  const providerName = detail(websocket, "provider name");

  const connected =
    auth?.status === "ok" &&
    websocket?.status === "ok" &&
    storedMode === "chatgpt" &&
    hasChatGptTokens &&
    websocketAuthMode === "chatgpt";

  if (!connected) {
    return baseStatus({
      reason:
        "Codex CLI is installed, but ChatGPT subscription auth is not usable for agent-room runs yet.",
    });
  }

  return baseStatus({
    connected: true,
    reason:
      (providerName ?? "OpenAI") +
      " ChatGPT subscription auth is ready for Codex agent runs.",
    runtimeAuth: "signed_in_subscription",
    // Deliberate: an OpenAI API key is a different billing path and never proves subscription-backed work.
    apiKeySatisfies: false,
    fallback: "none",
    userAuthenticated: true,
    workspaceAuthenticated: true,
    selectedHarness: "codex",
  });
}

function stdoutFromThrownDoctorError(err: unknown): string | null {
  if (!err || typeof err !== "object" || !("stdout" in err)) return null;
  const stdout = (err as { stdout?: unknown }).stdout;
  return typeof stdout === "string" && stdout.trim() ? stdout : null;
}

export async function materializeCodexAuthJson(
  authJson: string | null | undefined,
  codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex"),
): Promise<boolean> {
  if (!authJson) return false;
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await writeFile(join(codexHome, "auth.json"), authJson, { mode: 0o600 });
  return true;
}

export function createCodexSubscriptionStatusProvider(
  options: CodexDoctorStatusProviderOptions = {},
): CodexSubscriptionStatusProvider {
  const codexBin = options.codexBin ?? process.env.CODEX_BIN ?? "codex";
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const authJson = options.authJson ?? process.env.CODEX_AUTH_JSON ?? null;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const runDoctor =
    options.runDoctor ??
    (async () => {
      await materializeCodexAuthJson(authJson, codexHome);
      const { stdout } = await execFileAsync(codexBin, ["doctor", "--json"], {
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, CODEX_HOME: codexHome, NO_COLOR: "1" },
      });
      return stdout;
    });
  let activePromise: Promise<CodexSubscriptionStatus> | null = null;

  return {
    async status() {
      if (activePromise) return activePromise;
      activePromise = (async () => {
        try {
          return codexStatusFromDoctor(await runDoctor());
        } catch (err) {
          const stdout = stdoutFromThrownDoctorError(err);
          if (stdout) {
            const status = codexStatusFromDoctor(stdout);
            if (status.reason !== "Codex doctor did not return parseable JSON.") return status;
          }
          const reason =
            err instanceof Error && err.message.trim()
              ? "Codex subscription auth check failed: " + err.message
              : "Codex subscription auth check failed.";
          return baseStatus({ reason });
        } finally {
          activePromise = null;
        }
      })();
      return activePromise;
    },
  };
}
