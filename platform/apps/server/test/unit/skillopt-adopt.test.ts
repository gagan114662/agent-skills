import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillOptSkillDocApplier, loadVersionedSkillDoc } from "../../src/skillopt/adopt.js";

let root: string | undefined;

function writeFixture(): string {
  root = mkdtempSync(join(tmpdir(), "skillopt-adopt-"));
  mkdirSync(join(root, "scout"), { recursive: true });
  writeFileSync(
    join(root, "manifest.json"),
    JSON.stringify(
      {
        version: "1.0.0",
        agents: {
          scout: {
            skills: [{ id: "scout/runbook", kind: "runbook", path: "scout/runbook.md", version: "1.0.0" }],
          },
        },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(root, "scout/runbook.md"), "# Scout runbook\n\nStart here.\n");
  return root;
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("SkillOptSkillDocApplier", () => {
  it("appends an approved edit, bumps manifest versions, and reverts the exact block", async () => {
    const skillsRoot = writeFixture();
    const before = await loadVersionedSkillDoc("scout/runbook", skillsRoot);
    const applier = new SkillOptSkillDocApplier(skillsRoot);

    const applied = await applier.apply({
      handle: "scout",
      skillId: "scout/runbook",
      currentDocSha: before.sha,
      appendText: "## Homepage audit shortcut\nStart from the title tag.",
      requestId: "req-123",
    });

    expect(applied.executed).toBe(true);
    expect(applied.previousSha).toBe(before.sha);
    expect(applied.newSha).not.toBe(before.sha);
    expect(applied.manifestVersion).toBe("1.0.1");
    expect(applied.skillVersion).toBe("1.0.1");
    expect(applied.revertPayload).toEqual({ skillId: "scout/runbook", adoptionId: "skillopt-req-123" });
    expect(readFileSync(join(skillsRoot, "scout/runbook.md"), "utf8")).toContain("skillopt-adoption:start");
    expect(readFileSync(join(skillsRoot, "manifest.json"), "utf8")).toContain('"version": "1.0.1"');

    const reverted = await applier.revert(applied.revertPayload);

    expect(reverted.executed).toBe(true);
    expect(reverted.manifestVersion).toBe("1.0.2");
    expect(reverted.skillVersion).toBe("1.0.2");
    expect(readFileSync(join(skillsRoot, "scout/runbook.md"), "utf8")).toBe(before.text);
  });

  it("rejects adoption when the pinned doc sha is stale", async () => {
    const skillsRoot = writeFixture();
    const applier = new SkillOptSkillDocApplier(skillsRoot);

    await expect(
      applier.apply({
        handle: "scout",
        skillId: "scout/runbook",
        currentDocSha: "stale",
        appendText: "## shortcut",
        requestId: "req-123",
      }),
    ).rejects.toThrow(/changed since proposal validation/);
  });
});
