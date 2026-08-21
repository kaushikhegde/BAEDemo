// What exists, according to the DATABASE — reached over the orchestrator's API.
//
// This module exists because the chatbot used to answer "what projects and
// features are there?" by walking `projects/` on disk, in three places: the
// system prompt's project tree, `/api/features`, and the has-a-description
// check. Disk is not the system of record — core/materialise.ts is explicit
// that "the store is the system of record now", and the tree is materialised
// out of it for agents to work in and harvested back afterwards.
//
// The two disagreeing is not hypothetical. A `reset --all` clears the database
// and deliberately leaves `projects/` alone ("files under projects/ on disk are
// untouched"), so a freshly reset installation with an empty Projects tab
// answered "SAPN already exists. Its features are: customer-data" — naming a
// project no API could act on, and a feature nothing could run.
//
// Every call carries the CALLER's token rather than a service credential, so
// what the assistant can see is exactly what that person can see, and a
// question about another organisation's project returns nothing rather than
// leaking its name.

const BASE = process.env.ORCHESTRATOR_API_URL || "http://127.0.0.1:3100";

export interface Project {
  id: string;
  name: string;
  description?: string | null;
}

export interface Feature { id: string; name: string }

export interface DocumentRow {
  path: string;
  category: string | null;
  feature?: string | null;
}

async function get<T>(token: string | null, path: string, fallback: T): Promise<T> {
  if (!token) return fallback;
  try {
    const res = await fetch(BASE + path, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
    });
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    // The orchestrator being unreachable is a real state — `npm run dev` starts
    // both, but they can be started separately. An empty list says "nothing to
    // offer", which is the honest answer and is what the caller would have got
    // from an empty database anyway.
    return fallback;
  }
}

export const listProjects = (token: string | null): Promise<Project[]> =>
  get<Project[]>(token, "/projects", []);

export const listFeatures = (token: string | null, projectId: string): Promise<Feature[]> =>
  get<Feature[]>(token, `/projects/${projectId}/features`, []);

export const listDocuments = (
  token: string | null, projectId: string, feature?: string,
): Promise<DocumentRow[]> =>
  get<DocumentRow[]>(token,
    `/projects/${projectId}/documents${feature ? `?feature=${encodeURIComponent(feature)}` : ""}`, []);

/** One feature, with how many documents it holds in each category. */
export interface FeatureSummary { name: string; counts: Record<string, number> }

/**
 * The whole picture the assistant and `/api/features` both need:
 * project name -> its features, each with its document counts.
 *
 * Counts come from the document rows' `category`, which is the same vocabulary
 * `--as` writes (sop, transcripts, notes, ui, template). A document stored
 * without one is counted under "other" rather than dropped — it exists, and a
 * count that silently omits it is how somebody concludes their upload failed.
 */
export async function available(
  token: string | null,
): Promise<Record<string, FeatureSummary[]>> {
  const out: Record<string, FeatureSummary[]> = {};
  for (const project of await listProjects(token)) {
    const features = await listFeatures(token, project.id);
    const docs = await listDocuments(token, project.id);
    const byFeature = new Map<string, Record<string, number>>();
    for (const d of docs) {
      if (!d.feature) continue;              // project-level, not a feature's
      const counts = byFeature.get(d.feature) ?? {};
      const key = d.category || "other";
      counts[key] = (counts[key] ?? 0) + 1;
      byFeature.set(d.feature, counts);
    }
    out[project.name] = features.map(f => ({
      name: f.name,
      counts: byFeature.get(f.name) ?? {},
    }));
  }
  return out;
}

/** Which projects carry a description — a project FIELD, not a file on disk. */
export async function definitions(token: string | null): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const p of await listProjects(token)) {
    out[p.name] = Boolean(p.description && String(p.description).trim().length);
  }
  return out;
}

// ─── Ops reads: issues, spend, actions ──────────────────────────────────────
//
// The chatbot is a full client now, not only a way to start a run — so it has
// to answer "what is going on" and "what did it cost" as well as the console
// does. These are DELIBERATELY here rather than in orchestrator.ts: that
// module falls back to SCYNE_API_TOKEN when no caller token is present, which
// is right for the unattended staleness sweep and exactly wrong for a browser
// read. A request arriving without a session must return nothing, never the
// whole organisation's spend under a service credential.

/**
 * A read where the STATUS matters as much as the body.
 *
 * `get()` above collapses every failure to a fallback, which is right for a
 * list the assistant is merely enriching a prompt with. It is wrong for spend
 * and actions: those are admin-only in the orchestrator, and rendering an
 * empty table to a member says "nothing has been spent" when the truthful
 * answer is "you are not allowed to see this". A 403 has to survive the trip.
 */
export interface OpsResult<T> { ok: boolean; status: number; data: T | null }

