/** Resolved caller identity attached to every authenticated request. */
export interface Identity {
  workspaceId: string;
  memberId: string;
  kind: "human" | "agent";
  displayName: string;
}
