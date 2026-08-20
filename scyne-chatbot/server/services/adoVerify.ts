/**
 * Confirm the Azure DevOps target exists, before a publish step reaches it.
 *
 * VERIFY ONLY, NEVER CREATE — which is the whole difference from
 * `atlassianProvision.ts`, the module this replaces. That one created a missing
 * Jira project or Confluence space at approval time. The equivalent here is not
 * available on the same terms: creating an ADO project is a LONG-RUNNING
 * ASYNCHRONOUS operation that returns an operation id to poll, and a
 * half-created project is a worse state to hand a client than a clear refusal.
 * Creating a wiki is a one-off decision about where a client's documents live,
 * which is not a call a publish step should make on its own either.
 *
 * So this answers one question — "will the publish work?" — and says precisely
 * what is wrong when the answer is no.
 */

const API = "7.1";

export interface AdoTarget {
  org: string;
  project: string;
  /** Optional: when absent, any wiki will do — the publish step resolves it. */
  wiki?: string;
  /** True when the flow will also create work items. */
  needsWorkItems?: boolean;
  /**
   * The type stories will be created as, when the flow declares one.
   *
   * Checked by NAME, not merely "is there something usable": the publishing
   * agent is handed this exact string and told not to substitute a
   * familiar-sounding one, so a value the project does not have fails every
   * story — and it would fail AFTER the gate was approved and the wiki page
   * published, which is the expensive moment to discover it.
   */
  workItemType?: string;
}

export interface AdoCheck {
  ok: boolean;
  checks: Array<{ label: string; ok: boolean; detail: string }>;
  /** One line a human can act on, or "" when everything passed. */
  summary: string;
}

function pat(): string | null {
  return process.env.ADO_PAT || process.env.MCP_TOKEN_FOR_AZURE || null;
}

/** True when there is enough configuration to check anything at all. */
export function adoConfigured(): boolean {
  return Boolean(pat() && (process.env.ADO_ORG || process.env.ADO_PROJECT));
}

async function get(url: string, token: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    headers: {
      Authorization: "Basic " + Buffer.from(`:${token}`).toString("base64"),
      Accept: `application/json;api-version=${API}`,
    },
  }).catch(() => null);
  if (!res) return { status: 0, body: "network error" };
  return { status: res.status, body: await res.text() };
}

export async function verifyAdoTarget(target: AdoTarget): Promise<AdoCheck> {
  const token = pat();
  const checks: AdoCheck["checks"] = [];
  const add = (label: string, ok: boolean, detail = "") => checks.push({ label, ok, detail });

  if (!token) {
    add("token present", false, "Set ADO_PAT (or MCP_TOKEN_FOR_AZURE) in the workspace root .env.");
    return { ok: false, checks, summary: "No Azure DevOps token is configured." };
  }

  const org = encodeURIComponent(target.org);
  const project = encodeURIComponent(target.project);

  const proj = await get(`https://dev.azure.com/${org}/_apis/projects/${project}?api-version=${API}`, token);
  add("project exists", proj.status === 200,
    proj.status === 200 ? target.project
      : proj.status === 401 ? "401 — the token is rejected, or lacks project read scope."
      : `HTTP ${proj.status}`);

  // Azure DevOps answers a MISSING SCOPE with 401, not 403, so a wiki 401
  // beside a project 200 is not a bad token — it is a token without
  // vso.wiki_write. Saying which is the difference between ticking one box and
  // regenerating a credential that was never the problem.
  const wikis = await get(
    `https://dev.azure.com/${org}/${project}/_apis/wiki/wikis?api-version=${API}`, token);
  if (wikis.status === 200) {
    let names: string[] = [];
    try { names = (JSON.parse(wikis.body).value ?? []).map((w: { name: string }) => w.name); } catch { /* shape drift */ }
    if (!names.length) {
      add("a wiki exists", false, "The project has no wiki. Create one in Azure DevOps — publishing will not create it.");
    } else if (target.wiki && !names.includes(target.wiki)) {
      add("the named wiki exists", false, `No wiki '${target.wiki}'. There is: ${names.join(", ")}`);
    } else if (!target.wiki && names.length > 1) {
      add("which wiki", false, `The project has ${names.length} wikis (${names.join(", ")}). Name one.`);
    } else {
      add("wiki reachable", true, target.wiki ?? names[0]);
    }
  } else {
    add("wiki scope", false,
      wikis.status === 401 && proj.status === 200
        ? "401 on the wiki API while the project API works — the token is valid but has no " +
          "wiki scope. Add vso.wiki_write at dev.azure.com/<org>/_usersSettings/tokens."
        : `HTTP ${wikis.status}`);
  }

  if (target.needsWorkItems) {
    const wit = await get(
      `https://dev.azure.com/${org}/${project}/_apis/wit/workitemtypes?api-version=${API}`, token);
    if (wit.status === 200) {
      let types: string[] = [];
      try { types = (JSON.parse(wit.body).value ?? []).map((t: { name: string }) => t.name); } catch { /* shape drift */ }
      // The type is DISCOVERED at publish time (scripts/ado-workitems.mjs), so
      // this only has to confirm there is something usable to discover.
      if (target.workItemType) {
        add(`work item type '${target.workItemType}' exists`, types.includes(target.workItemType),
          types.includes(target.workItemType)
            ? target.workItemType
            : `The project has no '${target.workItemType}'. It has: ${types.join(", ")}. ` +
              `Set ADO_WORK_ITEM_TYPE to one of those.`);
      } else {
        const usable = ["User Story", "Product Backlog Item", "Issue", "Requirement", "Task"]
          .filter(t => types.includes(t));
        add("a work item type for stories", usable.length > 0,
          usable.length ? usable[0] : `The project has none of User Story / Issue / Task. It has: ${types.join(", ")}`);
      }
    } else {
      add("work item scope", false,
        wit.status === 401 ? "401 — the token has no work item scope (vso.work_write)." : `HTTP ${wit.status}`);
    }
  }

  const failed = checks.filter(c => !c.ok);
  return {
    ok: failed.length === 0,
    checks,
    summary: failed.length ? failed.map(f => `${f.label}: ${f.detail}`).join(" · ") : "",
  };
}
