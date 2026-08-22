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
}

async function send(
  token: string, method: "POST" | "PATCH", path: string, body: unknown,
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

const failureText = (status: number, json: unknown): string =>
  (json as { message?: string; error?: string })?.message ??
  (json as { error?: string })?.error ??
  `orchestrator said ${status}`;

/**
 * The project row, having written the folder tree.
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
    if (r.ok) return { state: "created" };
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
        ? { state: "exists", reason: "already in the database — definition updated on it" }
        : { state: "exists", reason: `already in the database; definition not updated (${failureText(patch.status, patch.json)})` };
    }
    return { state: "exists", reason: "already in the database" };
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

    const r = await send(token, "POST", `/projects/${row.id}/documents`, {
      ...(input.feature ? { feature: input.feature } : {}),
      path: input.path,
      category: categoryFor(input.path),
      // Not an optimisation — a .docx or a screenshot cannot survive a JSON
      // string, and silently corrupting one is discovered much later, by a
      // model reading gibberish.
      encoding: "base64",
      content: input.content.toString("base64"),
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
