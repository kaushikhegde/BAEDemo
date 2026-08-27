/**
 * The publishing links a finished workflow should put in front of the user,
 * read from disk rather than scraped out of the timeline.
 *
 * `/api/status` has always derived its links with `extractLinks`, a regex over
 * the issue's COMMENT bodies. Nothing writes a URL into a comment. The engine
 * narrates an `exec` step by its `label` and an agent step by its duration and
 * cost — both deliberately, so that a client watching the chatbot is not shown
 * a shell line or a path on our machine — and the publish agent prints the page
 * URL as the last line of its stdout, which is not a comment and is never read
 * again. The Paperclip-era bundles used to have each agent post its own link;
 * that instruction was correctly deleted when the bundles were thinned, and
 * nothing replaced it. So a healthy run published a page, created a backlog,
 * closed green, and left the links panel empty.
 *
 * The URLs were never missing — they are recorded in the two files the publish
 * VERIFIER already refuses to let an issue past without:
 *
 *   projects/<p>/.published.json          → ado.<artefact> or atlassian.<artefact>,
 *                                           the page and its URL
 *   projects/<p>/<f>/outputs/stories.json → every story's adoId / jiraKey
 *
 * That invariant is what makes reading disk sound rather than optimistic: an
 * issue cannot reach `done` with a page this cannot find — `verify-published.mjs`
 * dies on a missing publish record, and on any story without its id. It also means this works for every run that finished BEFORE it
 * existed, which a fix in the engine's narration could not.
 *
 * Nothing here throws. It is called from a status poll that runs every three
 * seconds while a client watches; a missing file is a run that has not
 * published yet, not a fault.
 */

import fs from "node:fs/promises";
import path from "node:path";
import * as pipeline from "../../scripts/pipeline.mjs";

export interface AdoTarget {
  org?: string | null;
  project?: string | null;
  wiki?: string | null;
}

/** What `recordAtlassianTarget` writes under `atlassianTarget`. */
export interface AtlassianTarget {
  site?: string | null;
  space?: string | null;
  jiraProject?: string | null;
}

/** One artefact's entry under `atlassian.` in `.published.json`. */
export interface AtlassianRecord {
  url?: string | null;
  pageId?: string | null;
  space?: string | null;
  title?: string | null;
}

/** One artefact's entry under `ado.` in `.published.json`. */
export interface PublishRecord {
  url?: string | null;
  /** What `recordPublished` writes. `path` is accepted as a synonym — see below. */
  wikiPath?: string | null;
  path?: string | null;
  wiki?: string | null;
}

const orgUrl = (target: AdoTarget) =>
  `https://dev.azure.com/${encodeURIComponent(String(target.org))}` +
  `/${encodeURIComponent(String(target.project))}`;

/**
 * The page URL for one recorded artefact, or null when there is not enough to
 * build one.
 *
 * The recorded `url` wins outright. `ado-publish.mjs` writes the URL it
 * actually used, and rebuilding one over the top of that is how a page
 * published into a renamed or second wiki acquires a link that 404s.
 *
 * `wikiPath` vs `path`: both are read, for the same reason
 * `verify-published.mjs` reads both — this record is written by an agent
 * following a prompt, and turning a good publish into a dead link over a key
 * name is worse than accepting a reasonable synonym.
 */
export function wikiUrl(
  record: PublishRecord | null | undefined,
  target?: AdoTarget | null,
): string | null {
  if (!record) return null;
  if (record.url) return String(record.url);

  const pagePath = record.wikiPath ?? record.path ?? null;
  const wiki = record.wiki ?? target?.wiki ?? null;
  if (!pagePath || !wiki || !target?.org || !target?.project) return null;

  return `${orgUrl(target)}/_wiki/wikis/${encodeURIComponent(String(wiki))}` +
    `?pagePath=${encodeURIComponent(String(pagePath))}`;
}

/**
 * The work item URL for one id.
 *
 * The `_workitems/edit/<digits>` shape is a contract, not a preference:
 * `extractLinks` in index.ts matches exactly that, and the frontend's
 * LinksPanel reads what it produces. Anything else is dropped in silence.
 */
export function workItemUrl(id: unknown, target?: AdoTarget | null): string | null {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  if (!target?.org || !target?.project) return null;
  return `${orgUrl(target)}/_workitems/edit/${n}`;
}

/**
 * The Confluence page URL for one recorded artefact.
 *
 * The recorded `url` wins outright, for the same reason it does on the Azure
 * side: `confluence-publish.mjs` writes the URL it actually used, and rebuilding
 * one over the top of that is how a page published into a renamed space
 * acquires a link that 404s. The rebuild is the fallback for a record written by
 * hand after an MCP call, which carries the id but not the URL.
 */
export function confluenceUrl(
  record: AtlassianRecord | null | undefined,
  target?: AtlassianTarget | null,
): string | null {
  if (!record) return null;
  if (record.url) return String(record.url);
  const site = target?.site ?? null;
  const space = record.space ?? target?.space ?? null;
  if (!record.pageId || !site || !space) return null;
  return `${String(site).replace(/\/+$/, "")}/wiki/spaces/` +
    `${encodeURIComponent(String(space))}/pages/${encodeURIComponent(String(record.pageId))}`;
}

