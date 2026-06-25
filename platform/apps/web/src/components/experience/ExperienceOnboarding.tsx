import { useMemo, useState, type FormEvent } from "react";

type ToolId = "gmail" | "social" | "site";

interface ToolStep {
  readonly id: ToolId;
  readonly label: string;
  readonly ask: string;
  readonly unavailable: string;
}

const TOOLS: readonly ToolStep[] = [
  {
    id: "gmail",
    label: "connect gmail",
    ask: "lend us your gmail for a sec? best behaviour, promise.",
    unavailable: "gmail needs a real OAuth handoff before the fleet can read or draft from it.",
  },
  {
    id: "social",
    label: "connect reddit/x",
    ask: "shall we go where your customers are already complaining?",
    unavailable: "reddit/x is not connected here yet, so no threads or replies are being invented.",
  },
  {
    id: "site",
    label: "connect site",
    ask: "give us the keys to the homepage? tiny keys. big trousers.",
    unavailable: "site publishing needs the real connections panel before rewrites can be queued.",
  },
];

export function ExperienceOnboarding(): React.JSX.Element {
  const [target, setTarget] = useState("");
  const [started, setStarted] = useState(false);
  const [requested, setRequested] = useState<ReadonlySet<ToolId>>(new Set());
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

  function requestConnection(id: ToolId): void {
    setRequested((current) => new Set([...current, id]));
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
            const asked = requested.has(tool.id);
            return (
              <article className={`experience-tool${asked ? " experience-tool--pending" : ""}`} key={tool.id}>
                <p>{tool.ask}</p>
                <button type="button" onClick={() => requestConnection(tool.id)} disabled={asked}>
                  {asked ? "needs real connection" : tool.label}
                </button>
                {asked && <strong role="status">{tool.unavailable}</strong>}
              </article>
            );
          })}
        </div>
      </section>

      <section className="experience__ship" aria-label="first deliverable">
        <p>on it. ok this one is good.</p>
        <h2>no fake replies, scraped threads, or site edits until real access is connected.</h2>
        <small>open the authenticated Connections panel to use live OAuth-backed tools.</small>
      </section>
    </main>
  );
}
