/**
 * Shared Atlassian access for the publishing scripts.
 *
 * TWO CREDENTIALS, AND THE SPLIT IS THE POINT
 * -------------------------------------------
 * Publishing goes through the Atlassian MCP: the agent calls its tools to
 * create and update pages and issues, the same way the Azure DevOps path calls
 * `wiki_upsert_page`. What the MCP cannot do, this module does over REST with
 * an API token:
 *
 *   attachments — the MCP's OAuth grant carries twenty scopes, eight of them
 *                 Confluence, and NONE for attachments, so
 *                 `POST .../child/attachment` answers 401 "scope does not
 *                 match" whichever host it is sent to. That list is fixed by
 *                 Atlassian's own OAuth app, so re-authorising does not add it.
 *                 The symptom is the bad one: a page that publishes cleanly
 *                 with its diagrams SILENTLY missing.
 *
 *   large bodies — measured on run SCY-6: an agent told to pass a 110 KB data
 *                 model as a tool argument read it three times assembling the
 *                 call, compacted thirteen minutes in and published nothing,
 *                 for $2.73. Moving bytes is not a reasoning task.
 *
 * The API token authenticates with **Basic auth against the SITE domain**
 * (`your-site.atlassian.net`). A 3LO bearer from the MCP is only valid against
 * `api.atlassian.com` — reusing it here is the second, independent way a
 * hand-rolled call has failed, and it fails looking exactly like the first.
 *
 * Credentials come from the workspace-root `.env`, the same file the
 * orchestrator config loads — never from `.mcp.json`, which is committed, and
 * a token in that file is a token in the git history.
 */

import path from "node:path";
import { INSTALL_ROOT } from "./roots.mjs";
import { fail, readEnvFile, readPublished, mergePublished } from "./publish-shared.mjs";

export { fail, parseArgs, readPublished, mergePublished } from "./publish-shared.mjs";

/** Confluence v2 for pages, v1 for attachments — v2 has no attachment API at
 *  all, which is why the two halves of this module speak different versions. */
export const CONFLUENCE_V2 = "/wiki/api/v2";
export const CONFLUENCE_V1 = "/wiki/rest/api";
export const JIRA_V3 = "/rest/api/3";

/**
 * Credentials and target, from the environment first and `.env` second.
 *
 * `site` is normalised to an origin with no trailing slash, because every
 * caller concatenates a path onto it and `https://x.atlassian.net//wiki` is a
 * 404 that reads like a missing page.
 */
export async function loadAtlassian(overrides = {}) {
  const env = { ...(await readEnvFile(".env")), ...process.env };

  let site = overrides.site || env.ATLASSIAN_SITE_URL;
  const email = overrides.email || env.ATLASSIAN_EMAIL;
  const token = overrides.token || env.ATLASSIAN_API_TOKEN;

  if (!site || !email || !token) {
    // `soft` returns null instead of exiting, for a caller that can carry on
    // without a credential. `verify-published.mjs` is the one: with no token it
    // downgrades to checking the local record and says so LOUDLY, which is a
    // far better outcome than blocking every publish on an install that does
    // not have one. `fail()` calls process.exit, so a try/catch around this
    // cannot soften it — the caller has to ask.
    if (overrides.soft) return null;
    fail(
      `No Atlassian API credentials.\n` +
      `  Looked for ATLASSIAN_SITE_URL, ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN in the\n` +
      `  environment and in ${path.join(INSTALL_ROOT, ".env")}.\n` +
      `  The MCP's OAuth token CANNOT be used here — it has no attachment scope and is\n` +
      `  only valid against api.atlassian.com. Create an API token at\n` +
      `  https://id.atlassian.com/manage-profile/security/api-tokens.`);
  }

  // Accept "acme", "acme.atlassian.net" and a full URL: an operator types all
  // three, and the two that are not URLs fail later as an unresolvable host
  // rather than here as a bad setting.
  if (!/^https?:\/\//.test(site)) {
    site = `https://${site.includes(".") ? site : `${site}.atlassian.net`}`;
  }
  site = site.replace(/\/+$/, "");

  return {
    site, email, token,
    space: overrides.space || null,
    jiraProject: overrides.jiraProject || null,
    issueType: overrides.issueType || null,
    auth: "Basic " + Buffer.from(`${email}:${token}`).toString("base64"),
  };
}

