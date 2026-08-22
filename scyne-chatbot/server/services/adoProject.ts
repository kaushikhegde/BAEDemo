/**
 * Create an Azure DevOps project for a Scyne project, and its wiki.
 *
 * This deliberately does NOT live in `adoVerify.ts`, whose contract is
 * "verify, never create". That rule was written because a half-created project
 * is worse to hand a client than a clear refusal — which is still true, and is
 * why everything here polls to a TERMINAL state and reports the operation's own
 * failure text rather than a generic one.
 *
 * What changed is only WHERE creation happens: in the New Project wizard, where
 * the user is still present and nothing has been generated yet — not at an
 * approval gate, after a document exists and a human has approved it.
 *
 * It is safe to call on a project that already exists: step 1 short-circuits,
 * which is what makes a wizard run whose Azure DevOps step failed resumable
 * rather than stranded.
 */

const API = "7.1";

export interface AdoTargetRecord {
  org: string;
  project: string;
  wiki: string;
  wikiId: string;
  processTemplate: string;
  workItemType: string;
  createdAt: string;
}

export type EnsureResult =
  | { ok: true; target: AdoTargetRecord }
  | { ok: false; error: string };

function pat(): string | null {
  return process.env.ADO_PAT || process.env.MCP_TOKEN_FOR_AZURE || null;
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: "Basic " + Buffer.from(`:${token}`).toString("base64"),
    Accept: `application/json;api-version=${API}`,
    "Content-Type": "application/json",
  };
}

/**
 * Azure DevOps answers a MISSING SCOPE with 401, not 403 — so a message here
 * must never advise regenerating a token that was never the problem.
 */
function explain(status: number, body: string): string {
  if (status === 401) {
    return "401 from Azure DevOps. The token is probably valid and missing a scope — " +
      "creating a project needs vso.project_manage, and a wiki needs vso.wiki_write.";
  }
  try {
    const parsed = JSON.parse(body);
    if (parsed?.message) return String(parsed.message);
  } catch { /* not JSON — fall through to the raw body */ }
  return `HTTP ${status}. ${body.slice(0, 300)}`;
}

