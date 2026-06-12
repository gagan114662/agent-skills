/**
 * Workspace catalog surface (#152) — the structured registry of marketing assets (sites, brand kit,
 * social accounts, email domains, ad accounts, analytics properties, ventures, deployed apps). Agents
 * read it for context; the owner curates it here. Polled + view-local (the #104 FounderPanel pattern),
 * so it stays out of the realtime store. Default-OFF on the server: every route 403s until the
 * `catalog` config is enabled, which this pane surfaces as a friendly "not enabled" state.
 */
import { useEffect, useState } from "react";
import { useAppState } from "../../store/StoreContext.js";
import { api, ApiError } from "../../api/client.js";
import type { CatalogEntryDto } from "../../api/types.js";

const KINDS = [
  "site",
  "brand_kit",
  "social_account",
  "email_domain",
  "ad_account",
  "analytics_property",
  "venture",
  "deployed_app",
  "repo",
  "other",
] as const;

function kindLabel(kind: string): string {
  return kind.replace(/_/g, " ");
}

export function CatalogPanel(): React.JSX.Element {
  const { identity } = useAppState();
  const workspaceId = identity?.workspaceId;
  const [items, setItems] = useState<CatalogEntryDto[]>([]);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [kind, setKind] = useState<string>("site");
  const [name, setName] = useState("");
  const [identifier, setIdentifier] = useState("");

  async function refresh(): Promise<void> {
    if (!workspaceId) return;
    try {
      setItems(await api.catalog.list(workspaceId));
      setDisabled(false);
    } catch (e) {
      // 403 = the catalog feature is off for this workspace; show the dark state, not an error.
      if (e instanceof ApiError && e.status === 403) setDisabled(true);
      else setError(e instanceof ApiError ? e.message : "could not load the catalog.");
    }
  }

  useEffect(() => {
    void refresh();
  }, [workspaceId]);

  async function create(): Promise<void> {
    if (!workspaceId) return;
    if (!name.trim()) return setError("Give the asset a name.");
    setError(null);
    setBusy(true);
    try {
      await api.catalog.create(workspaceId, { kind, name: name.trim(), identifier: identifier.trim() });
      setName("");
      setIdentifier("");
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "could not save the asset.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string): Promise<void> {
    if (!workspaceId) return;
    await api.catalog.remove(workspaceId, id).catch(() => {});
    await refresh();
  }

  if (disabled) {
    return (
      <div className="panel catalog-panel">
        <h2>Catalog</h2>
        <p className="panel__empty">
          The workspace catalog isn’t enabled yet. Ask your admin to turn it on to give your agents
          shared context about your sites, accounts, and ventures.
        </p>
      </div>
    );
  }

  return (
    <div className="panel catalog-panel">
      <h2>Catalog</h2>
      <p className="panel__lede">
        A shared registry of your marketing assets. Your agents read it for context instead of asking you
        the same questions twice.
      </p>

      <div className="catalog-form" role="group" aria-label="Add catalog entry">
        <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {kindLabel(k)}
            </option>
          ))}
        </select>
        <input placeholder="Name" aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          placeholder="URL or handle"
          aria-label="Identifier"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
        />
        <button className="btn" disabled={busy} onClick={() => void create()}>
          Add
        </button>
      </div>
      {error && (
        <p className="panel__error" role="alert">
          {error}
        </p>
      )}

      {items.length === 0 ? (
        <p className="panel__empty">No assets registered yet.</p>
      ) : (
        <table className="catalog-table">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Name</th>
              <th>Identifier</th>
              <th>Status</th>
              <th>Source</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.id}>
                <td>
                  <span className="catalog-kind">{kindLabel(e.kind)}</span>
                </td>
                <td>{e.name}</td>
                <td className="catalog-id">{e.identifier}</td>
                <td>{e.status}</td>
                <td>{e.provenance}</td>
                <td>
                  <button className="btn btn--ghost" aria-label={`Remove ${e.name}`} onClick={() => void remove(e.id)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
