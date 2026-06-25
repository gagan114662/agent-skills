import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, normalize, relative } from "node:path";
import { ActionExecutionError } from "../approvals/executor.js";

export interface SkillDocSnapshot {
  sha: string;
  text: string;
}

export interface SkillOptAdoptInput {
  handle: string;
  skillId: string;
  currentDocSha: string;
  appendText: string;
  requestId: string;
}

export interface SkillOptRevertInput {
  skillId: string;
  adoptionId: string;
}

export interface SkillOptApplyResult {
  executed: true;
  skillId: string;
  path: string;
  previousSha: string;
  newSha: string;
  manifestVersion: string;
  skillVersion: string;
  adoptionId: string;
  revertPayload: SkillOptRevertInput;
}

export interface SkillOptRevertResult {
  executed: true;
  skillId: string;
  path: string;
  previousSha: string;
  newSha: string;
  manifestVersion: string;
  skillVersion: string;
  adoptionId: string;
}

interface SkillManifest {
  version?: string;
  agents?: Record<string, { skills?: Array<{ id?: string; path?: string; version?: string }> }>;
}

interface SkillEntry {
  agentHandle: string;
  path: string;
  version: string;
  entry: { id?: string; path?: string; version?: string };
}

const START_PREFIX = "<!-- skillopt-adoption:start ";
const END_MARKER = "<!-- skillopt-adoption:end -->";

export function defaultSkillsRoot(): string {
  return process.env.SKILLOPT_SKILLS_ROOT ?? join(process.cwd(), "agents/skills");
}

export function skillDocSha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function bumpPatch(version: string | undefined): string {
  const parts = (version ?? "0.0.0").split(".").map((p) => Number.parseInt(p, 10));
  const intAt = (idx: number): number => {
    const n = parts[idx] ?? 0;
    return Number.isFinite(n) ? n : 0;
  };
  return [intAt(0), intAt(1), intAt(2) + 1].join(".");
}

function assertInside(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel.startsWith("..") || rel === "" || rel.split(/[\\/]/).includes("..")) {
    throw new ActionExecutionError("skill path escapes skills root");
  }
}

async function readManifest(root: string): Promise<{ manifest: SkillManifest; manifestPath: string }> {
  const manifestPath = join(root, "manifest.json");
  const raw = await readFile(manifestPath, "utf8");
  return { manifest: JSON.parse(raw) as SkillManifest, manifestPath };
}

function findSkill(manifest: SkillManifest, skillId: string): SkillEntry {
  for (const [agentHandle, agent] of Object.entries(manifest.agents ?? {})) {
    for (const entry of agent.skills ?? []) {
      if (entry.id === skillId && entry.path) {
        return {
          agentHandle,
          path: entry.path,
          version: entry.version ?? "0.0.0",
          entry,
        };
      }
    }
  }
  throw new ActionExecutionError("skill not found in manifest: " + skillId);
}

function adoptionIdFor(requestId: string): string {
  return "skillopt-" + requestId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}

function renderBlock(adoptionId: string, requestId: string, appendText: string): string {
  return [
    START_PREFIX + `adoptionId="${adoptionId}" requestId="${requestId}" -->`,
    appendText.trim(),
    END_MARKER,
  ].join("\n");
}

function removeBlock(text: string, adoptionId: string): string | null {
  const start = text.indexOf(START_PREFIX + `adoptionId="${adoptionId}"`);
  if (start < 0) return null;
  const end = text.indexOf(END_MARKER, start);
  if (end < 0) throw new ActionExecutionError("skill adoption block is missing its end marker");
  const afterEnd = end + END_MARKER.length;
  const next = text.slice(0, start).replace(/\s+$/, "\n") + text.slice(afterEnd).replace(/^\s*/, "\n");
  return next.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "\n");
}

export async function loadVersionedSkillDoc(
  skillId: string,
  root: string = defaultSkillsRoot(),
): Promise<SkillDocSnapshot> {
  const { manifest } = await readManifest(root);
  const skill = findSkill(manifest, skillId);
  const docPath = normalize(join(root, skill.path));
  assertInside(root, docPath);
  const text = await readFile(docPath, "utf8");
  return { sha: skillDocSha(text), text };
}

export class SkillOptSkillDocApplier {
  constructor(private readonly root: string = defaultSkillsRoot()) {}

  async apply(input: SkillOptAdoptInput): Promise<SkillOptApplyResult> {
    const { manifest, manifestPath } = await readManifest(this.root);
    const skill = findSkill(manifest, input.skillId);
    if (skill.agentHandle !== input.handle) {
      throw new ActionExecutionError("skillId does not belong to handle " + input.handle);
    }
    const docPath = normalize(join(this.root, skill.path));
    assertInside(this.root, docPath);
    const before = await readFile(docPath, "utf8");
    const previousSha = skillDocSha(before);
    if (previousSha !== input.currentDocSha) {
      throw new ActionExecutionError("skill doc changed since proposal validation");
    }
    const adoptionId = adoptionIdFor(input.requestId);
    if (before.includes(START_PREFIX + `adoptionId="${adoptionId}"`)) {
      throw new ActionExecutionError("skill adoption already applied");
    }

    const next = before.replace(/\s+$/, "") + "\n\n" + renderBlock(adoptionId, input.requestId, input.appendText) + "\n";
    skill.entry.version = bumpPatch(skill.version);
    manifest.version = bumpPatch(manifest.version);
    await writeFile(docPath, next, "utf8");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

    return {
      executed: true,
      skillId: input.skillId,
      path: skill.path,
      previousSha,
      newSha: skillDocSha(next),
      manifestVersion: manifest.version,
      skillVersion: skill.entry.version,
      adoptionId,
      revertPayload: { skillId: input.skillId, adoptionId },
    };
  }

  async revert(input: SkillOptRevertInput): Promise<SkillOptRevertResult> {
    const { manifest, manifestPath } = await readManifest(this.root);
    const skill = findSkill(manifest, input.skillId);
    const docPath = normalize(join(this.root, skill.path));
    assertInside(this.root, docPath);
    const before = await readFile(docPath, "utf8");
    const next = removeBlock(before, input.adoptionId);
    if (next === null) throw new ActionExecutionError("skill adoption block not found");

    skill.entry.version = bumpPatch(skill.version);
    manifest.version = bumpPatch(manifest.version);
    await writeFile(docPath, next, "utf8");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

    return {
      executed: true,
      skillId: input.skillId,
      path: skill.path,
      previousSha: skillDocSha(before),
      newSha: skillDocSha(next),
      manifestVersion: manifest.version,
      skillVersion: skill.entry.version,
      adoptionId: input.adoptionId,
    };
  }
}
