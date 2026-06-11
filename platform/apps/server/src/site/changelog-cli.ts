/**
 * Changelog drafter CLI (#153) — `pnpm --filter @reload/server changelog:draft -- --week=YYYY-MM-DD`.
 *
 * The scheduled GitHub Action (`.github/workflows/changelog-draft.yml`) gathers the past week's merged
 * PR titles with `gh` and pipes them in (one title per line). This turns them into a release-notes draft
 * via the pure {@link draftChangelog} core and writes it as `content/site/changelog/<week>.md` with
 * `status: draft`. The Action then opens a pull request — the owner's PR approval IS the publish gate
 * (the same commit-is-truth model the rest of the repo uses): merging flips the entry to `published`.
 *
 * Pure judgement lives in `changelog.ts` (unit-tested); this file is just the IO shell (stdin + fs).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { draftChangelog, parsePrLine, type MergedPr } from "./changelog.js";
import { serializeFrontmatter } from "./frontmatter.js";
import { defaultContentRoot } from "./disk-source.js";

/** Read all of stdin (newline-delimited PR titles). Empty when nothing is piped. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function argValue(name: string): string | undefined {
  const flag = `--${name}=`;
  return process.argv.find((a) => a.startsWith(flag))?.slice(flag.length);
}

async function main(): Promise<void> {
  const week = argValue("week") ?? new Date().toISOString().slice(0, 10);
  const prs = (await readStdin())
    .split("\n")
    .map(parsePrLine)
    .filter((p): p is MergedPr => p !== null);

  const draft = draftChangelog(prs, week);
  const markdown = serializeFrontmatter(
    {
      title: draft.title,
      slug: draft.slug,
      description: draft.summary,
      kind: "changelog",
      agent: draft.agent,
      date: week,
      // Drafted, NOT published — the publish gate (the PR review) flips this to `published`.
      status: "draft",
      order: "1",
    },
    draft.body,
  );

  const dir = join(defaultContentRoot(), "changelog");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${draft.slug}.md`);
  await writeFile(path, markdown, "utf8");
  process.stdout.write(`${path}\n`);
}

main().catch((err) => {
  console.error("changelog:draft failed:", err);
  process.exit(1);
});
