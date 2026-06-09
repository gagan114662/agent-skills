import {
  IssueProviderError,
  type IssueContext,
  type IssueProvider,
  type IssueRef,
} from "./types.js";
import type { IssueProviderDeps } from "./github.js";

/** GraphQL to resolve an issue by team key + number (a Linear identifier like `ENG-123`). */
const FETCH_QUERY = `query Issue($team: String!, $number: Float!) {
  issues(filter: { team: { key: { eq: $team } }, number: { eq: $number } }, first: 1) {
    nodes { id identifier title description url state { name } labels { nodes { name } } }
  }
}`;

const COMMENT_MUTATION = `mutation Comment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) { comment { url } }
}`;

interface LinearNode {
  id: string;
  identifier: string;
  title?: string;
  description?: string | null;
  url?: string;
  state?: { name?: string };
  labels?: { nodes?: Array<{ name?: string }> };
}

/**
 * Linear issue provider (#57). Linear has no per-repo issues endpoint, so we resolve the identifier
 * (`ENG-123` → team `ENG`, number `123`) through the GraphQL `issues` filter. The API key (resolved
 * per-tenant from the #25 `SecretsResolver`) goes in the `Authorization` header verbatim — Linear does
 * NOT use a `Bearer` prefix — and is never logged.
 */
export class LinearIssueProvider implements IssueProvider {
  readonly source = "linear" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;

  constructor(deps: IssueProviderDeps = {}) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.endpoint = (deps.baseUrl ?? "https://api.linear.app/graphql").replace(/\/$/, "");
  }

  private headers(token?: string): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (token) h.Authorization = token; // Linear: raw API key, no "Bearer" prefix
    return h;
  }

  private async gql<T>(token: string | undefined, query: string, variables: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: this.headers(token),
        body: JSON.stringify({ query, variables }),
      });
    } catch {
      throw new IssueProviderError("linear", "request failed");
    }
    if (!res.ok) throw new IssueProviderError("linear", `request failed (status ${res.status})`);
    const json = (await res.json()) as { data?: T; errors?: unknown };
    if (json.errors || !json.data) throw new IssueProviderError("linear", "graphql error");
    return json.data;
  }

  async fetchIssue(ref: IssueRef, token?: string): Promise<IssueContext> {
    const data = await this.gql<{ issues: { nodes: LinearNode[] } }>(token, FETCH_QUERY, {
      team: ref.team,
      number: ref.number,
    });
    const node = data.issues.nodes[0];
    if (!node) throw new IssueProviderError("linear", `issue ${ref.key} not found`);
    return {
      source: "linear",
      ref: `linear:${node.identifier}`,
      id: node.id,
      title: node.title ?? "",
      body: node.description ?? "",
      url: node.url ?? "",
      state: node.state?.name ?? "",
      labels: (node.labels?.nodes ?? []).map((l) => l.name ?? "").filter(Boolean),
    };
  }

  async postComment(ref: IssueRef, token: string | undefined, body: string): Promise<{ url: string }> {
    // The comment mutation needs the issue's UUID, so resolve the identifier first.
    const found = await this.gql<{ issues: { nodes: LinearNode[] } }>(token, FETCH_QUERY, {
      team: ref.team,
      number: ref.number,
    });
    const node = found.issues.nodes[0];
    if (!node) throw new IssueProviderError("linear", `issue ${ref.key} not found`);
    const data = await this.gql<{ commentCreate: { comment?: { url?: string } } }>(
      token,
      COMMENT_MUTATION,
      { issueId: node.id, body },
    );
    return { url: data.commentCreate.comment?.url ?? "" };
  }
}
