/**
 * Renders the server's typed markdown blocks (#153) to React elements. The server never sends HTML — it
 * sends a discriminated union of blocks with inline runs — so this component maps blocks to elements
 * with no `dangerouslySetInnerHTML` anywhere. Agent-authored content therefore can't inject markup.
 */
import type { SiteBlock, SiteInline } from "../../api/types.js";

function Inline({ runs }: { runs: SiteInline[] }): React.JSX.Element {
  return (
    <>
      {runs.map((run, i) => {
        if (run.type === "strong") return <strong key={i}>{run.text}</strong>;
        if (run.type === "link")
          return (
            <a key={i} href={run.href} target="_blank" rel="noopener noreferrer">
              {run.text}
            </a>
          );
        return <span key={i}>{run.text}</span>;
      })}
    </>
  );
}

export function Markdown({ blocks }: { blocks: SiteBlock[] }): React.JSX.Element {
  return (
    <div className="md">
      {blocks.map((block, i) => {
        switch (block.type) {
          case "heading": {
            const Tag = (`h${block.level + 1}` as "h2" | "h3" | "h4");
            return (
              <Tag key={i} className="md__heading">
                <Inline runs={block.inline} />
              </Tag>
            );
          }
          case "paragraph":
            return (
              <p key={i} className="md__p">
                <Inline runs={block.inline} />
              </p>
            );
          case "list":
            return block.ordered ? (
              <ol key={i} className="md__list">
                {block.items.map((item, j) => (
                  <li key={j}>
                    <Inline runs={item} />
                  </li>
                ))}
              </ol>
            ) : (
              <ul key={i} className="md__list">
                {block.items.map((item, j) => (
                  <li key={j}>
                    <Inline runs={item} />
                  </li>
                ))}
              </ul>
            );
          case "quote":
            return (
              <blockquote key={i} className="md__quote">
                <Inline runs={block.inline} />
              </blockquote>
            );
          case "code":
            return (
              <pre key={i} className="md__code">
                <code>{block.text}</code>
              </pre>
            );
          case "table":
            return (
              <div key={i} className="md__table-wrap">
                <table className="md__table">
                  <thead>
                    <tr>
                      {block.header.map((cell, j) => (
                        <th key={j}>
                          <Inline runs={cell} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, c) => (
                          <td key={c}>
                            <Inline runs={cell} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </div>
  );
}
