// Every call in this file goes through `apiFetch`, never `fetch` directly.
//
// Two reasons. `credentials: "include"` sends the httpOnly session cookie —
// same-origin requests would send it by default under Vite's proxy, but that
// makes the app quietly dependent on being served from the same origin as its
// API, and it is not worth a class of bug that only appears in deployment.
//
// And a 401 means one specific thing — the session has expired — with one
// specific remedy. Announcing it once here returns the user to the login
// screen, instead of every caller separately rendering "request failed" for
// someone who simply needs to sign in again.

/** Fired when the server rejects our session. App.tsx listens and signs out. */
export const UNAUTHENTICATED_EVENT = "scyne:unauthenticated";

async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(input, { credentials: "include", ...init });
  if (res.status === 401 && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(UNAUTHENTICATED_EVENT));
  }
  return res;
}

export async function postChat(
  messages: { role: "user" | "assistant"; content: any }[],
  target?: { project: string | null; feature: string | null },
  uiContext?: { active: boolean; project: string | null; feature: string | null },
) {
  const r = await apiFetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, target, uiContext }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function postTrigger(overrides: Record<string, string> = {}) {
  const r = await apiFetch("/api/trigger", {
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
  const r = await apiFetch(`/api/status/${issueId}`);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    const err = new Error(body?.message || (await r.text().catch(() => r.statusText)));
    // Carried so the caller can tell "this workflow is gone, forget it" from
    // "the backend is down, keep retrying" — they need opposite handling.
    (err as any).status = r.status;
    (err as any).code = body?.error;
    throw err;
  }
  return r.json();
}

// The companion app is ONE page per project, so the registry is keyed by
// project; the `/:feature` form is only an alias. Feature is optional here.
export async function hasPreview(project: string, feature?: string | null): Promise<boolean> {
  const r = await apiFetch(previewUrl(project, feature));
  return r.ok;
}

export function previewUrl(project: string, feature?: string | null): string {
  const base = `/api/preview/${encodeURIComponent(project)}`;
  return feature ? `${base}/${encodeURIComponent(feature)}` : base;
}

export async function createTarget(project: string, feature: string) {
  const r = await apiFetch("/api/projects", {
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
  const r = await apiFetch("/api/ui-agent/trigger", {
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
// `feature` is omitted for PROJECT stages — the capability map and personas
// describe the client, not one slice of work.
async function postStageTrigger(path: string, label: string, project: string, feature?: string) {
  const r = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(feature ? { project, feature } : { project }),
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

// Fire the CAPABILITY MAP stage — PROJECT level. No prerequisite; gated
// server-side only on the project having documents at all (409 no_documents).
export const triggerCapabilityMap = (project: string) =>
  postStageTrigger("/api/capability-map/trigger", "Capability map trigger", project);

// Fire the SOLUTION ARCHITECTURE stage (Solution Architect → SAD). Gated only on
// the product summary (409 no_product_summary) — the data model is optional
// enrichment, so this deliberately does NOT wait for the data-model stage.
export const triggerSolutionArchitecture = (project: string, feature: string) =>
  postStageTrigger("/api/solution-architecture/trigger", "Solution architecture trigger", project, feature);

// Fire the TEST CASES stage (QA Architect → test pack). Gated only on the
// product summary (409 no_product_summary).
export const triggerTestCases = (project: string, feature: string) =>
  postStageTrigger("/api/test-cases/trigger", "Test cases trigger", project, feature);

// Fire the PERSONAS stage (Service Designer → persona set + journey maps) —
// PROJECT level. Gated on the capability map (409 no_capability_map), because
// journey stages align to its L1 lifecycle phases.
export const triggerPersonas = (project: string) =>
  postStageTrigger("/api/personas/trigger", "Personas trigger", project);

// Fire the UI MOCKUPS stage (UX Designer → wireframes). No pipeline prerequisite
// — gated server-side only on the feature having documents (409 no_documents),
// since the skill needs either the product summary or the discovery documents.
// NOT the same as triggerUiBuild, which renders the companion app page.
export const triggerUiMockups = (project: string, feature: string) =>
  postStageTrigger("/api/ui-mockups/trigger", "UI mockups trigger", project, feature);

export type BrandTheme = {
  brand?: string;
  brandDeep?: string;
  accent?: string;
  logoText?: string;
  fontFamily?: string;
  hasLogo?: boolean;
};
export type BrandResult = {
  ok: boolean;
  url: string;
  rerendered: boolean;
  theme: BrandTheme | null;
  source: any;
};

// Read a client's brand off a live site and write it as the project's companion-app
// theme. Unlike the stage triggers this is synchronous — no Paperclip issue, no
// agent — because it is a file write the user needs to see the result of straight
// away in order to correct it.
export async function extractBrand(url: string, project: string): Promise<BrandResult> {
  const r = await apiFetch("/api/brand/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, project }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err: any = new Error(body?.message || body?.error || `Brand extraction failed (HTTP ${r.status})`);
    err.code = body?.error;
    throw err;
  }
  return body as BrandResult;
}

export async function postUiComment(issueId: string, body: string) {
  const r = await apiFetch("/api/ui-agent/comment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ issueId, body }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function approve(approvalId: string, parentIssueId?: string, note?: string) {
  const r = await apiFetch(`/api/approve/${approvalId}`, {
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
  const r = await apiFetch(`/api/request-changes/${approvalId}`, {
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
  const r = await apiFetch("/api/history");
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
  const r = await apiFetch(`/api/runs/${issueId}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// Live Transcript -----------------------------------------------------------
import type { AgentRunsSnapshot, TranscriptTail } from "./types";

export async function getAgentRuns(issueId: string): Promise<AgentRunsSnapshot> {
  const r = await apiFetch(`/api/runs/${issueId}/agent-runs`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getTranscriptTail(runId: string, offset: number): Promise<TranscriptTail> {
  const r = await apiFetch(`/api/runs/${runId}/transcript?offset=${offset}`);
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
  const r = await apiFetch("/api/upload", { method: "POST", body: form });
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

/** Write projects/<project>/description.md — the project definition every skill reads. */
export async function saveProjectDefinition(project: string, description: string): Promise<{ ok: boolean; project: string; path: string; bytes: number }> {
  const r = await apiFetch("/api/project-description", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project, description }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || `save failed (${r.status})`);
  return r.json();
}

/** Read it back, for showing the current definition in chat. */
export async function getProjectDefinition(project: string): Promise<{ project: string; exists: boolean; content: string }> {
  const r = await apiFetch(`/api/project-description/${encodeURIComponent(project)}`);
  if (!r.ok) throw new Error(`read failed (${r.status})`);
  return r.json();
}


// --- Project + feature creation, suggestions, revision ---------------------

async function postJson(path: string, label: string, body: unknown) {
  const r = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err: any = new Error(parsed?.message || parsed?.error || `${label} failed (${r.status})`);
    err.code = parsed?.error;
    throw err;
  }
  return parsed;
}

export type CreateProjectResult = {
  ok: boolean;
  project: string;
  definitionWritten: boolean;
  brand: BrandTheme | null;
  brandError: string | null;
};

export const createProject = (project: string, description?: string, website?: string) =>
  postJson("/api/projects", "Create project", { project, description, website }) as Promise<CreateProjectResult>;

export const createFeature = (project: string, feature: string) =>
  postJson("/api/features", "Create feature", { project, feature });

/** Builds a project's baseline: capability map, then personas, sequentially. */
export const bootstrapProject = (project: string) =>
  postJson("/api/project/bootstrap", "Set up project", { project });

/** Ask the owning specialist to CHANGE an artefact that already exists. */
export const reviseArtefact = (project: string, artefact: string, instruction: string, feature?: string) =>
  postJson("/api/revise", "Revise", { project, artefact, instruction, feature });

export type Chip = { label: string; message: string };

/** The chips above the composer — what is actually possible right now. */
export async function fetchSuggestions(project?: string | null, feature?: string | null): Promise<Chip[]> {
  const qs = new URLSearchParams();
  if (project) qs.set("project", project);
  if (feature) qs.set("feature", feature);
  try {
    const r = await apiFetch(`/api/suggestions?${qs.toString()}`);
    if (!r.ok) return [];
    const body = await r.json();
    return Array.isArray(body?.chips) ? body.chips : [];
  } catch {
    // Chips are an affordance, never a dependency — a failure here must not
    // break the composer.
    return [];
  }
}

export type StaleArtefact = {
  key: string;
  artefact: string;
  label: string;
  level: "project" | "feature";
  generatedAt: string;
  supersededBy: { key: string; label: string; artefact: string; generatedAt: string }[];
};

export async function fetchStaleness(project: string, feature?: string | null): Promise<StaleArtefact[]> {
  try {
    const path = feature
      ? `/api/staleness/${encodeURIComponent(project)}/${encodeURIComponent(feature)}`
      : `/api/staleness/${encodeURIComponent(project)}`;
    const r = await apiFetch(path);
    if (!r.ok) return [];
    const body = await r.json();
    return Array.isArray(body?.stale) ? body.stale : [];
  } catch {
    return [];
  }
}

/** Upload a client-wide document to projects/<project>/documents/ (the wizard's dropzone). */
export async function uploadProjectFile(project: string, file: File) {
  const form = new FormData();
  form.append("project", project);
  form.append("file", file);
  const r = await apiFetch("/api/upload/project", { method: "POST", body: form });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err: any = new Error(body?.message || body?.error || `Upload failed (${r.status})`);
    err.code = body?.error;
    throw err;
  }
  return body as { filename: string; converted: boolean; relativePath: string };
}

// ---- stopping a run ---------------------------------------------------------

/**
 * Pause a running workflow.
 *
 * `force` is the difference between "let the current step finish" and "stop
 * the agent now". The first discards nothing and may take as long as an agent
 * run to take effect; the second is immediate and loses that step's work.
 */
export async function pauseIssue(issueId: string, force = false) {
  const r = await apiFetch(`/api/issues/${issueId}/pause`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ force }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || `Pause failed (${r.status})`);
  return r.json();
}

export async function cancelIssue(issueId: string) {
  const r = await apiFetch(`/api/issues/${issueId}/cancel`, { method: "POST" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || `Cancel failed (${r.status})`);
  return r.json();
}

export async function resumeIssue(issueId: string) {
  const r = await apiFetch(`/api/issues/${issueId}/resume`, { method: "POST" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || `Resume failed (${r.status})`);
  return r.json();
}

// ─── Ops: issues, spend, actions ────────────────────────────────────────────
//
// Each mirrors a `scyne` command, so the two clients answer the same question
// the same way. A refusal is NOT swallowed: spend and the audit feed are
// admin-only in the orchestrator, and the caller needs to tell "you cannot see
// this" apart from "there is nothing here".

export interface OpsIssue {
  id: string;
  identifier: string;
  title: string;
  status: string;
  workflow: string | null;
  project: string | null;
  feature: string | null;
  /** `5/6 gate` — where it is, and what that step does. */
  step: string;
  stepIndex: number;
  stepCount: number | null;
  controlRequest: string | null;
  needsHuman: boolean;
  createdBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** A refusal or an outage, in a shape a view can render without guessing. */
export class OpsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "OpsError";
  }
  /** Your role cannot see this. Retrying will not help — so views do not. */
  get forbidden(): boolean { return this.status === 403; }
  get unreachable(): boolean { return this.status === 503; }
}

async function ops<T>(path: string): Promise<T> {
  const r = await apiFetch(path);
  if (!r.ok) {
    const body = await r.json().catch(() => ({} as any));
    throw new OpsError(r.status, body?.error ?? "error",
      body?.message || `Request failed (${r.status})`);
  }
  return r.json() as Promise<T>;
}

export function getIssues(
  filter: { project?: string | null; feature?: string | null; status?: string; open?: boolean } = {},
): Promise<OpsIssue[]> {
  const q = new URLSearchParams();
  if (filter.project) q.set("project", filter.project);
  if (filter.feature) q.set("feature", filter.feature);
  if (filter.status) q.set("status", filter.status);
  if (filter.open) q.set("open", "true");
  return ops<OpsIssue[]>(`/api/issues${q.toString() ? `?${q}` : ""}`);
}

export type SpendDimension = "project" | "feature" | "user" | "agent" | "adapter" | "model";

export interface SpendRow {
  project_name?: string; feature_name?: string; user_email?: string;
  agent_key?: string; adapter?: string; model?: string;
  run_count?: number | string;
  input_tokens?: number | string; output_tokens?: number | string;
  reported_cost_usd?: number | string | null;
  estimated_cost_usd?: number | string | null;
  /**
   * Runs with NEITHER a reported nor an estimated cost.
   *
   * Not the same as costing nothing: the model was never billed by a CLI and
   * has no row in `model_prices`, so its spend is unknown. Counted in the run
   * and token figures and in neither cost column — which is why the total can
   * look too low, and why the view says so rather than letting somebody
   * conclude a fleet of runs was free.
   */
  unpriced_run_count?: number | string | null;
}

export function getSpend(by: SpendDimension, extra: Record<string, string> = {}): Promise<SpendRow[]> {
  return ops<SpendRow[]>(`/api/spend?${new URLSearchParams({ by, ...extra })}`);
}

/**
 * One audit row, in the shape the orchestrator actually returns — verified
 * against a live response, not inferred from the CLI's column headings.
 *
 * Two fields are easy to get wrong. The verb is `verb`, not `action`. And
 * `detail` is an OBJECT (`{path, version, changed}`), not a string: rendering
 * it directly produces `[object Object]` in a column meant to say what
 * happened.
 */
export interface ActionRow {
  id?: string;
  verb?: string;
  /** Null for an action taken by an agent, or before attribution existed. */
  user_email?: string | null;
  /** Set when an AGENT acted rather than a person. */
  agent_key?: string | null;
  project_name?: string | null;
  target_type?: string | null;
  target_id?: string | null;
  detail?: Record<string, unknown> | string | null;
  created_at?: string | null;
  [key: string]: unknown;
}

/**
 * `detail` as one readable clause.
 *
 * Pure and exported so it can be tested: every audit row goes through it, and
 * the failure mode is silent — an object stringifies to `[object Object]`,
 * which looks like a rendering bug rather than the missing data it is.
 */
export function summariseDetail(detail: ActionRow["detail"]): string {
  if (!detail) return "";
  if (typeof detail === "string") return detail;
  // A path is what a person is looking for when they scan this column, so it
  // wins over the other keys rather than being alphabetised among them.
  const path = detail.path ?? detail.file ?? detail.name;
  if (typeof path === "string") return path;
  const pairs = Object.entries(detail)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
    .map(([k, v]) => `${k} ${v}`);
  return pairs.join(" · ");
}

export function getActions(limit = 100): Promise<ActionRow[]> {
  return ops<ActionRow[]>(`/api/actions?limit=${limit}`);
}

/**
 * The time ranges the Spend view offers.
 *
 * Presets rather than two date pickers: "what did last month cost" is the
 * question people actually have, and a pair of empty date fields makes them
 * compute the answer to a different one first. `""` is all time, and is the
 * default — a cost figure silently covering only the last week is worse than
 * no filter at all.
 */
export const SPEND_PERIODS = [
  { value: "", label: "All time" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "mtd", label: "This month" },
  { value: "today", label: "Today" },
] as const;

export type SpendPeriod = (typeof SPEND_PERIODS)[number]["value"];

/**
 * A period → the `since` the API wants, or null for all time.
 *
 * `now` is a parameter so this is pure and testable; every caller passes
 * `Date.now()`. Day boundaries are LOCAL — somebody asking for "today" in
 * Adelaide means their today, and computing it in UTC puts the boundary in the
 * middle of their morning for most of the year.
 */
export function sinceFor(period: SpendPeriod, now: number = Date.now()): string | null {
  if (!period) return null;
  const d = new Date(now);
  if (period === "today") { d.setHours(0, 0, 0, 0); return d.toISOString(); }
  if (period === "mtd") { d.setHours(0, 0, 0, 0); d.setDate(1); return d.toISOString(); }
  const days = Number(period.replace("d", ""));
  if (!Number.isFinite(days)) return null;
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d.toISOString();
}
