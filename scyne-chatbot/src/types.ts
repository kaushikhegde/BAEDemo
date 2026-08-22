export type MessageKind = "user" | "assistant" | "agent" | "decision" | "links";

export interface UIMessage {
  id: string;
  role: "user" | "assistant"; // alignment side
  kind?: MessageKind;          // visual style
  author?: string;             // shown as a small label above the bubble for agent messages
  text: string;
  /**
   * Set on `kind: "decision"` — a durable record of what the reviewer decided at
   * an approval gate. The gate's own card is derived from polled status and
   * disappears once resolved; this lives in the chat transcript, which is
   * persisted to localStorage, so "did I approve that?" is answerable later.
   */
  decision?: {
    outcome: "approved" | "changes_requested";
    issue?: string;   // e.g. "SCY-2"
    title?: string;   // the gate's title
    note?: string;    // the reviewer's feedback, on changes_requested
    at: string;       // ISO timestamp
  };
  /**
   * Set on `kind: "links"` — wiki page and work item URLs announced at the point in the
   * conversation where they were published, rather than pinned under the whole
   * transcript where they lose their connection to the run that produced them.
   */
  links?: { wiki: string[]; workItems: string[] };
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
  /** Parsed from the root issue description, so the UI can recover the target. */
  target?: { project: string | null; feature: string | null };
  flatIssues: IssueProgress[];
  activity: ActivityItem[];
  approvals: ApprovalCardData[];
  links: { wiki: string[]; workItems: string[] };
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
  // Downstream pipeline outputs (data model impact, solution design) plus the
  // standalone capability + process map. Present only once those stages have
  // run; the preview shows a tab for each when set.
  dataModel: string | null;
  solutionDesign: string | null;
  solutionArchitecture: string | null;
  testCases: string | null;
  capabilityMap: string | null;
  personas: string | null;
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