/**
 * One REST call, with the failure modes named.
 *
 * Atlassian's status codes are more honest than Azure DevOps's — a missing
 * permission is a 403 rather than a 401 — so the guidance here splits the two
 * rather than hedging. The one genuinely confusing case is 401, which for
 * Basic auth almost always means the EMAIL and token do not belong together
 * (a token is bound to the account that created it) rather than that the token
 * has expired.
 */
export async function atlassianFetch(creds, urlPath, init = {}) {
  const url = urlPath.startsWith("http") ? urlPath : `${creds.site}${urlPath}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: creds.auth,
      Accept: "application/json",
      ...(init.body && !(init.body instanceof FormData)
        ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });

  const text = await res.text();
  if (!res.ok) {
    const hint =
      res.status === 401
        ? `\n  A 401 with Basic auth is nearly always the EMAIL and TOKEN not belonging\n` +
          `  together — an API token is bound to the account that created it. Check\n` +
          `  ATLASSIAN_EMAIL matches the account at\n` +
          `  https://id.atlassian.com/manage-profile/security/api-tokens.`
        : res.status === 403
        ? `\n  403 is a PERMISSION, not a bad credential: the token is valid and this user\n` +
          `  cannot do this here. Check their access to the space or project.`
        : res.status === 404 && urlPath.includes("/wiki/")
        ? `\n  A 404 from Confluence is also what a space you cannot SEE looks like.`
        : "";
    // An unauthenticated Atlassian request can answer with an HTML login page;
    // printing a page of markup helps nobody.
    const body = text.trimStart().startsWith("<")
      ? "(Atlassian returned an HTML page, which is what it does for a request it cannot authenticate)"
      : text.slice(0, 400);
    throw new Error(`${init.method ?? "GET"} ${url}\n  → HTTP ${res.status}. ${body}${hint}`);
  }
  return text ? JSON.parse(text) : null;
}

/**
 * The Atlassian target a Scyne project publishes to.
 *
 * Written once, when the project is created, into
 * `projects/<project>/.published.json`. There is deliberately no environment
 * fallback: ONE space for the whole installation is exactly what per-project
 * targets replaced, and quietly falling back to one would publish a client's
 * document into another client's space.
 */
export async function readAtlassianTarget(publishedFile) {
  if (!publishedFile) return null;
  const t = (await readPublished(publishedFile))?.atlassianTarget;
  return t && typeof t.space === "string" && t.space ? t : null;
}

/**
 * The page an artefact is published to.
 *
 * A recorded `pageId` wins for good. The Azure path resolves a recorded wiki
 * PATH the same way and for the same reason — a client has a link to that page,
 * and a change of title must never silently create a second document and orphan
 * the first. On Confluence it matters more, not less: a page's title can be
 * edited in the UI by anybody, so title lookup alone would eventually publish a
 * duplicate beside a page somebody had renamed.
 */
export async function resolvePageId(publishedFile, artefactKey) {
  if (!publishedFile || !artefactKey) return null;
  const rec = (await readPublished(publishedFile))?.atlassian?.[artefactKey];
  const id = rec?.pageId;
  return typeof id === "string" && /^\d+$/.test(id) ? id : null;
}

/** Record page identity so a REVISION updates rather than creating a second page. */
export async function recordPublished(file, key, value) {
  if (!file || !key) return;
  await mergePublished(file, { atlassian: { [key]: value } });
}

/** Record the Atlassian target a project publishes to. Counterpart to
 *  `readAtlassianTarget`, kept beside it so the two cannot drift on shape. */
export async function recordAtlassianTarget(file, target) {
  if (!file || !target?.space) return;
  await mergePublished(file, { atlassianTarget: target });
}
