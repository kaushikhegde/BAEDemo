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
