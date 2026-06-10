import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedConfig } from "../config/schema.js";
import { loadConfig } from "../config/loader.js";
import { egressAllowed } from "../config/egress.js";
import type { WorkspaceProvisioner } from "../config/workspace.js";
import type { SecretsResolver } from "../runtime/secrets-resolver.js";
import { makeRedactor } from "../runtime/redact.js";
import type { ChannelPoster, SessionLogger } from "../runtime/manager.js";
import { publishDeployEvent } from "../realtime/bus.js";
import type { DeployLogEvent, DeployStatusEvent } from "../realtime/protocol.js";
import type {
  CreateDeploymentInput,
  Deployment,
  UpdateDeploymentFields,
} from "../db/repositories/deployments.js";
import { detectStack, type DetectInput, type ParsedManifest } from "./detect.js";
import type { DeployProvider, ScaleInput } from "./provider.js";

/**
 * DeployManager (#73) — takes a finished session's app to a live URL through a swappable
 * `DeployProvider`. It is **separate** from both the `SessionManager` (which finalizes a harness run)
 * and the `RunProcessManager` (an ephemeral local dev server): a deploy is a durable one-shot job whose
 * live URL must survive a restart, so it **persists** to the `deployments` table. Every dependency is
 * an injectable with a real default — tests inject a fake provider + in-memory store for zero spend.
 *
 * Security invariants (ADR-0041): a cloud deploy is off-platform egress, so it is refused under
 * data-privacy mode; provider credentials are resolved per tenant via the secrets resolver and every
 * streamed/persisted log line, error, and channel message is passed through the secret redactor.
 */

/** The injectable persistence seam (the DB store in prod; an in-memory store in unit tests). */
export interface DeploymentStore {
  create(input: CreateDeploymentInput): Promise<Deployment>;
  update(id: string, fields: UpdateDeploymentFields): Promise<Deployment>;
  get(id: string, channelId: string): Promise<Deployment | undefined>;
  latestForSession(sessionId: string, channelId: string): Promise<Deployment | undefined>;
  listForSession(sessionId: string, channelId: string): Promise<Deployment[]>;
}

/** Thrown when the tenant hasn't enabled deploy (no `deploy` config section) → route 409. */
export class NoDeployConfigError extends Error {
  constructor() {
    super("no deploy configuration");
    this.name = "NoDeployConfigError";
  }
}

/** Thrown when data-privacy mode forbids the off-platform egress a deploy requires → route 409. */
export class DeployEgressBlocked extends Error {
  constructor() {
    super("deploy blocked by data-privacy mode");
    this.name = "DeployEgressBlocked";
  }
}

/** Thrown when a rollback is requested but there is no prior good deployment → route 409. */
export class NoRollbackTargetError extends Error {
  constructor() {
    super("no prior deployment to roll back to");
    this.name = "NoRollbackTargetError";
  }
}

export interface DeployRequest {
  sessionId: string;
  workspaceId: string;
  channelId: string;
  /** The session's agent member — the deploy announcement is posted as it. */
  agentMemberId: string;
  /** The human who triggered the deploy (audit + who health alerts are posted on behalf of). */
  createdByMemberId: string;
  /** Why this deploy ran (`deploy` default | `push`). */
  reason?: string;
}

/** Reads the app-root manifest + file list for stack detection (injectable for hermetic tests). */
export type ManifestReader = (cwd: string | undefined) => Promise<DetectInput>;

export interface DeployManagerDeps {
  provider: DeployProvider;
  store: DeploymentStore;
  poster: ChannelPoster;
  provisioner: WorkspaceProvisioner;
  secrets: SecretsResolver;
  loadConfig?: (workspaceId: string) => ResolvedConfig;
  publish?: (channelId: string, event: DeployStatusEvent | DeployLogEvent) => void;
  readManifest?: ManifestReader;
  logger?: SessionLogger;
  maxLogLines?: number;
}

const DEFAULT_MAX_LOG_LINES = 200;

/** Default manifest reader: best-effort read of `package.json` + the app-root file listing. */
const defaultReadManifest: ManifestReader = async (cwd) => {
  if (!cwd) return { packageJson: null, files: [] };
  let files: string[] = [];
  try {
    files = await readdir(cwd);
  } catch {
    /* no dir → no files */
  }
  let packageJson: ParsedManifest | null = null;
  try {
    packageJson = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as ParsedManifest;
  } catch {
    /* no/invalid package.json → null */
  }
  return { packageJson, files };
};