async function fetchJson<T>(token: string | null, path: string): Promise<OpsResult<T>> {
  if (!token) return { ok: false, status: 401, data: null };
  try {
    const res = await fetch(BASE + path, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { ok: false, status: res.status, data: null };
    return { ok: true, status: res.status, data: (await res.json()) as T };
  } catch {
    // 503 rather than 500: the orchestrator being down is a real, temporary
    // state (the two servers can be started separately), and the view says so
    // instead of showing an empty list that reads like "no issues".
    return { ok: false, status: 503, data: null };
  }
}

/** How long each workflow is, and what each step does — from GET /config. */
export type WorkflowSteps = Record<string, { count: number; types: string[] }>;

export async function workflowSteps(token: string | null): Promise<WorkflowSteps> {
  const res = await fetchJson<{ workflows?: Array<{ key: string; stepList?: Array<{ type: string }> }> }>(
    token, "/config");
  const out: WorkflowSteps = {};
  for (const w of res.data?.workflows ?? []) {
    if (!w?.key || !Array.isArray(w.stepList)) continue;
    out[w.key] = { count: w.stepList.length, types: w.stepList.map(s => s?.type ?? "?") };
  }
  return out;
}

/** One issue, in the shape the Issues view renders. */
export interface OpsIssue {
  id: string;
  identifier: string;
  title: string;
  status: string;
  workflow: string | null;
  project: string | null;
  feature: string | null;
  /** `5/6 gate` — where it is AND what that step does. */
  step: string;
  stepIndex: number;
  stepCount: number | null;
  /** A REQUEST, not a status: honoured at the engine's next step boundary. */
  controlRequest: string | null;
  /** in_review · blocked · paused — the states nothing moves out of on its own. */
  needsHuman: boolean;
  createdBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** The statuses that sit until a person does something. */
export const NEEDS_HUMAN = new Set(["in_review", "blocked", "paused"]);

/**
 * Shape one orchestrator issue row for the UI.
 *
 * Pure, and exported, because it is the only part of this worth testing: the
 * `step_index` → `5/6 gate` arithmetic is off-by-one in the obvious way (the
 * index is 0-based, a person counts from 1) and a done issue has run off the
 * end of its own step list.
 */
export function shapeIssue(row: any, steps: WorkflowSteps): OpsIssue {
  const w = steps[row?.workflow_key ?? ""];
  const index = Number(row?.step_index ?? 0);
  const at = w?.types?.[index];
  return {
    id: String(row?.id ?? ""),
    identifier: String(row?.identifier ?? ""),
    title: String(row?.title ?? ""),
    status: String(row?.status ?? ""),
    workflow: row?.workflow_key ?? null,
    project: row?.params?.project ?? null,
    feature: row?.params?.feature ?? null,
    step: w ? `${Math.min(index + 1, w.count)}/${w.count}${at ? ` ${at}` : ""}` : String(index),
    stepIndex: index,
    stepCount: w?.count ?? null,
    controlRequest: row?.control_request ?? null,
    needsHuman: NEEDS_HUMAN.has(String(row?.status ?? "")),
    createdBy: row?.created_by ?? null,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

export interface IssueFilter {
  project?: string;
  feature?: string;
  status?: string;
  /** Everything that has not finished one way or the other. */
  open?: boolean;
}

/** Company-scoped, because the orchestrator scopes `/issues` by the caller's company. */
export async function listIssues(
  token: string | null, filter: IssueFilter = {},
): Promise<OpsResult<OpsIssue[]>> {
  // Status filtering goes to the server, which has an index on it. Project and
  // feature live inside `params` as JSON, so they are filtered here.
  const q = filter.status ? `?status=${encodeURIComponent(filter.status)}` : "";
  const [res, steps] = await Promise.all([
    fetchJson<any[]>(token, `/issues${q}`),
    workflowSteps(token),
  ]);
  if (!res.ok || !Array.isArray(res.data)) return { ...res, data: null };

  const eq = (a: unknown, b?: string): boolean =>
    !b || String(a ?? "").toLowerCase() === b.toLowerCase();

  const rows = res.data
    .map(r => shapeIssue(r, steps))
    .filter(i => eq(i.project, filter.project) && eq(i.feature, filter.feature))
    .filter(i => !filter.open || (i.status !== "done" && i.status !== "cancelled"));

  return { ok: true, status: 200, data: rows };
}

/** Spend, by one dimension. Admin-only upstream — a 403 reaches the caller. */
export const spend = (
  token: string | null, query: Record<string, string>,
): Promise<OpsResult<any[]>> =>
  fetchJson<any[]>(token, `/spend?${new URLSearchParams(query)}`);

/** Who did what, across the organisation. Admin-only upstream. */
export const actions = (
  token: string | null, limit = 100,
): Promise<OpsResult<any[]>> =>
  fetchJson<any[]>(token, `/actions?limit=${encodeURIComponent(String(limit))}`);
