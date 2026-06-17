/**
 * The #300 read-only sample workspace (ADR-0300) — the low-commitment front door.
 *
 * Rendered at `/sample` (public, before the AuthGate phase gates). It fetches the unauthenticated
 * `/sample/console` endpoint so a prospect can see at least one REAL agent deliverable with NO account
 * and NO Google data scope — the alternative to the broad-scope OAuth wall at `/start`. It is read-only:
 * it shows what the fleet produces and links back to sign-in, but it can take no action. Default OFF: when
 * the deployment hasn't enabled the sample workspace the endpoint answers `{ offered: false }` and we show
 * an honest "not switched on yet" (#200 §3 — never a faked demo).
 */
import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import type { SampleConsoleDto } from "../api/types.js";
import { BRAND, SAMPLE } from "../brand.js";
import { Link } from "../routing.js";
import { Wordmark } from "./Wordmark.js";
import { PopMark } from "./PopMark.js";

type Load = { state: "loading" } | { state: "off" } | { state: "ready"; console: SampleConsoleDto };

export function SampleConsole(): React.JSX.Element {
  const [load, setLoad] = useState<Load>({ state: "loading" });

  useEffect(() => {
    let live = true;
    void api
      .getSampleConsole()
      .then((res) => {
        if (!live) return;
        // `offered:false` (flag off) OR a missing console both degrade to the honest "not switched on" state.
        if (res.offered && res.console) setLoad({ state: "ready", console: res.console });
        else setLoad({ state: "off" });
      })
      .catch(() => {
        // API unreachable / not wired — degrade honestly rather than crash on the public front door.
        if (live) setLoad({ state: "off" });
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="sample">
      <header className="sample__head">
        <a href="/" className="sample__brand" aria-label={BRAND.name}>
          <Wordmark />
        </a>
        <span className="sample__badge">{SAMPLE.badge}</span>
        <Link href="/start" className="btn btn--primary sample__back">
          {SAMPLE.back}
        </Link>
      </header>

      <div className="sample__intro">
        <h1>{SAMPLE.title}</h1>
        <p>{SAMPLE.sub}</p>
      </div>

      {load.state === "loading" && (
        <p className="sample__loading" role="status">
          {SAMPLE.loading}
        </p>
      )}

      {load.state === "off" && (
        <div className="sample__empty">
          <PopMark />
          <p>{SAMPLE.empty}</p>
          <Link href="/start" className="linklike">
            {SAMPLE.back}
          </Link>
        </div>
      )}

      {load.state === "ready" && (
        <ul className="sample__cards" aria-label={load.console.workspaceLabel}>
          {load.console.deliverables.map((d) => (
            <li key={d.id} className="sample__card">
              <div className="sample__card-meta">
                <span className="sample__card-agent">{d.agent}</span>
                <span className="sample__card-dept">{d.department}</span>
              </div>
              <h2 className="sample__card-title">{d.title}</h2>
              <p className="sample__card-preview">{d.preview}</p>
              <pre className="sample__card-body">{d.body}</pre>
              <p className="sample__card-consequence">{SAMPLE.consequence}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
