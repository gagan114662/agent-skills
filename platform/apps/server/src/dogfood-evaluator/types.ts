export type DogfoodLane = "ipop-growth" | "customer-growth";

export type MarketingLeverageKind =
  | "seo"
  | "content"
  | "social"
  | "email"
  | "outreach"
  | "analytics"
  | "ads"
  | "site"
  | "support";

export type DogfoodFailureKind =
  | "no_deliverable"
  | "no_receipt"
  | "no_marketing_leverage"
  | "placeholder_output"
  | "missing_external_channel"
  | "broken_route"
  | "unredacted_secret";

export interface DogfoodRunToolUse {
  name: string;
  input?: unknown;
  output?: unknown;
}

export interface DogfoodRunArtifact {
  kind: string;
  title: string;
  url?: string;
  content?: string;
}

export interface DogfoodRunReceipt {
  kind: string;
  url?: string;
  ref?: string;
  summary?: string;
}

export interface DogfoodRunApproval {
  gate: string;
  verdict: "approved" | "rejected" | "pending";
  summary?: string;
}

export interface DogfoodRunPublicOutput {
  surface: string;
  url?: string;
  content?: string;
}

export interface DogfoodRunInput {
  id: string;
  workspaceId?: string;
  lane?: DogfoodLane;
  task: string;
  goal?: string;
  agents: string[];
  tools?: DogfoodRunToolUse[];
  artifacts?: DogfoodRunArtifact[];
  approvals?: DogfoodRunApproval[];
  receipts?: DogfoodRunReceipt[];
  traces?: Array<Record<string, unknown>>;
  publicOutputs?: DogfoodRunPublicOutput[];
  secretValues?: string[];
}

export interface ExistingIssueSummary {
  number: number;
  title: string;
  body?: string;
  labels?: string[];
  url?: string;
}

export interface DogfoodEvaluatorConfig {
  targetRepo: { owner: string; repo: string };
  existingIssues: ExistingIssueSummary[];
  publishMode: "review" | "autopublish";
  autopublishEnabled?: boolean;
  labels?: string[];
}

export interface DogfoodObservedFailure {
  kind: DogfoodFailureKind;
  summary: string;
  evidence: string[];
}

export interface DogfoodIssueDraft {
  title: string;
  body: string;
  labels: string[];
  fingerprint: string;
}

export interface DogfoodIssuePublication {
  number: number;
  url: string;
}

export interface DogfoodEvaluationRecord {
  runId: string;
  lane: DogfoodLane;
  task: string;
  goal?: string;
  agents: string[];
  toolsUsed: string[];
  deliverables: DogfoodRunArtifact[];
  approvals: DogfoodRunApproval[];
  receipts: DogfoodRunReceipt[];
  marketingLeverage: MarketingLeverageKind[];
  failures: DogfoodObservedFailure[];
  traceLinks: string[];
  artifactLinks: string[];
  existingIssue?: ExistingIssueSummary;
  issueDraft?: DogfoodIssueDraft;
  publication?: DogfoodIssuePublication;
}

export interface DogfoodIssuePublisher {
  createIssue(input: DogfoodIssueDraft): Promise<DogfoodIssuePublication>;
}
