import { useMemo, useState, type FormEvent } from "react";

type ToolId = "gmail" | "social" | "site";

interface ToolStep {
  readonly id: ToolId;
  readonly label: string;
  readonly ask: string;
  readonly result: string;
}

const TOOLS: readonly ToolStep[] = [
  {
    id: "gmail",
    label: "allow gmail",
    ask: "lend us your gmail for a sec? best behaviour, promise.",
    result: "drafted a reply to a warm lead. polite, useful, suspiciously good.",
  },
  {
    id: "social",
    label: "allow reddit/x",
    ask: "shall we go where your customers are already complaining?",
    result: "found 3 threads where you can genuinely help. drafts are ready.",
  },
  {
    id: "site",
    label: "allow site",
    ask: "give us the keys to the homepage? tiny keys. big trousers.",
    result: "rewrote the hero and parked it for approval. no rogue publishing.",
  },
];

export function ExperienceOnboarding(): React.JSX.Element {
  const [target, setTarget] = useState("");
  const [started, setStarted] = useState(false);
  const [connected, setConnected] = useState<ReadonlySet<ToolId>>(new Set());
  const [shipped, setShipped] = useState(false);
  const trimmed = target.trim();

  const findings = useMemo(
    () => [
      "scout is nosing through your site. we won't judge. much.",
      trimmed ? `quill found the sharp bit: ${trimmed} needs one obvious promise.` : "quill found the sharp bit.",
      "comet spotted a route to the first ten people who might actually care.",
    ],
    [trimmed],
  );

  function submit(e: FormEvent): void {
    e.preventDefault();
    if (!trimmed) return;
    setStarted(true);
  }

  function connect(id: ToolId): void {
    setConnected((current) => new Set([...current, id]));
  }

  if (!started) {
    return (
      <main className="experience-door" aria-label="ipop onboarding">
        <form className="experience-door__form" onSubmit={submit}>
          <p className="experience-door__hello">afternoon, gagan.</p>
          <h1>right then - what are we making pop today?</h1>
          <label className="experience-door__field">
            <span>what are we marketing today?</span>
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="drop a product, site, or deeply chaotic idea"
              autoFocus
            />
          </label>
          <button type="submit" disabled={!trimmed}>
            wake the fleet
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="experience" aria-label="ipop guided onboarding">
      <section className="experience__thread">
        <p className="experience__kicker">first run</p>
        <h1>{target}</h1>
        <div className="experience-feed" aria-label="agent findings">
          {findings.map((finding) => (
            <article key={finding} className="experience-msg">
              <span aria-hidden="true" />
              <p>{finding}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="experience__tools" aria-label="guided connections">
        <h2>plug in the bits that make it real</h2>
        <div className="experience-tools">
          {TOOLS.map((tool) => {
            const done = connected.has(tool.id);
            return (
              <article className={`experience-tool${done ? " experience-tool--done" : ""}`} key={tool.id}>
                <p>{tool.ask}</p>
                <button type="button" onClick={() => connect(tool.id)} disabled={done}>
                  {done ? "allowed" : tool.label}
                </button>
                {done && <strong>{tool.result}</strong>}
              </article>
            );
          })}
        </div>
      </section>

      <section className="experience__ship" aria-label="first deliverable">
        <p>on it. ok this one is good.</p>
        <h2>homepage rewrite plus three warm replies, queued and waiting for your say-so.</h2>
        {connected.size < TOOLS.length ? (
          <small>connect the three bits above and we will queue the first proper ship.</small>
        ) : shipped ? (
          <strong role="status">shipped. quietly heroic, honestly.</strong>
        ) : (
          <div className="experience__actions">
            <button type="button" onClick={() => setShipped(true)}>
              ship it
            </button>
            <button type="button" className="experience__secondary">
              nah, redo
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
