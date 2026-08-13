export async function postChat(
  messages: { role: "user" | "assistant"; content: any }[],
  target?: { project: string | null; feature: string | null },
  uiContext?: { active: boolean; project: string | null; feature: string | null },
) {
  const r = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, target, uiContext }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function postTrigger(overrides: Record<string, string> = {}) {
  const r = await fetch("/api/trigger", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(overrides),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    const err = new Error(body?.message || body?.error || `Trigger failed (${r.status})`);
    (err as any).code = body?.error;
    (err as any).emptyFolders = body?.emptyFolders;
    throw err;
  }
  return r.json();
}

export async function getStatus(issueId: string) {
  const r = await fetch(`/api/status/${issueId}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function hasPreview(project: string, feature: string): Promise<boolean> {
  const r = await fetch(`/api/preview/${encodeURIComponent(project)}/${encodeURIComponent(feature)}`);
  return r.ok;
}

export async function createTarget(project: string, feature: string) {
  const r = await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project, feature }),
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data?.error || `Failed to create project (HTTP ${r.status})`);
  }
  return r.json() as Promise<{ ok: true; project: string; feature: string; relativePath: string }>;
}

export async function triggerUiBuild(project: string, feature: string) {
  const r = await fetch("/api/ui-agent/trigger", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project, feature }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    const err = new Error(body?.message || body?.error || `UI trigger failed (${r.status})`);
    (err as any).code = body?.error;
    throw err;
  }
  return r.json();
}

// Shared shape for the downstream pipeline stage triggers: POST {project,
// feature}; on failure surface the server's error code on the thrown error
// (App.tsx branches on `.code` for the friendly prerequisite messages).
async function postStageTrigger(path: string, label: string, project: string, feature: string) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project, feature }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    const err = new Error(body?.message || body?.error || `${label} failed (${r.status})`);
    (err as any).code = body?.error;
    throw err;
  }
  return r.json();
}

// Fire the DATA MODEL stage. Gated server-side on the product summary existing
// (409 no_product_summary).
export const triggerDataModel = (project: string, feature: string) =>
  postStageTrigger("/api/data-model/trigger", "Data model trigger", project, feature);

// Fire the SOLUTION DESIGN stage. Gated server-side on the data model impact
// existing (409 no_data_model).
export const triggerSolutionDesign = (project: string, feature: string) =>
  postStageTrigger("/api/solution-design/trigger", "Solution design trigger", project, feature);

// Fire the CAPABILITY MAP stage. No pipeline prerequisite — gated server-side
// only on the feature having documents at all (409 no_documents).
export const triggerCapabilityMap = (project: string, feature: string) =>
  postStageTrigger("/api/capability-map/trigger", "Capability map trigger", project, feature);

// Fire the SOLUTION ARCHITECTURE stage (Solution Architect → SAD). Gated only on
// the product summary (409 no_product_summary) — the data model is optional
// enrichment, so this deliberately does NOT wait for the data-model stage.
export const triggerSolutionArchitecture = (project: string, feature: string) =>
  postStageTrigger("/api/solution-architecture/trigger", "Solution architecture trigger", project, feature);

// Fire the TEST CASES stage (QA Architect → test pack). Gated only on the
// product summary (409 no_product_summary).
export const triggerTestCases = (project: string, feature: string) =>
  postStageTrigger("/api/test-cases/trigger", "Test cases trigger", project, feature);

// Fire the PERSONAS stage (Service Designer → persona set + journey maps). No
// pipeline prerequisite — gated server-side only on the feature having documents
// at all (409 no_documents), same as the capability map.
export const triggerPersonas = (project: string, feature: string) =>
  postStageTrigger("/api/personas/trigger", "Personas trigger", project, feature);

export async function postUiComment(issueId: string, body: string) {
  const r = await fetch("/api/ui-agent/comment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ issueId, body }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function approve(approvalId: string, parentIssueId?: string, note?: string) {
  const r = await fetch(`/api/approve/${approvalId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parentIssueId, note }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    const err = new Error(body?.message || body?.error || `Approve failed (${r.status})`);
    (err as any).code = body?.error;
    throw err;
  }
  return r.json();
}

// Send reviewer feedback back to the BA: marks the gate revision_requested and
// re-fires the BA's issue so it regenerates and raises a fresh gate.
export async function requestChanges(approvalId: string, issueId: string, feedback: string) {
  const r = await fetch(`/api/request-changes/${approvalId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ issueId, feedback }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export interface HistoryEntry {
  id: string;
  identifier: string;
  title: string;
  status: string;
  completedAt: string | null;
  links: { confluence: string[]; jira: string[] };
}

export async function getHistory(): Promise<HistoryEntry[]> {
  const r = await fetch("/api/history");
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export interface RunSummary {
  runId: string;
  agent: string;
  status: string;
  startedAt: string | null;
  durationMs: number | null;
}

export async function getRuns(issueId: string): Promise<RunSummary[]> {
  const r = await fetch(`/api/runs/${issueId}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// Live Transcript -----------------------------------------------------------
import type { AgentRunsSnapshot, TranscriptTail } from "./types";

export async function getAgentRuns(issueId: string): Promise<AgentRunsSnapshot> {
  const r = await fetch(`/api/runs/${issueId}/agent-runs`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getTranscriptTail(runId: string, offset: number): Promise<TranscriptTail> {
  const r = await fetch(`/api/runs/${runId}/transcript?offset=${offset}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export type UploadHint = "sop" | "transcripts" | "notes" | "ui" | "template" | "style-guide" | "example-screen";

export interface UploadFileSuccess {
  kind: "file" | "transcript";
  subfolder: string;
  filename: string;
  relativePath: string;
  entryCount?: number;
  modelUsed?: string;
}

export interface UploadAmbiguous {
  ambiguous: true;
  originalName: string;
  message: string;
}

/**
 * Upload a single file into projects/<project>/<feature>/<auto-routed-subfolder>.
 * If the server can't infer where a .pdf/.docx belongs it returns an ambiguous
 * marker — call uploadFile again with the same blob and a chosen `hint`.
 */
export async function uploadFile(
  project: string,
  feature: string,
  file: File,
  hint?: UploadHint,
): Promise<UploadFileSuccess | UploadAmbiguous> {
  const form = new FormData();
  form.append("project", project);
  form.append("feature", feature);
  if (hint) form.append("hint", hint);
  form.append("file", file);
  const r = await fetch("/api/upload", { method: "POST", body: form });
  if (r.status === 409) {
    const body = await r.json();
    if (body?.error === "ambiguous_kind") {
      return { ambiguous: true, originalName: body.originalName, message: body.message };
    }
    throw new Error(body?.message || body?.error || `Upload failed (${r.status})`);
  }
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export function recordingSocketUrl(): string {
  if (typeof window === "undefined") return "ws://127.0.0.1:4000/ws/record";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws/record`;
}
