export type MessageKind = "user" | "assistant" | "agent";

export interface UIMessage {
  id: string;
  role: "user" | "assistant"; // alignment side
  kind?: MessageKind;          // visual style
  author?: string;             // shown as a small label above the bubble for agent messages
  text: string;
}

export interface IssueProgress {
  id: string;
  identifier: string;
  status: string;
  title: string;
}
export interface ApprovalCardData {
  id: string;
  issueId: string;
  issueIdentifier: string;
  title: string;
  description?: string;
  status?: "pending" | "approved" | "rejected" | "revision_requested" | null;
  decisionNote?: string | null;
}
export interface ActivityItem {
  id: string;
  issueIdentifier: string;
  body: string;
  author: string;
  createdAt: string;
}
export interface StatusSnapshot {
  stage: { key: string; label: string };
  flatIssues: IssueProgress[];
  activity: ActivityItem[];
  approvals: ApprovalCardData[];
  links: { confluence: string[]; jira: string[] };
}

export interface ArtifactStory {
  summary: string;
  description: string;
  labels: string[];
  meta: Record<string, any>;
}
export interface Artifacts {
  productSummary: string | null;
  stories: ArtifactStory[];
  storiesMd: string | null;
  gaps: string | null;
}
