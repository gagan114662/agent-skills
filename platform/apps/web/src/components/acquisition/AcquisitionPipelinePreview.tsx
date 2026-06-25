import {
  buildAcquisitionPipelinePreview,
  type AcquisitionPipelinePreview as Preview,
} from "./pipeline-preview.js";

interface Props {
  readonly domain: string;
  readonly icp: string;
  readonly preview?: Preview;
}

export function AcquisitionPipelinePreview(props: Props): React.JSX.Element {
  const preview = props.preview ?? buildAcquisitionPipelinePreview({ domain: props.domain, icp: props.icp });

  return (
    <section className="pipeline-preview" aria-label="GTM workspace preview">
      <div className="pipeline-preview__head">
        <p className="pipeline-preview__eyebrow">pipeline preview</p>
        <h2>Find your first real customers</h2>
        <p>{preview.interpretation}</p>
      </div>

      <div className="pipeline-preview__grid">
        <section className="pipeline-preview__panel">
          <h3>Source plan</h3>
          <ul className="pipeline-preview__sources">
            {preview.sources.map((source) => (
              <li key={source.name}>
                <span>
                  <strong>{source.name}</strong>
                  <small>{source.category}</small>
                </span>
                <span className={`pipeline-preview__status pipeline-preview__status--${source.status}`}>
                  {source.status === "ready" ? "ready" : "not connected"}
                </span>
                <code>{source.receipt}</code>
              </li>
            ))}
          </ul>
        </section>

        <section className="pipeline-preview__panel">
          <h3>Prospects</h3>
          {preview.prospects.length === 0 ? (
            <p className="pipeline-preview__empty">
              No prospect rows yet. That is on purpose: connect a real source before ipop names companies.
            </p>
          ) : (
            <table className="pipeline-preview__table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Fit</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {preview.prospects.map((row) => (
                  <tr key={row.receipt}>
                    <td>{row.account}</td>
                    <td>{row.fit}</td>
                    <td>{row.evidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="pipeline-preview__receipt">{preview.verification.receipt}</p>
        </section>
      </div>

      <section className="pipeline-preview__panel pipeline-preview__panel--wide">
        <h3>Approval-gated next action</h3>
        <p>{preview.outreach.draft}</p>
        <p className="pipeline-preview__receipt">{preview.outreach.receipt}</p>
        <ul className="pipeline-preview__capacity" aria-label="Trial capacity">
          {preview.capacity.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <button className="btn btn--ghost" type="button" disabled>
          {preview.nextAction.label}
        </button>
      </section>
    </section>
  );
}
