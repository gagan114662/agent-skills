import type { DiffFileStat } from "@reload/shared";

/**
 * Parse `git diff --numstat` output into per-file stats (#51). Each line is
 * `<added>\t<deleted>\t<path>`; a binary file reports `-` for both counts. Pure and total — malformed
 * lines are skipped so hostile/odd output can never throw.
 */
export function parseNumstat(text: string): DiffFileStat[] {
  const files: DiffFileStat[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [addRaw, delRaw, ...pathParts] = parts;
    const path = pathParts.join("\t");
    const binary = addRaw === "-" || delRaw === "-";
    files.push({
      path,
      additions: binary ? null : Number(addRaw),
      deletions: binary ? null : Number(delRaw),
      binary,
    });
  }
  return files;
}
