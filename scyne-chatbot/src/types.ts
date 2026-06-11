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
  // The BA writes Jira-payload shape; `description` may be a plain string OR an
  // Atlassian Document Format doc ({type:"doc", content:[...]}). Renderer must
  // handle both. See ArtifactsPreview.adfToText.
  description: string | { type?: string; content?: any[]; [k: string]: any };
  labels: string[];
  meta: Record<string, any>;
}
export interface Artifacts {
  productSummary: string | null;
  stories: ArtifactStory[];
  storiesMd: string | null;
  gaps: string | null;
  // Downstream pipeline outputs (data model impact, solution design). Present
  // only once those stages have run; the preview shows a tab for each when set.
  dataModel: string | null;
  solutionDesign: string | null;
}

// Live Transcript types ------------------------------------------------------

export type TranscriptEvent =
  | { ts: string; kind: "assistant"; text: string }
  | { ts: string; kind: "tool_use"; tool: string; preview: string }
  | { ts: string; kind: "tool_result"; preview: string }
  | { ts: string; kind: "skill"; name: string }
  | { ts: string; kind: "framing"; text: string };

export interface AgentRun {
  runId: string;
  agentId: string;
  agentName: string;
  issueId: string;
  issueIdentifier: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AgentRunsSnapshot {
  runs: AgentRun[];
  activeRunId: string | null;
}

export interface TranscriptTail {
  events: TranscriptEvent[];
  nextOffset: number;
  runStatus: string;
}
