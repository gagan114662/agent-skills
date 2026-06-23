/**
 * A dependency-free unified-diff renderer (#51). It classifies each line of `git diff` output —
 * file/hunk headers, additions, deletions, context — and colors them, so the agent's changes are
 * reviewable without a heavyweight diff library. Per-file stats render above the patch.
 */
import type { DiffFileStat } from "@reload/shared";
import { CopyButton } from "../CopyButton.js";

type LineKind = "meta" | "hunk" | "add" | "del" | "context";

function classify(line: string): LineKind {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) {
    return "meta";
  }
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

export function DiffView({
  patch,
  files,
}: {
  patch: string;
  files: DiffFileStat[];
}): React.JSX.Element {
  if (!patch.trim()) {
    return <p className="diff__empty">No changes on this branch yet.</p>;
  }
  const lines = patch.replace(/\n$/, "").split("\n");
  return (
    <div className="diff">
      <div className="copyblock__head diff__head">
        <ul className="diff__files" aria-label="Changed files">
          {files.map((f) => (
            <li key={f.path} className="diff__file">
              <span className="diff__file-path">{f.path}</span>
              {f.binary ? (
                <span className="diff__file-bin">binary</span>
              ) : (
                <span className="diff__file-stat">
                  <span className="diff__add">+{f.additions ?? 0}</span>{" "}
                  <span className="diff__del">-{f.deletions ?? 0}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
        <CopyButton text={patch} />
      </div>
      <pre className="diff__patch" aria-label="Unified diff">
        {lines.map((line, i) => {
          const kind = classify(line);
          return (
            <span key={i} className={`diff__line diff__line--${kind}`} data-kind={kind}>
              {line || " "}
              {"\n"}
            </span>
          );
        })}
      </pre>
    </div>
  );
}
