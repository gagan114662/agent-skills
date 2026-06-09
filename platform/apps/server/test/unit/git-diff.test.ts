import { describe, it, expect } from "vitest";
import { parseNumstat } from "../../src/git/diff.js";

/**
 * `git diff --numstat` parsing (#51) is pure: `<added>\t<deleted>\t<path>` per line, with `-` for a
 * binary file's counts. The diff service feeds the parsed per-file stats to the web review surface.
 */
describe("parseNumstat", () => {
  it("parses additions/deletions per file", () => {
    const out = parseNumstat("3\t1\tsrc/a.ts\n10\t0\tREADME.md\n");
    expect(out).toEqual([
      { path: "src/a.ts", additions: 3, deletions: 1, binary: false },
      { path: "README.md", additions: 10, deletions: 0, binary: false },
    ]);
  });

  it("marks binary files (git reports '-' counts) with null counts", () => {
    const out = parseNumstat("-\t-\tassets/logo.png\n");
    expect(out).toEqual([{ path: "assets/logo.png", additions: null, deletions: null, binary: true }]);
  });

  it("ignores blank lines and trims trailing newline", () => {
    expect(parseNumstat("")).toEqual([]);
    expect(parseNumstat("\n\n")).toEqual([]);
  });
});
