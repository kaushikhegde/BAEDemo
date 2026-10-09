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

import { projectStateFromStore, type StoreDocRow } from "./extract-state-store.js";
import type { ProjectExtractState } from "../../scripts/extract-state.mjs";
import { isDiscoveryDocument, type StoreDocument } from "./services/document-list.js";

const BASE = process.env.ORCHESTRATOR_API_URL || "http://127.0.0.1:3100";

export interface Project {
  id: string;
  name: string;
  description?: string | null;
  /**
   * Where this project publishes, or null when Azure DevOps setup has not
   * succeeded yet. Null is what makes a project INCOMPLETE rather than taken,
   * which is the distinction `POST /api/projects` acts on — it used to read
   * `projects/<p>/.published.json` off disk to find it out.
   */
  ado_target?: Record<string, unknown> | null;
}

export interface Feature { id: string; name: string }

export interface DocumentRow {
  path: string;
  category: string | null;
  feature?: string | null;
  /** The store's own id for this version, for reading its bytes back. */
  id?: string;
  /** Content hash. Extraction keys its output by the first 16 characters. */
  sha256?: string;
  /** null means the document belongs to the project itself, not to a feature. */
  featureId?: string | null;
  /**
   * Size, version and creation time, as the platform route returns them
   * (`toRef` in the orchestrator's core/documents.ts). Declared here because
   * the Docs tab renders all three and used to get them from `fs.stat`.
   */
  bytes?: number;
  version?: number;
  createdAt?: string;
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

/**
 * Write the definition to the project ROW, having written the file.
 *
 * `definitions()` below answers "does this project have a definition?" from
 * `projects.description`, and the assistant's whole step-1 behaviour hangs off
 * that answer. But `POST /api/project-description` wrote only
 * `projects/<p>/description.md` — so a definition supplied through the browser,
 * or through the assistant's own `save_project_definition` tool, reached every
 * SKILL and was invisible to the ASSISTANT. It then asked for the definition
 * again on the next turn, and every turn after that, for a project that had one.
 *
 * That is the mirror of the failure `cli/dual.ts` was written to prevent: there,
 * a definition saved to the database alone "looks saved everywhere a person
 * looks and reaches no agent". Here it reached every agent and looked unsaved to
 * every person. Both halves, or neither.
 *
 * Best-effort by design: the file is the artefact the pipeline needs, and a
 * caller with no session or an unreachable orchestrator should still get it
 * written rather than a 500. The return value says which happened, so the route
 * can report a half-write instead of claiming success.
 */
export async function saveDescription(
  token: string | null, project: string, description: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (!token) return { ok: false, reason: "not signed in" };
  try {
    const row = (await listProjects(token)).find(p => p.name === project);
    if (!row) return { ok: false, reason: "no such project in the database" };
    const res = await fetch(`${BASE}/projects/${row.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json", accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ description }),
    });
    return res.ok ? { ok: true } : { ok: false, reason: `orchestrator said ${res.status}` };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Creation — the half the web UI never had
//
// `cli/dual.ts` has always written both sides, because "anything that CREATES
// something has to write to both, or the tool contradicts itself". The wizard
// wrote only the folder tree, so a project created in the browser had no row —
// and every symptom of that appeared somewhere else entirely: the definition
// silently failed to save, spend-by-project filed the run under an anonymous
// row because `issues.project_id` had no name to resolve against, and the
// document store could not be addressed at all because there was no id.
//
// Best-effort, deliberately, and for the same reason `adoError` is: the folder
// tree, the definition and the branding are real and worth keeping. The caller
// reports which half is missing rather than 500ing on work that mostly landed.
// ---------------------------------------------------------------------------

/** What happened on the database side. `exists` is a normal outcome. */
export interface WriteResult {
  state: "created" | "exists" | "failed" | "skipped";
  reason?: string;
  /**
   * The row, when the call produced or found one.
   *
   * `POST /api/projects` needs the id: it writes the row FIRST and then patches
   * the Azure DevOps target and the theme onto it as each is resolved. While
   * the folder tree was the record, a caller only needed to know whether the
   * write had happened, so this carried nothing back.
   */
  project?: Project;
}

async function send(
  token: string, method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json", accept: "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

/**
 * POST raw bytes, with the metadata in the query string.
 *
 * A document used to travel base64'd inside a JSON body, which inflated it by a
 * third and put it under two ceilings: the orchestrator's 100 MB JSON limit and
 * V8's 512 MB cap on a single string. 100 MB of document base64s to 133 MB, so
 * anything over roughly 75 MB failed its row while landing on disk perfectly —
 * silently, because this write is best-effort and its failure is only logged.
 *
 * Raw bytes have neither problem. The metadata goes in the query string because
 * a request cannot have two bodies.
 */
async function sendBinary(
  token: string, path: string, content: Buffer, query: Record<string, string>,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(`${BASE}${path}?${qs}`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
    body: new Uint8Array(content),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

const failureText = (status: number, json: unknown): string =>
  (json as { message?: string; error?: string })?.message ??
  (json as { error?: string })?.error ??
  `orchestrator said ${status}`;

/**
 * The project row. This IS the creation now, not the second half of one.
 *
 * A 409 means one of two very different things — the project is already in YOUR
 * organisation, or the name is held by ANOTHER one, since the folder tree is
 * flat and project names are unique across the install. Reporting both as
 * "already there" sends someone looking in a listing that will never show it.
 */
export async function createProject(
  token: string | null,
  input: { name: string; description?: string; website?: string },
): Promise<WriteResult> {
  if (!token) return { state: "skipped", reason: "not signed in" };
  try {
    const r = await send(token, "POST", "/projects", {
      name: input.name,
      description: input.description?.trim() || null,
      website: input.website?.trim() || null,
    });
    if (r.ok) return { state: "created", project: r.json as Project };
    if (r.status !== 409) return { state: "failed", reason: failureText(r.status, r.json) };

    const row = (await listProjects(token)).find(p => p.name === input.name);
    if (!row) {
      return { state: "exists", reason: "that name is held by another organisation" };
    }
    // Without this the description the wizard just collected is DISCARDED, and
    // the assistant goes on asking for a definition the project has.
    if (input.description?.trim()) {
      const patch = await send(token, "PATCH", `/projects/${row.id}`, {
        description: input.description.trim(),
      });
      return patch.ok
        ? { state: "exists", project: patch.json as Project, reason: "already in the database — definition updated on it" }
        : { state: "exists", project: row, reason: `already in the database; definition not updated (${failureText(patch.status, patch.json)})` };
    }
    return { state: "exists", project: row, reason: "already in the database" };
  } catch (e) {
    return { state: "failed", reason: (e as Error).message };
  }
}

/**
 * Patch a project row — the Azure DevOps target, the theme, the website.
 *
 * Both of the first two used to be written to a FILE and nowhere else:
 * `adoTarget` into `projects/<p>/.published.json`, and the extracted palette
 * into `design/style-guides/theme.json`. `projects.theme` has been a fully
 * supported jsonb column since 002_platform and nothing ever wrote it, so
 * every project in the database carried the default `{}` while its real
 * palette sat on a disk no API could read.
 *
 * Best-effort like every other write here, and the caller reports the reason:
 * a project that exists with no target is incomplete and repairable, which is
 * a much better state to be in than no project at all.
 */
export async function updateProject(
  token: string | null,
  projectId: string,
  patch: { description?: string; website?: string; theme?: Record<string, unknown>; adoTarget?: Record<string, unknown> | null },
): Promise<WriteResult> {
  if (!token) return { state: "skipped", reason: "not signed in" };
  try {
    const r = await send(token, "PATCH", `/projects/${projectId}`, patch);
    return r.ok
      ? { state: "created", project: r.json as Project }
      : { state: "failed", reason: failureText(r.status, r.json) };
  } catch (e) {
    return { state: "failed", reason: (e as Error).message };
  }
}

/** The feature row, under its project's id. */
export async function createFeature(
  token: string | null, input: { project: string; feature: string },
): Promise<WriteResult> {
  if (!token) return { state: "skipped", reason: "not signed in" };
  try {
    const row = (await listProjects(token)).find(p => p.name === input.project);
    // Named apart from any other failure because the fix is a different one:
    // create the project row, not the feature.
    if (!row) return { state: "failed", reason: `project "${input.project}" is not in the database yet` };

    const r = await send(token, "POST", `/projects/${row.id}/features`, { name: input.feature });
    if (r.ok) return { state: "created" };
    if (r.status === 409) return { state: "exists", reason: "already in the database" };
    return { state: "failed", reason: failureText(r.status, r.json) };
  } catch (e) {
    return { state: "failed", reason: (e as Error).message };
  }
}

/**
 * The category a document is counted under.
 *
 * The same vocabulary `--as` writes (`sop`, `transcripts`, `notes`, `ui`,
 * `template`), because `available()` below counts by this field and the
 * assistant's whole sense of what a feature holds comes from those counts. A
 * folder that mapped to nothing would show a feature as having no transcripts
 * with three sitting on disk.
 *
 * Null rather than a guess for anything uncategorised: telling the BA that an
 * SOP is a transcript is worse than telling it nothing, because transcripts are
 * the primary source of stories and SOPs explicitly are not.
 */
export function categoryFor(docPath: string): string | null {
  const parts = String(docPath ?? "").split("/");
  if (parts[0] !== "requirements" || parts.length < 3) return null;
  const sub = parts[1].toLowerCase();
  const map: Record<string, string> = {
    sop: "sop", transcripts: "transcripts", notes: "notes", ui: "ui", templates: "template",
  };
  return map[sub] ?? null;
}

/**
 * Store a document version, having written the file.
 *
 * Best-effort and never fatal to the upload: the file is on disk, which is what
 * every stage reads. What the row buys is the half a PERSON sees — `/docs`, the
 * document counts in the assistant's prompt, and the versioned history behind
 * a replacement.
 */
export async function createDocumentRow(
  token: string | null,
  input: { project: string; feature?: string | null; path: string; content: Buffer },
): Promise<WriteResult> {
  if (!token) return { state: "skipped", reason: "not signed in" };
  try {
    const row = (await listProjects(token)).find(p => p.name === input.project);
    if (!row) return { state: "skipped", reason: "no such project in the database" };

    const r = await sendBinary(token, `/projects/${row.id}/documents`, input.content, {
      ...(input.feature ? { feature: input.feature } : {}),
      path: input.path,
      category: categoryFor(input.path) ?? "",
    });
    return r.ok ? { state: "created" } : { state: "failed", reason: failureText(r.status, r.json) };
  } catch (e) {
    return { state: "failed", reason: (e as Error).message };
  }
}

/**
 * Retire the document row, having removed the file.
 *
 * Absence is SUCCESS here, not failure. The two stores drift apart by design —
 * the chatbot's upload routes wrote only disk for the whole of this repo's
 * history, so most existing documents have no row at all — and disk is the half
 * that decides what every stage reads. Reporting "could not delete" for a file
 * that is demonstrably gone would send someone looking for a problem that has
 * already been solved.
 */
export async function deleteDocumentRow(
  token: string | null, input: { project: string; feature?: string | null; path: string },
): Promise<WriteResult> {
  if (!token) return { state: "skipped", reason: "not signed in" };
  try {
    const row = (await listProjects(token)).find(p => p.name === input.project);
    if (!row) return { state: "skipped", reason: "no such project in the database" };

    const qs = new URLSearchParams({ path: input.path });
    if (input.feature) qs.set("feature", input.feature);
    const res = await fetch(`${BASE}/projects/${row.id}/documents?${qs}`, {
      method: "DELETE",
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
    });
    if (res.ok) return { state: "created" };
    if (res.status === 404) return { state: "exists", reason: "no row for that document" };
    const json = await res.json().catch(() => ({}));
    return { state: "failed", reason: failureText(res.status, json) };
  } catch (e) {
    return { state: "failed", reason: (e as Error).message };
  }
}

export const listFeatures = (token: string | null, projectId: string): Promise<Feature[]> =>
  get<Feature[]>(token, `/projects/${projectId}/features`, []);

/**
 * Document rows for a project.
 *
 * THREE questions, not two, and the platform route models all three: this
 * feature's documents (`feature`), the project's OWN (neither flag), and every
 * document at every level (`all`). Omitting a feature does NOT mean "all" — it
 * means `feature_id is null`.
 *
 * `available()` below got that wrong: it asked with no feature, which returns
 * project-level rows, and then skipped every project-level row to count the
 * feature ones. So the loop always fell through and the assistant was told each
 * feature held zero documents — while nine sat on disk under SAPN.
 */
export const listDocuments = (
  token: string | null, projectId: string,
  opts: { feature?: string; all?: boolean } = {},
): Promise<DocumentRow[]> => {
  const qs = new URLSearchParams();
  if (opts.all) qs.set("all", "true");
  else if (opts.feature) qs.set("feature", opts.feature);
  const q = qs.toString();
  return get<DocumentRow[]>(token, `/projects/${projectId}/documents${q ? `?${q}` : ""}`, []);
};

/**
 * Every document row recorded for a project, by name, at every level.
 *
 * Answers "does the database know about this file?" for the Docs tab. A project
 * with no ROW at all is reported apart from a project whose documents are
 * missing — they read the same on screen ("nothing recorded") and have
 * different fixes.
 */
export async function documentRowsFor(
  token: string | null, project: string,
): Promise<{ projectInDb: boolean; paths: Array<{ path: string; feature: string | null }> }> {
  if (!token) return { projectInDb: false, paths: [] };
  try {
    const row = (await listProjects(token)).find((p) => p.name === project);
    if (!row) return { projectInDb: false, paths: [] };
    const docs = await listDocuments(token, row.id, { all: true });
    return { projectInDb: true, paths: docs.map((d) => ({ path: d.path, feature: d.feature ?? null })) };
  } catch {
    // The orchestrator being unreachable must not fail a list that reads disk.
    // Reported as "nothing recorded", which is what the caller can act on.
    return { projectInDb: false, paths: [] };
  }
}

/**
 * Every document a project holds, as the Docs tab needs them.
 *
 * `documentRowsFor` above answers a narrower question — "does the database know
 * about this file?" — and is keyed on path alone, which is why it could never
 * have been the LIST: it drops the size, the version and the feature name, and
 * its `d.feature` is always undefined because the platform route returns
 * `featureId`, not a name. This resolves the name the way `extractState` does,
 * from the feature list.
 *
 * The level split matches the disk walk it replaces: the project's own material
 * is returned whether or not a feature was asked for, because a feature is
 * always read in the context of its project and the two share a screen.
 */
export async function documentsFor(
  token: string | null, project: string, feature: string | null,
): Promise<{ projectInDb: boolean; documents: StoreDocument[] }> {
  if (!token) return { projectInDb: false, documents: [] };
  try {
    const row = (await listProjects(token)).find((p) => p.name === project);
    if (!row) return { projectInDb: false, documents: [] };

    const [docs, features] = await Promise.all([
      listDocuments(token, row.id, { all: true }),
      listFeatures(token, row.id),
    ]);
    const nameOf = new Map(features.map((f) => [f.id, f.name]));

    const documents = docs
      .map((d) => ({
        path: d.path,
        feature: d.featureId ? nameOf.get(d.featureId) ?? null : null,
        bytes: Number(d.bytes ?? 0),
        createdAt: d.createdAt ?? "",
        version: Number(d.version ?? 1),
        category: d.category ?? null,
      }))
      // `all: true` is one round trip for both levels; the filtering is here
      // rather than in the query so a feature's documents and its project's
      // come back together.
      .filter((d) => d.feature === null || d.feature === feature)
      // The store holds every document a project owns, generated artefacts
      // included. The tab wants what the CLIENT gave us.
      .filter((d) => isDiscoveryDocument(d.path, d.feature));

    return { projectInDb: true, documents };
  } catch {
    // The orchestrator being unreachable must not fail the tab. Reported as
    // "nothing recorded", which is a state the route already renders, and the
    // disk walk still contributes whatever it can find.
    return { projectInDb: false, documents: [] };
  }
}

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
    const docs = await listDocuments(token, project.id, { all: true });
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

/**
 * Record one chat turn — the user's message and the assistant's reply —
 * against a conversation in the database.
 *
 * The `conversations` and `messages` tables, the store methods behind them and
 * their HTTP routes have existed since the platform migration and **nothing
 * ever wrote to them**: `scyne chat history` reads those tables, so it printed
 * "(no conversations yet)" for every installation, always. The transcript
 * lived in the browser's localStorage alone, which meant it was per-device,
 * invisible to the CLI, and lost the moment someone cleared their site data.
 *
 * Best-effort and never fatal, exactly like `createDocumentRow`: the reply is
 * what the person is waiting for, and losing the record of a conversation is a
 * far smaller harm than failing the conversation itself. The caller reports
 * the outcome rather than throwing on it.
 *
 * The caller's own token, so a conversation is filed against the person who
 * had it and is invisible to anyone who could not see it anyway.
 */
export async function recordChatTurn(
  token: string | null,
  input: {
    conversationId?: string | null;
    project?: string | null;
    feature?: string | null;
    userMessage: unknown;
    assistantMessage: unknown;
  },
): Promise<WriteResult & { conversationId?: string }> {
  if (!token) return { state: "skipped", reason: "not signed in" };
  try {
    let conversationId = input.conversationId ?? null;

    if (!conversationId) {
      // Resolve the target to ids where we can. Both are optional on the row,
      // and a chat that has not settled on a project yet is a normal state —
      // so an unresolved name leaves null rather than refusing to record.
      let projectId: string | null = null;
      let featureId: string | null = null;
      if (input.project) {
        const row = (await listProjects(token)).find(p => p.name === input.project);
        projectId = row?.id ?? null;
        if (row && input.feature) {
          const f = (await listFeatures(token, row.id)).find(x => x.name === input.feature);
          featureId = f?.id ?? null;
        }
      }

      const created = await send(token, "POST", "/conversations", {
        projectId, featureId, title: titleFor(input.userMessage),
      });
      if (!created.ok) return { state: "failed", reason: failureText(created.status, created.json) };
      conversationId = (created.json as { id?: string })?.id ?? null;
      if (!conversationId) return { state: "failed", reason: "the orchestrator created no conversation id" };
    }

    for (const [role, content] of [["user", input.userMessage], ["assistant", input.assistantMessage]] as const) {
      const r = await send(token, "POST", `/conversations/${conversationId}/messages`, { role, content });
      if (!r.ok) return { state: "failed", reason: failureText(r.status, r.json), conversationId };
    }
    return { state: "created", conversationId };
  } catch (e) {
    return { state: "failed", reason: (e as Error).message };
  }
}

/** A conversation's title: the opening of whatever the person first said. */
function titleFor(message: unknown): string | null {
  const text = typeof message === "string"
    ? message
    : Array.isArray(message)
      ? message.map((b: { text?: string }) => b?.text ?? "").join(" ")
      : "";
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  return trimmed.length > 80 ? trimmed.slice(0, 79) + "…" : trimmed;
}


/**
 * The conversation a project is currently on, with its messages.
 *
 * A chat belongs to a PROJECT: `conversations.project_id` has carried one since
 * the platform migration, but the browser held a single conversation id across
 * every project it switched between — so a chat begun under one client kept
 * being appended to while the person talked about another.
 *
 * The most recently updated conversation for the project is the one to resume;
 * `listConversations` already orders by `updated_at desc` and already scopes to
 * the caller, so this reads the first row rather than choosing.
 *
 * Best-effort, like everything else here: an unresolvable project or an
 * unreachable orchestrator returns null and the caller opens an empty chat. A
 * chat that will not load must never be a chat that will not start.
 */
export async function loadProjectChat(
  token: string | null,
  project: string,
): Promise<{ conversationId: string; messages: { role: string; content: unknown }[] } | null> {
  if (!token || !project) return null;
  try {
    const row = (await listProjects(token)).find(p => p.name === project);
    if (!row) return null;

    const convos = await fetchJson<{ id: string }[]>(
      token, `/conversations?projectId=${encodeURIComponent(row.id)}`);
    const latest = convos.data?.[0];
    if (!latest?.id) return null;

    const msgs = await fetchJson<{ role: string; content: unknown }[]>(
      token, `/conversations/${latest.id}/messages`);
    return { conversationId: latest.id, messages: msgs.data ?? [] };
  } catch {
    return null;
  }
}

/**
 * Forget every conversation this caller has had about a project.
 *
 * Scoped to the project rather than to the installation: `scyne reset --all` is
 * the only thing that used to clear a chat, and it takes users, projects and
 * documents with it. Clearing one client's thread should not be that.
 *
 * The orchestrator deletes the messages by cascade and refuses an id the caller
 * does not own, so this loops over what it was allowed to list in the first
 * place and cannot reach anyone else's.
 */
export async function clearProjectChat(
  token: string | null,
  project: string,
): Promise<WriteResult & { cleared?: number }> {
  if (!token) return { state: "skipped", reason: "not signed in" };
  if (!project) return { state: "skipped", reason: "no project" };
  try {
    const row = (await listProjects(token)).find(p => p.name === project);
    if (!row) return { state: "skipped", reason: `no such project in the database: ${project}` };

    const convos = await fetchJson<{ id: string }[]>(
      token, `/conversations?projectId=${encodeURIComponent(row.id)}`);
    if (!convos.ok) return { state: "failed", reason: `could not list conversations (${convos.status})` };

    let cleared = 0;
    for (const c of convos.data ?? []) {
      const r = await send(token, "DELETE", `/conversations/${c.id}`);
      if (r.ok) cleared++;
      // A 404 means it is already gone, which is the outcome asked for.
      else if (r.status !== 404) return { state: "failed", reason: failureText(r.status, r.json), cleared };
    }
    return { state: "created", cleared };
  } catch (e) {
    return { state: "failed", reason: (e as Error).message };
  }
}

/**
 * One document's bytes, by its path within a project.
 *
 * The companion app used to be read straight off disk with `fs.readFile` from
 * `generated-apps/<project>/`. Once a step works in a scratch tree that is
 * discarded when the step ends, that directory is not there afterwards — the
 * rendered page is in the store, attributed by `attribute()` at PROJECT level
 * under its work-root-relative path.
 *
 * Two calls because the platform API addresses a document by id: list with a
 * path filter, then read that id as raw bytes. Null rather than a throw for
 * "not there", because a project whose app has never been rendered is an
 * ordinary state the route reports as `not_generated`.
 */
export async function readDocumentByPath(
  token: string | null, project: string, docPath: string,
  /**
   * Which level the path belongs to: a feature's name, or null for the
   * project itself. Omit it to match on path alone. A feature's artefacts need
   * it — every feature has its own `outputs/product-summary.md`.
   */
  level?: { feature: string | null },
): Promise<Buffer | null> {
  if (!token) return null;
  try {
    const row = (await listProjects(token)).find(p => p.name === project);
    if (!row) return null;

    const q = new URLSearchParams({ prefix: docPath, all: "true" });
    const listed = await get<Array<{ id: string; path: string; feature?: string | null }>>(
      token, `/projects/${row.id}/documents?${q}`, []);
    const hit = listed.find(d =>
      d.path === docPath && (!level || (d.feature ?? null) === level.feature));
    if (!hit) return null;

    // Raw, not base64: a companion app is megabytes and there is no reason to
    // inflate it by a third to move it between two local processes.
    const res = await fetch(`${BASE}/projects/${row.id}/documents/${hit.id}`, {
      headers: { accept: "application/octet-stream", authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Extraction state for a project, computed from the STORE.
 *
 * The disk equivalent is `projectState` in `scripts/extract-state.mjs`, and it
 * stays where it is: inside a materialised tree, during a run, walking disk is
 * the right thing to do. Outside one it is not, and that stopped being an
 * academic distinction when the plugin's ingest began writing documents to the
 * store and not to `projects/<p>/documents/` — the walk answered "0 documents"
 * for a project holding nine, `capabilities` refused with
 * `documents_not_ready`, and no retry could have fixed it.
 *
 * Reads are bounded: one document list, one feature list, and one fetch per
 * document that HAS an extract. An extract is roughly a kilobyte, so a
 * fifty-document project costs fifty small reads — the price of keeping the
 * guarantee that a malformed extract is reported `failed` rather than `ready`,
 * which is the whole reason the disk version parses them too.
 */
export async function extractState(
  token: string | null, project: string,
): Promise<ProjectExtractState | null> {
  if (!token) return null;
  const row = (await listProjects(token)).find((p) => p.name === project);
  if (!row) return null;

  const [docs, features] = await Promise.all([
    listDocuments(token, row.id, { all: true }),
    listFeatures(token, row.id),
  ]);

  const rows: StoreDocRow[] = docs
    // A row with no hash cannot be keyed to an extract. Dropped rather than
    // reported `missing`, which would invite a retry that could not help.
    .filter((d): d is DocumentRow & { sha256: string } => typeof d.sha256 === "string")
    .map((d) => ({ path: d.path, sha256: d.sha256, featureId: d.featureId ?? null }));

  const byKey = new Map(docs.map((d) => [`${d.featureId ?? ""} ${d.path}`, d.id]));
  const read = async (path: string, featureId: string | null): Promise<string | null> => {
    const id = byKey.get(`${featureId ?? ""} ${path}`);
    if (!id) return null;
    try {
      const res = await fetch(`${BASE}/projects/${row.id}/documents/${id}`, {
        headers: { accept: "application/octet-stream", authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      return await res.text();
    } catch { return null; }
  };

  return await projectStateFromStore(rows, new Map(features.map((f) => [f.id, f.name])), read);
}