async function call(
  url: string, token: string, init: RequestInit = {},
): Promise<{ ok: boolean; status: number; body: string; json: any }> {
  const res = await fetch(url, { ...init, headers: { ...headers(token), ...(init.headers ?? {}) } })
    .catch(() => null);
  if (!res) return { ok: false, status: 0, body: "no response from dev.azure.com", json: null };
  const body = await res.text();
  let json: any = null;
  try { json = body ? JSON.parse(body) : null; } catch { /* left null */ }
  return { ok: res.ok, status: res.status, body, json };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function ensureAdoProject(opts: {
  org: string;
  project: string;
  processTemplate?: string;
  /**
   * A PREFERENCE, not an assertion. Absent, or present and unavailable, and
   * the type is discovered from what the project actually has.
   *
   * Use `requireWorkItemType` for the other meaning.
   */
  workItemType?: string;
  /**
   * Fail rather than discover when `workItemType` is not available.
   *
   * For a caller that TYPED a type — the CLI's `--work-item-type` — where
   * being wrong is worth hearing about rather than absorbing.
   */
  requireWorkItemType?: boolean;
}): Promise<EnsureResult> {
  const token = pat();
  if (!token) {
    return { ok: false, error: "No Azure DevOps token (ADO_PAT or MCP_TOKEN_FOR_AZURE) in the root .env." };
  }

  const { org, project } = opts;
  const templateName = opts.processTemplate ?? "Agile";
  const wantType = opts.workItemType ?? "User Story";
  // Every story-bearing type across the templates, best first. Agile calls it
  // "User Story" and Basic calls it "Issue" — the two this installation has
  // met, and the pair CLAUDE.md documents. "Product Backlog Item" (Scrum) and
  // "Requirement" (CMMI) complete the standard set.
  const STORY_TYPES = [wantType, "User Story", "Issue", "Product Backlog Item", "Requirement"];
  const orgUrl = `https://dev.azure.com/${encodeURIComponent(org)}`;
  const projUrl = `${orgUrl}/${encodeURIComponent(project)}`;

  // 1. Already there? Creating is idempotent from the caller's point of view,
  //    which is what makes a failed wizard run resumable.
  const existing = await call(`${orgUrl}/_apis/projects/${encodeURIComponent(project)}?api-version=${API}`, token);
  if (!existing.ok && existing.status !== 404) {
    return { ok: false, error: explain(existing.status, existing.body) };
  }

  if (!existing.ok) {
    // 2. Resolve the process template BY NAME. A hardcoded GUID is correct in
    //    one organisation and a silent failure in every other.
    const processes = await call(`${orgUrl}/_apis/process/processes?api-version=${API}`, token);
    if (!processes.ok) return { ok: false, error: explain(processes.status, processes.body) };

    const template = (processes.json?.value ?? [])
      .find((p: any) => String(p.name).toLowerCase() === templateName.toLowerCase());
    if (!template) {
      const names = (processes.json?.value ?? []).map((p: any) => p.name).join(", ");
      return { ok: false, error: `No "${templateName}" process template in ${org}. Available: ${names}.` };
    }

    // 3. Create. Returns 202 and an operation id — the project does not exist yet.
    //    ADO validates the name itself (TF50316 covers length, illegal
    //    characters and reserved names), so its message is surfaced rather
    //    than second-guessed by a regex of ours.
    const created = await call(`${orgUrl}/_apis/projects?api-version=${API}`, token, {
      method: "POST",
      body: JSON.stringify({
        name: project,
        description: `Scyne delivery pack for ${project}.`,
        capabilities: {
          versioncontrol: { sourceControlType: "Git" },
          processTemplate: { templateTypeId: template.id },
        },
      }),
    });
    if (!created.ok) return { ok: false, error: explain(created.status, created.body) };

    const operationId = created.json?.id;
    if (!operationId) {
      return { ok: false, error: "Azure DevOps accepted the create but returned no operation id." };
    }

    // 4. Poll to a TERMINAL state. Reporting success before the project is
    //    usable is exactly how a half-created project reaches a client.
    let state = "queued";
    for (let i = 0; i < 60 && state !== "succeeded"; i++) {
      await sleep(2000);
      const op = await call(`${orgUrl}/_apis/operations/${operationId}?api-version=${API}`, token);
      if (!op.ok) return { ok: false, error: explain(op.status, op.body) };
      state = String(op.json?.status ?? "queued");
      if (state === "failed" || state === "cancelled") {
        const why = op.json?.detailedMessage ?? op.json?.resultMessage ?? "no reason given";
        return { ok: false, error: `Project creation ${state}: ${why}` };
      }
    }
    if (state !== "succeeded") {
      return {
        ok: false,
        error: `Project creation did not finish within two minutes (last state: ${state}). ` +
          `It may still complete — check ${orgUrl} before retrying.`,
      };
    }
  }

  // 5. The wiki. A brand-new project has none, and a publish step must not be
  //    the thing that decides where a client's documents live.
  const wikis = await call(`${projUrl}/_apis/wiki/wikis?api-version=${API}`, token);
  if (!wikis.ok) return { ok: false, error: explain(wikis.status, wikis.body) };

  let wiki = (wikis.json?.value ?? [])[0];
  if (!wiki) {
    // The project id is required to create a project wiki, and after a fresh
    // create we have not fetched it — so read it now rather than trusting the
    // 404 response from step 1.
    const fetched = await call(`${orgUrl}/_apis/projects/${encodeURIComponent(project)}?api-version=${API}`, token);
    if (!fetched.ok) return { ok: false, error: explain(fetched.status, fetched.body) };

    const madeWiki = await call(`${projUrl}/_apis/wiki/wikis?api-version=${API}`, token, {
      method: "POST",
      body: JSON.stringify({ name: `${project}.wiki`, projectId: fetched.json?.id, type: "projectWiki" }),
    });
    if (!madeWiki.ok) return { ok: false, error: explain(madeWiki.status, madeWiki.body) };
    wiki = madeWiki.json;
  }
  if (!wiki?.id) return { ok: false, error: `Could not resolve a wiki in "${project}".` };

  // 6. Confirm the work item type exists BY NAME. The publishing agent is
  //    handed this exact string and told not to substitute a familiar-sounding
  //    one, so a wrong value fails every story at once — after the gate was
  //    approved and the wiki page already published.
  const types = await call(`${projUrl}/_apis/wit/workitemtypes?api-version=${API}`, token);
  if (!types.ok) return { ok: false, error: explain(types.status, types.body) };
  const names = (types.json?.value ?? []).map((t: any) => String(t.name));

  // Asserting a type an EXISTING project does not have is how this blocked a
  // publish that was otherwise fine: the default is Agile's "User Story", and
  // SA-Power-Networks runs Basic — Epic, Issue, Task, no User Story anywhere.
  // The step meant to guarantee somewhere to publish TO refused a project that
  // had been publishing happily.
  //
  // So the default is now a preference and gets resolved against reality, the
  // way `ado-workitems.mjs` has always discovered the type rather than
  // insisting on one. A caller that explicitly requires a type still gets an
  // assertion — being wrong about one you typed is worth hearing.
  const resolvedType = STORY_TYPES.find((t) => names.includes(t));
  if (opts.requireWorkItemType && !names.includes(wantType)) {
    return { ok: false, error: `"${project}" has no "${wantType}" work item type. It has: ${names.join(", ")}.` };
  }
  if (!resolvedType) {
    return {
      ok: false,
      error: `"${project}" has no work item type stories can be created as ` +
        `(looked for ${STORY_TYPES.filter((t, i) => STORY_TYPES.indexOf(t) === i).map(t => `"${t}"`).join(", ")}). ` +
        `It has: ${names.join(", ")}.`,
    };
  }

  return {
    ok: true,
    target: {
      org,
      project,
      wiki: String(wiki.name),
      wikiId: String(wiki.id),
      processTemplate: templateName,
      // What the project HAS, not what was hoped for — this is written into
      // .published.json by both callers, so a wrong recorded value corrects
      // itself on the next run rather than blocking every publish after it.
      workItemType: resolvedType,
      createdAt: new Date().toISOString(),
    },
  };
}
