/**
 * Confirm the Atlassian target exists, before a publish step reaches it.
 *
 * The Confluence/Jira counterpart of `adoVerify.ts`, and it keeps that module's
 * governing rule: **VERIFY ONLY, NEVER CREATE.**
 *
 * That rule is worth restating here because this is precisely where it was
 * broken before. `atlassianProvision.ts` — the module retired when publishing
 * moved to Azure DevOps — CREATED a missing Jira project or Confluence space at
 * approval time. It is tempting to restore that along with everything else, and
 * it should not be: a space or project conjured into a client's site at the
 * moment somebody clicks Approve is a decision about where their documents live
 * being made by a gate handler. A half-provisioned space is a worse thing to
 * hand a client than a clear refusal, and the refusal costs nothing.
 *
 * So this answers one question — "will the publish work?" — and says precisely
 * what is wrong when the answer is no.
 *
 * Credentials are the API token, Basic, against the SITE domain. The MCP's
 * OAuth token cannot be used: it is only valid against api.atlassian.com and
 * carries no attachment scope, so it would fail here in a way that reads like a
 * permissions problem rather than a wrong-credential one.
 */

const CONFLUENCE_V2 = "/wiki/api/v2";
const JIRA_V2 = "/rest/api/2";

export interface AtlassianTarget {
  /** Confluence space KEY, e.g. "SAPN". */
  space: string;
  /** True when the flow will also create Jira issues. */
  needsIssues?: boolean;
  /** Jira project KEY, when the flow declares one. */
  jiraProject?: string;
  /**
   * The type stories will be created as, when the flow declares one.
   *
   * Checked by NAME for the same reason the Azure path checks its work item
   * type by name: a value the project does not have fails every story, AFTER
   * the gate was approved and the page published, which is the expensive
   * moment to find out.
   */
  issueType?: string;
}

export interface AtlassianCheck {
  ok: boolean;
  checks: Array<{ label: string; ok: boolean; detail: string }>;
  /** One line a human can act on, or "" when everything passed. */
  summary: string;
}

function creds(): { site: string; auth: string } | null {
  const rawSite = process.env.ATLASSIAN_SITE_URL;
  const email = process.env.ATLASSIAN_EMAIL;
  const token = process.env.ATLASSIAN_API_TOKEN;
  if (!rawSite || !email || !token) return null;
  const site = (/^https?:\/\//.test(rawSite)
    ? rawSite
    : `https://${rawSite.includes(".") ? rawSite : `${rawSite}.atlassian.net`}`).replace(/\/+$/, "");
  return { site, auth: "Basic " + Buffer.from(`${email}:${token}`).toString("base64") };
}

/** True when there is enough configuration to check anything at all. */
export function atlassianConfigured(): boolean {
  return creds() !== null;
}

async function get(url: string, auth: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url, { headers: { Authorization: auth, Accept: "application/json" } })
    .catch(() => null);
  if (!res) return { status: 0, body: "network error" };
  return { status: res.status, body: await res.text() };
}

export async function verifyAtlassianTarget(target: AtlassianTarget): Promise<AtlassianCheck> {
  const checks: AtlassianCheck["checks"] = [];
  const add = (label: string, ok: boolean, detail = "") => checks.push({ label, ok, detail });

  const c = creds();
  if (!c) {
    add("credentials present", false,
      "Set ATLASSIAN_SITE_URL, ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN in the workspace root .env.");
    return { ok: false, checks, summary: "No Atlassian credentials are configured." };
  }

  // Unlike Azure DevOps — which answers a missing SCOPE with 401 and makes a
  // permissions fault look like a bad token — Atlassian separates them: 401 is
  // the credential, 403 is what this user may do. The messages say so, because
  // the two send an operator to completely different places.
  const spaces = await get(
    `${c.site}${CONFLUENCE_V2}/spaces?keys=${encodeURIComponent(target.space)}`, c.auth);

  if (spaces.status === 200) {
    let found: Array<{ key?: string }> = [];
    try { found = JSON.parse(spaces.body).results ?? []; } catch { /* shape drift */ }
    add("the space exists", found.length > 0,
      found.length
        ? target.space
        : `No Confluence space '${target.space}' is visible to this user. Publishing will NOT ` +
          `create it — create it in Confluence, or correct atlassianTarget.space in ` +
          `projects/<project>/.published.json.`);
  } else {
    add("Confluence reachable", false,
      spaces.status === 401
        ? "401 — the credential is rejected. With Basic auth this is nearly always " +
          "ATLASSIAN_EMAIL not matching the account that created the token."
        : spaces.status === 403
        ? "403 — the token is valid and this user cannot read spaces. That is a permission, " +
          "not a credential."
        : `HTTP ${spaces.status}`);
  }

  if (target.needsIssues) {
    if (!target.jiraProject) {
      add("a Jira project", false,
        "This flow creates one issue per story and no jiraProject is recorded. Add it to " +
        "atlassianTarget in projects/<project>/.published.json.");
    } else {
      const key = encodeURIComponent(target.jiraProject);
      const proj = await get(`${c.site}${JIRA_V2}/project/${key}`, c.auth);
      add("the Jira project exists", proj.status === 200,
        proj.status === 200 ? target.jiraProject
          : proj.status === 404 ? `No Jira project '${target.jiraProject}' is visible to this user.`
          : proj.status === 403 ? "403 — a permission on that project, not a bad credential."
          : `HTTP ${proj.status}`);

      if (proj.status === 200) {
        const meta = await get(
          `${c.site}${JIRA_V2}/issue/createmeta?projectKeys=${key}&expand=projects.issuetypes`,
          c.auth);
        if (meta.status === 200) {
          let types: string[] = [];
          try {
            const p = (JSON.parse(meta.body).projects ?? [])[0];
            // Sub-tasks are excluded: they cannot exist without a parent, so a
            // backlog of them would fail one story at a time.
            types = (p?.issuetypes ?? [])
              .filter((t: { subtask?: boolean }) => !t.subtask)
              .map((t: { name: string }) => t.name);
          } catch { /* shape drift */ }

          if (target.issueType) {
            add(`issue type '${target.issueType}' exists`, types.includes(target.issueType),
              types.includes(target.issueType)
                ? target.issueType
                : `The project has no '${target.issueType}'. It has: ${types.join(", ")}. ` +
                  `Correct atlassianTarget.issueType in projects/<project>/.published.json.`);
          } else {
            // The type is DISCOVERED at publish time (scripts/jira-issues.mjs),
            // so this only has to confirm there is something usable to discover.
            const usable = ["Story", "User Story", "Task", "Requirement"].filter(t => types.includes(t));
            add("an issue type for stories", usable.length > 0,
              usable.length
                ? usable[0]
                : `The project has none of Story / Task / Requirement. It has: ${types.join(", ")}`);
          }
        } else {
          add("issue types readable", false,
            meta.status === 403
              ? "403 — this user cannot create issues in that project."
              : `HTTP ${meta.status}`);
        }
      }
    }
  }

  const failed = checks.filter(c2 => !c2.ok);
  return {
    ok: failed.length === 0,
    checks,
    summary: failed.length ? failed.map(f => `${f.label}: ${f.detail}`).join(" · ") : "",
  };
}