/**
 * The Jira issue URL for one key.
 *
 * A key, not a number — `PROJ-123`. Validated rather than interpolated blindly:
 * this ends up in an href a client clicks, and `stories.json` is written by an
 * agent.
 */
export function jiraUrl(key: unknown, target?: AtlassianTarget | null): string | null {
  const k = typeof key === "string" ? key.trim() : "";
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(k)) return null;
  if (!target?.site) return null;
  return `${String(target.site).replace(/\/+$/, "")}/browse/${k}`;
}

/** `revise-datamodel` and `publish-datamodel` are the datamodel stage in another mode. */
const VARIANT = /^(?:revise|publish)-/;

function publishes(stage: string): boolean {
  const def = (pipeline.STAGES as Record<string, { publishes?: boolean }>)[stage];
  return Boolean(def?.publishes);
}

/**
 * The `.published.json` keys a workflow's links come from.
 *
 * A stage that publishes nothing gets none — the UI mockups and the companion
 * app are local artefacts, and offering a wiki link for them would point at a
 * page that does not exist. `baseline` gets both of the stages it runs.
 */
export function artefactKeysFor(workflowKey: string, feature?: string | null): string[] {
  if (workflowKey === "baseline") return ["capabilities", "personas"].filter(publishes);
  const stage = String(workflowKey).replace(VARIANT, "");
  if (!publishes(stage)) return [];
  return [pipeline.artefactKey(stage, feature ?? null)];
}

async function readJson(file: string): Promise<any> {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; }
}

/**
 * Two link sets into one, order preserved, duplicates dropped.
 *
 * Both sources are kept rather than one replacing the other: a URL genuinely
 * written into a comment — a person pasting one, a future step that posts one —
 * should still show, and the disk-derived set is the half that was missing.
 */
export function mergeLinks(
  a: { wiki: string[]; workItems: string[] },
  b: { wiki: string[]; workItems: string[] },
): { wiki: string[]; workItems: string[] } {
  return {
    wiki: [...new Set([...a.wiki, ...b.wiki])],
    workItems: [...new Set([...a.workItems, ...b.workItems])],
  };
}

/**
 * Everything above, off disk, in the shape `/api/status` already returns.
 *
 * The keys STAY `wiki` / `workItems` even though this now also returns
 * Confluence pages and Jira issues. They were `confluence` / `jira` once, were
 * renamed when publishing moved to Azure DevOps, and renaming the wire format
 * in the same change as moving what fills it is exactly how a links panel goes
 * quietly empty. Doing it a second time — back again — would be the same
 * mistake with more history behind it. The keys are a wire contract read by
 * `extractLinks`, the frontend's LinksPanel, and chat transcripts already sitting
 * in localStorage; what they MEAN is "the published document" and "the backlog
 * items", which is true of both back ends.
 *
 * Both sources are read and merged rather than branched on. A project publishes
 * to one system, so in practice one side is always empty — but a project
 * MIGRATED between them has records under both, and showing the client only
 * half of what exists would be worse than showing both.
 */
export async function publishedLinks(
  workspace: string,
  opts: { project: string; feature?: string | null; workflowKey: string },
): Promise<{ wiki: string[]; workItems: string[] }> {
  const empty = { wiki: [] as string[], workItems: [] as string[] };
  const keys = artefactKeysFor(opts.workflowKey, opts.feature);
  if (!opts.project || !keys.length) return empty;

  const projectDir = path.join(workspace, "projects", opts.project);
  const published = await readJson(path.join(projectDir, ".published.json"));
  if (!published) return empty;

  const target: AdoTarget = published.adoTarget ?? {};
  const atlTarget: AtlassianTarget = published.atlassianTarget ?? {};
  const wiki: string[] = [];
  for (const key of keys) {
    for (const url of [
      wikiUrl(published?.ado?.[key], target),
      confluenceUrl(published?.atlassian?.[key], atlTarget),
    ]) {
      if (url && !wiki.includes(url)) wiki.push(url);
    }
  }

  // The requirements stage is the only one whose deliverable is a page AND a
  // backlog — the same condition `publishPrompt` and `verifyPublishStep` use.
  const workItems: string[] = [];
  if (opts.feature && keys.some((k) => k.endsWith("requirements"))) {
    const stories = await readJson(path.join(projectDir, opts.feature, "outputs", "stories.json"));
    if (Array.isArray(stories)) {
      for (const s of stories) {
        for (const url of [
          workItemUrl(s?.adoId ?? s?.fields?.adoId, target),
          jiraUrl(s?.jiraKey ?? s?.fields?.jiraKey, atlTarget),
        ]) {
          if (url && !workItems.includes(url)) workItems.push(url);
        }
      }
    }
  }

  return { wiki, workItems };
}
