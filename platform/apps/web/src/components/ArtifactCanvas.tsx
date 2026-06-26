import { useEffect, useMemo, useState } from "react";
import type { Message } from "../api/types.js";
import { authorLabel, type AppState } from "../store/store.js";

interface ArtifactBlock {
  heading: string;
  lines: string[];
}

interface ArtifactDraft {
  message: Message;
  authorName: string;
  title: string;
  blocks: ArtifactBlock[];
}

function isAgentAuthored(message: Message, state: AppState): boolean {
  return state.directory[message.authorMemberId]?.kind === "agent";
}

function looksLikeArtifact(body: string): boolean {
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.some((line) => /^#{1,3}\s+\S/.test(line))) return true;
  if (lines.some((line) => /^(subject|headline|hook|body|cta|draft|title):/i.test(line))) return true;
  return lines.length >= 4 && /\b(draft|post|email|landing page|ad|campaign)\b/i.test(body);
}

function stripMarkdownHeading(line: string): string {
  return line.replace(/^#{1,6}\s+/, "").trim();
}

export function parseArtifact(body: string): { title: string; blocks: ArtifactBlock[] } {
  const lines = body.split(/\r?\n/);
  const firstHeading = lines.find((line) => /^#\s+\S/.test(line.trim()));
  const title = firstHeading ? stripMarkdownHeading(firstHeading.trim()) : "Draft artifact";
  const blocks: ArtifactBlock[] = [];
  let current: ArtifactBlock | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#\s+\S/.test(line)) continue;
    if (/^#{2,3}\s+\S/.test(line)) {
      current = { heading: stripMarkdownHeading(line), lines: [] };
      blocks.push(current);
      continue;
    }
    const labelMatch = /^(subject|headline|hook|body|cta|draft|title):\s*(.*)$/i.exec(line);
    if (labelMatch) {
      current = { heading: labelMatch[1]!, lines: labelMatch[2] ? [labelMatch[2]!] : [] };
      blocks.push(current);
      continue;
    }
    if (!current) {
      current = { heading: "Preview", lines: [] };
      blocks.push(current);
    }
    current.lines.push(line.replace(/^[-*]\s+/, ""));
  }

  return { title, blocks: blocks.length > 0 ? blocks : [{ heading: "Preview", lines: [body] }] };
}

export function latestArtifactDraft(messages: readonly Message[], state: AppState): ArtifactDraft | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (!isAgentAuthored(message, state) || !looksLikeArtifact(message.body)) continue;
    const parsed = parseArtifact(message.body);
    return {
      message,
      authorName: authorLabel(state.directory, message.authorMemberId),
      title: parsed.title,
      blocks: parsed.blocks,
    };
  }
  return null;
}

export function ArtifactCanvas({ draft }: { draft: ArtifactDraft }): React.JSX.Element {
  const [source, setSource] = useState(draft.message.body);
  useEffect(() => setSource(draft.message.body), [draft.message.id, draft.message.body]);
  const parsed = useMemo(() => parseArtifact(source), [source]);

  return (
    <section className="artifact-canvas" aria-label="Live artifact canvas">
      <header className="artifact-canvas__head">
        <div>
          <span className="artifact-canvas__eyebrow">{draft.authorName} artifact</span>
          <h3>{parsed.title}</h3>
        </div>
        <span className="artifact-canvas__version">v1 · editable preview</span>
      </header>
      <div className="artifact-canvas__grid">
        <article className="artifact-canvas__preview">
          {parsed.blocks.map((block, index) => (
            <section className="artifact-canvas__block" key={block.heading + index}>
              <h4>{block.heading}</h4>
              {block.lines.map((line, lineIndex) => (
                <p key={lineIndex}>{line}</p>
              ))}
            </section>
          ))}
        </article>
        <label className="artifact-canvas__source">
          <span>Source</span>
          <textarea value={source} onChange={(event) => setSource(event.target.value)} />
        </label>
      </div>
    </section>
  );
}