export class DeployManager {
  private readonly provider: DeployProvider;
  private readonly store: DeploymentStore;
  private readonly poster: ChannelPoster;
  private readonly provisioner: WorkspaceProvisioner;
  private readonly secrets: SecretsResolver;
  private readonly load: (workspaceId: string) => ResolvedConfig;
  private readonly publish: (channelId: string, event: DeployStatusEvent | DeployLogEvent) => void;
  private readonly readManifest: ManifestReader;
  private readonly logger?: SessionLogger;
  private readonly maxLogLines: number;

  constructor(deps: DeployManagerDeps) {
    this.provider = deps.provider;
    this.store = deps.store;
    this.poster = deps.poster;
    this.provisioner = deps.provisioner;
    this.secrets = deps.secrets;
    this.load = deps.loadConfig ?? ((workspaceId) => loadConfig(workspaceId));
    this.publish =
      deps.publish ??
      ((channelId, event) => {
        publishDeployEvent(channelId, event).catch(() => {
          /* best-effort realtime; the deployments row is the source of truth */
        });
      });
    this.readManifest = deps.readManifest ?? defaultReadManifest;
    this.logger = deps.logger;
    this.maxLogLines = deps.maxLogLines ?? DEFAULT_MAX_LOG_LINES;
  }

  /** Build + deploy the session's app to a live URL. Throws on opt-out / privacy mode (route → 409). */
  async deploy(req: DeployRequest): Promise<Deployment> {
    const cfg = this.gate(req.workspaceId);
    const secrets = await this.secrets.resolve(req.workspaceId);
    const redact = makeRedactor(secrets);

    const prepared = await this.provisioner.prepare({
      sessionId: req.sessionId,
      workspaceId: req.workspaceId,
    });
    const manifest = await this.readManifest(prepared.cwd);
    const stack = detectStack(cfg.deploy, manifest);

    const row = await this.store.create({
      workspaceId: req.workspaceId,
      channelId: req.channelId,
      sessionId: req.sessionId,
      provider: this.provider.kind,
      status: "building",
      framework: stack.framework,
      reason: req.reason ?? "deploy",
      createdByMemberId: req.createdByMemberId,
    });
    this.emitStatus(row);

    const logs: string[] = [];
    const onLog = (line: string): void => {
      const safe = redact(line);
      logs.push(safe);
      if (logs.length > this.maxLogLines) logs.shift();
      this.publish(req.channelId, {
        type: "deploy_log",
        sessionId: req.sessionId,
        channelId: req.channelId,
        deploymentId: row.id,
        chunk: safe,
      });
    };

    const outcome = await this.provider.deploy({
      deploymentId: row.id,
      workspaceId: req.workspaceId,
      sessionId: req.sessionId,
      slug: this.slug(req),
      cwd: prepared.cwd,
      stack,
      env: this.buildEnv(cfg, secrets),
      secrets,
      onLog,
    });

    if (outcome.status === "ready" && outcome.url) {
      const updated = await this.store.update(row.id, {
        status: "ready",
        url: outcome.url,
        providerDeploymentId: outcome.providerDeploymentId ?? null,
        logs,
      });
      this.emitStatus(updated);
      await this.post(req.workspaceId, req.channelId, req.agentMemberId, `✅ Deployed to ${outcome.url}`);
      return updated;
    }

    const error = redact(outcome.error ?? "deploy failed");
    const updated = await this.store.update(row.id, { status: "error", error, logs });
    this.emitStatus(updated);
    this.logger?.warn({ deploymentId: row.id, error }, "deploy failed");
    return updated;
  }

  /** Re-promote the prior good deployment (rollback / provider-backed backups). */
  async rollback(req: DeployRequest): Promise<Deployment> {
    this.gate(req.workspaceId);
    const history = await this.store.listForSession(req.sessionId, req.channelId);
    const readies = history.filter((d) => d.status === "ready" && d.url && d.providerDeploymentId);
    const target = readies[1]; // [0] is the current live deployment; [1] is the prior good one.
    if (!target) throw new NoRollbackTargetError();

    const outcome = await this.provider.rollback({
      providerDeploymentId: target.providerDeploymentId!,
      url: target.url!,
    });
    const row = await this.store.create({
      workspaceId: req.workspaceId,
      channelId: req.channelId,
      sessionId: req.sessionId,
      provider: this.provider.kind,
      status: "rolled_back",
      framework: target.framework,
      reason: "rollback",
      rolledBackFromId: target.id,
      createdByMemberId: req.createdByMemberId,
    });
    const updated = await this.store.update(row.id, {
      status: "rolled_back",
      url: outcome.url ?? target.url,
      providerDeploymentId: outcome.providerDeploymentId ?? target.providerDeploymentId,
    });
    this.emitStatus(updated);
    await this.post(req.workspaceId, req.channelId, req.agentMemberId, `↩️ Rolled back to ${updated.url}`);
    return updated;
  }

  /**
   * Probe a deployment's health; on failure, auto-restart and re-check. Returns the (possibly updated)
   * row: still `ready` if it recovered, `unhealthy` (with a posted report) if a restart couldn't fix it.
   */
  async checkHealth(deployment: Deployment): Promise<Deployment> {
    if (deployment.status !== "ready" || !deployment.url || !deployment.providerDeploymentId) {
      return deployment;
    }
    const first = await this.provider.healthCheck(deployment.url);
    if (first.healthy) return deployment;

    await this.provider.restart(deployment.providerDeploymentId);
    const after = await this.provider.healthCheck(deployment.url);
    if (after.healthy) {
      this.emitStatus(deployment); // recovered — still ready
      return deployment;
    }

    const secrets = await this.secrets.resolve(deployment.workspaceId);
    const detail = makeRedactor(secrets)(after.detail ?? "health check failed");
    const updated = await this.store.update(deployment.id, { status: "unhealthy", error: detail });
    this.emitStatus(updated);
    if (deployment.createdByMemberId) {
      await this.post(
        deployment.workspaceId,
        deployment.channelId,
        deployment.createdByMemberId,
        `⚠️ Deployment ${deployment.url} is unhealthy: ${detail}`,
      );
    }
    return updated;
  }

  /** Scale a deployment, clamped to the tenant's configured `maxInstances` (default 1). */
  async scale(deployment: Deployment, scale: ScaleInput): Promise<void> {
    if (!deployment.providerDeploymentId) return;
    const cfg = this.load(deployment.workspaceId);
    const max = cfg.deploy?.maxInstances ?? 1;
    const clamped: ScaleInput = { size: scale.size };
    if (scale.instances !== undefined) clamped.instances = Math.max(1, Math.min(scale.instances, max));
    await this.provider.scale(deployment.providerDeploymentId, clamped);
  }

  /** The latest deployment for a session (channel-scoped), or null. */
  get(sessionId: string, channelId: string): Promise<Deployment | undefined> {
    return this.store.latestForSession(sessionId, channelId);
  }

  /** Deployment history for a session (channel-scoped), newest first. */
  list(sessionId: string, channelId: string): Promise<Deployment[]> {
    return this.store.listForSession(sessionId, channelId);
  }

  // --- internals ---

  /** Enforce the opt-in + egress invariants common to deploy/rollback. Returns the resolved config. */
  private gate(workspaceId: string): ResolvedConfig {
    const cfg = this.load(workspaceId);
    if (!cfg.deploy) throw new NoDeployConfigError();
    if (!egressAllowed(cfg)) throw new DeployEgressBlocked();
    return cfg;
  }

  /** Non-secret build env from config's pass-through NAMES; values come only from resolved secrets. */
  private buildEnv(cfg: ResolvedConfig, secrets: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of cfg.deploy?.env ?? []) {
      if (secrets[name] !== undefined) env[name] = secrets[name];
    }
    return env;
  }

  private slug(req: DeployRequest): string {
    // A stable, URL-ish slug for the dry-run URL; the real provider uses its own project naming.
    return req.sessionId.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();
  }

  private emitStatus(row: Deployment): void {
    this.publish(row.channelId, {
      type: "deploy_status",
      sessionId: row.sessionId,
      channelId: row.channelId,
      deploymentId: row.id,
      status: row.status,
      url: row.url,
      error: row.error,
    });
  }

  private async post(
    workspaceId: string,
    channelId: string,
    agentMemberId: string,
    body: string,
  ): Promise<void> {
    try {
      await this.poster.post({ workspaceId, channelId, agentMemberId, body });
    } catch (err) {
      this.logger?.warn({ channelId, err }, "deploy channel post failed");
    }
  }
}
