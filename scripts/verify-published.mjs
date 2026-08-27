#!/usr/bin/env node
/**
 * Prove a publish step actually published, and fail the issue if it did not.
 *
 * WHY THIS EXISTS
 * ---------------
 * Run SCY-1 (21 Aug 2026) is the whole argument. Its publish agent could not
 * reach Azure DevOps — every MCP tool call was refused by codex's approval
 * policy — so it did the reasonable thing a language model does: it explained
 * the problem in prose and finished its turn. Exit code 0.
 *
 * The engine has no way to tell that apart from success. It recorded the run
 * `succeeded`, ran the next step, and closed the issue **`done`**. The
 * timeline said "Capabilities Process Architect finished publish in 8m 20s".
 * The wiki held three pages, none of them this one, and
 * `projects/SAPN/.published.json` did not exist at all.
 *
 * An agent step's exit code reports whether the MODEL finished its turn, not
 * whether the WORK happened. For every other stage the `produces` files close
 * that gap, because the artefact lands on disk where `attach` can see it. A
 * publish leaves nothing on this machine — its output is on somebody else's
 * server — so it is the one step in the pipeline with no evidence behind it.
 * This is that evidence.
 *
 * TWO CHECKS, AND THE SECOND IS THE REAL ONE
 * ------------------------------------------
 *   1. `.published.json` names the artefact.  Cheap, local, and catches the
 *      agent that never got as far as trying.
 *   2. The page RESOLVES over the API.  This is what actually matters: (1)
 *      alone is a file the agent wrote about itself, and an agent that can
 *      invent a reason for failing can invent a record of succeeding.
 *
 * (2) is skipped only when no credential is configured, and says so loudly
 * rather than passing quietly — a check that silently downgrades to nothing is
 * worse than no check, because the green tick still appears.
 *
 * USAGE
 * -----
 *   node scripts/verify-published.mjs <project> --artefact "<key>" --path "<page path>"
 *        [--stories <stories.json>]
 *        [--org <org>] [--project <adoProject>] [--wiki <wiki>]
 *
 *   node scripts/verify-published.mjs <project> --artefact "<key>" --title "<page title>"
 *        [--stories <stories.json>]
 *
 * `--artefact` is the key under `ado.` / `atlassian.` in `.published.json` —
 * matching `artefactKeyTpl` in orchestrator.workflows.ts (`capabilities`, or
 * `<feature>/datamodel`).
 *
 * WHICH SYSTEM IT CHECKS is the project's own, resolved from `.published.json`
 * rather than from a flag — so a verify can never check a different system than
 * the publish wrote to, which is precisely the hole this script exists to
 * close. A Confluence page is identified by a TITLE within a space where an ADO
 * page is identified by a PATH, so the two take different identity flags.
 *
 * Exit 0 = the page is really there. Non-zero = the issue blocks, with the
 * reason, which is the entire point.
 */

import fsp from "node:fs/promises";
import process from "node:process";
import { API, adoFetch, loadAdo, parseArgs, projectPath, readAdoTarget, readPublished }
  from "./lib/ado.mjs";
import { resolvePublishTarget } from "./lib/publish-shared.mjs";
import {
  atlassianFetch, loadAtlassian, readAtlassianTarget, CONFLUENCE_V2,
} from "./lib/atlassian.mjs";

const { flags, positional } = parseArgs(process.argv.slice(2));
const project = positional[0];
const artefact = flags.artefact ? String(flags.artefact) : "";
const wantedPath = flags.path ? String(flags.path) : "";
// Only the requirements stage passes this. Everything else publishes a page
// and nothing else, and asking those for work items would fail every one.
const storiesFile = flags.stories ? String(flags.stories) : "";

const die = (msg) => { console.error(`\n✗ ${msg}\n`); process.exit(1); };

if (!project)   die(`No Scyne project. Usage: verify-published.mjs <project> --artefact <key> --path <page path>`);
if (!artefact)  die(`No --artefact key to look for in .published.json.`);

const publishedFile = `projects/${project}/.published.json`;

const wantedTitle = flags.title ? String(flags.title) : "";

// Resolved from the PROJECT, never from a flag: a verifier that could be
// pointed at a different system than the publish used would be checking
// something nobody published to, and passing.
const TARGET = await resolvePublishTarget({ publishedFile });

if (TARGET === "atlassian") {
  // ------------------------------------------------------------ 1. local
  const published = await readPublished(publishedFile);
  const record = published?.atlassian?.[artefact];

  if (!record) {
    die([
      `The ${artefact} publish left no record, so it did not publish.`,
      ``,
      `  expected: ${publishedFile}`,
      `            → atlassian.${JSON.stringify(artefact)}`,
      ``,
      `The agent step exited 0, but an agent exits 0 when it finishes TALKING —`,
      `including when what it had to say was that it could not reach Confluence.`,
      `Read the publish run's transcript: the real error is in there.`,
    ].join("\n"));
  }

  console.log(`  ✓ ${publishedFile} records atlassian.${artefact}`);
  if (record.title) console.log(`    title: ${record.title}`);
  if (record.url)   console.log(`    url:   ${record.url}`);

  if (wantedTitle && record.title && record.title !== wantedTitle) {
    die([
      `The recorded page title is not the one this stage publishes to.`,
      ``,
      `  recorded: ${record.title}`,
      `  expected: ${wantedTitle}`,
      ``,
      `A revision republished under a different title leaves the client holding`,
      `two documents that disagree, and nothing downstream can tell which is`,
      `current.`,
    ].join("\n"));
  }

  // ----------------------------------------------------------- 2. remote
  // `soft: true` — a missing credential must DOWNGRADE this check, not block
  // the issue. `loadAtlassian` calls process.exit otherwise, which a try/catch
  // cannot soften.
  const atlTarget = await readAtlassianTarget(publishedFile);
  const creds = await loadAtlassian({
    space: atlTarget?.space, jiraProject: atlTarget?.jiraProject, soft: true,
  });

  if (!creds?.auth) {
    console.log(
      `\n  ! NOT VERIFIED AGAINST CONFLUENCE — no credential is configured here.\n` +
      `    Only the local record was checked, and that file is written by the\n` +
      `    same agent whose work it vouches for. Set ATLASSIAN_SITE_URL,\n` +
      `    ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN to make this check mean\n` +
      `    something.\n`);
    process.exit(0);
  }

  if (!record.pageId) {
    die(`No pageId recorded for ${artefact}, so there is nothing to look up.`);
  }

  // A page moved to the trash still resolves unless its status is checked:
  // Confluence keeps trashed pages addressable by id, so a page a client
  // deleted would verify green without this.
  const page = await atlassianFetch(creds, `${CONFLUENCE_V2}/pages/${encodeURIComponent(record.pageId)}`)
    .catch((e) => {
      if (String(e.message).includes("HTTP 404")) {
        die([
          `Confluence has no page with id ${record.pageId} — so nothing was published.`,
          ``,
          `A record exists in ${publishedFile} but the page behind it does not.`,
          `The publish step reported success it had not earned.`,
        ].join("\n"));
      }
      die(`Could not reach Confluence: ${String(e.message).split("\n")[0]}`);
    });

  if (page.status && page.status !== "current") {
    die(`Confluence page ${record.pageId} is '${page.status}', not 'current' — it has been trashed or archived.`);
  }
  console.log(`  ✓ the page exists in Confluence  (${page.title})`);

  // ------------------------------------------------------- 3. the backlog
  if (storiesFile) {
    let stories = null;
    try {
      stories = JSON.parse(await fsp.readFile(storiesFile, "utf8"));
    } catch (e) {
      die(`--stories ${storiesFile} could not be read: ${e.message}`);
    }
    if (!Array.isArray(stories)) die(`${storiesFile} is not an array of stories.`);

    const keys = stories.map((st) => st?.jiraKey ?? st?.fields?.jiraKey).filter(Boolean);
    if (keys.length !== stories.length) {
      die([
        `${stories.length - keys.length} of ${stories.length} stor${stories.length === 1 ? "y" : "ies"} carry no \`jiraKey\`, so the backlog was not created.`,
        ``,
        `  file: ${storiesFile}`,
        ``,
        `The Confluence page published, which is why this step got this far. The`,
        `Jira issues are the other half of this stage and they are missing.`,
        ``,
        `The step BEFORE this one creates them — an exec running`,
        `scripts/jira-issues.mjs, which writes each new key straight back into the`,
        `file above. Reaching this message means that step did not run, or`,
        `something rewrote stories.json after it did.`,
        ``,
        `To do it by hand — it is idempotent, and updates rather than duplicating:`,
        `  node scripts/jira-issues.mjs ${storiesFile} \\`,
        `    --published-json ${publishedFile} --artefact-key "${artefact}"`,
      ].join("\n"));
    }

    // JQL rather than one GET per issue: a 45-story backlog would otherwise be
    // 45 round trips, and the count is the whole assertion.
    const jql = `key in (${keys.slice(0, 200).join(",")})`;
    const probe = await atlassianFetch(creds,
      `/rest/api/2/search?jql=${encodeURIComponent(jql)}&fields=key&maxResults=200`)
      .catch((e) => die(`Could not confirm the Jira issues: ${String(e.message).split("\n")[0]}`));

    const found = (probe?.issues ?? []).length;
    if (found !== Math.min(keys.length, 200)) {
      die(`stories.json names ${keys.length} issue(s) but Jira returned ${found}.`);
    }
    console.log(`  ✓ ${keys.length} Jira issue(s) exist`);
  }

  console.log(`\n${artefact} is published.\n`);
  process.exit(0);
}

// ---------------------------------------------------------------- 1. local

const published = await readPublished(publishedFile);
const record = published?.ado?.[artefact];

if (!record) {
  die([
    `The ${artefact} publish left no record, so it did not publish.`,
    ``,
    `  expected: ${publishedFile}`,
    `            → ado.${JSON.stringify(artefact)}`,
    ``,
    `The agent step exited 0, but an agent exits 0 when it finishes TALKING —`,
    `including when what it had to say was that it could not reach Azure`,
    `DevOps. Read the publish run's transcript: the real error is in there.`,
    ``,
    `If every MCP call in it was refused with "requires approval, but approval`,
    `policy is never", see MCP-CODEX.md — that is a configuration fault on this`,
    `machine, not something the agent could have worked around.`,
  ].join("\n"));
}

// `wikiPath` is what `recordPublished` writes (scripts/ado-publish.mjs), and
// what the publish prompt tells an agent to record. `path` is accepted too:
// this check reads a file written by an agent, and refusing a reasonable
// synonym would turn a successful publish into a blocked issue over a key
// name. Reading ONLY `path` is how the mismatch test below silently never
// fired — the value was always undefined.
const recordedPath = record.wikiPath ?? record.path ?? null;

console.log(`  ✓ ${publishedFile} records ado.${artefact}`);
if (recordedPath) console.log(`    path: ${recordedPath}`);
if (record.url)   console.log(`    url:  ${record.url}`);

if (wantedPath && recordedPath && recordedPath !== wantedPath) {
  die([
    `The recorded page path is not the one this stage publishes to.`,
    ``,
    `  recorded: ${recordedPath}`,
    `  expected: ${wantedPath}`,
    ``,
    `Identity is the PATH. A revision republished to a different path leaves`,
    `the client holding two documents that disagree, and nothing downstream`,
    `can tell which one is current.`,
  ].join("\n"));
}

// ---------------------------------------------------------------- 2. remote

let ado;
try {
  // The target is the one this project publishes to, not an installation-wide
  // default — the same resolution ado-publish.mjs uses, so a verify cannot
  // check a different project than the publish wrote to.
  const target = await readAdoTarget(publishedFile);
  ado = await loadAdo({
    org: flags.org || target?.org,
    project: flags.project || target?.project,
  });
} catch {
  ado = null;
}

if (!ado?.auth || !ado?.project) {
  console.log(
    `\n  ! NOT VERIFIED AGAINST AZURE DEVOPS — no credential is configured here.\n` +
    `    Only the local record was checked, and that file is written by the\n` +
    `    same agent whose work it vouches for. Set ADO_ORG and a PAT, and give\n` +
    `    the project an \`adoTarget\`, to make this check mean something.\n`);
  process.exit(0);
}

const pagePath = recordedPath || wantedPath;
if (!pagePath) {
  die(`No page path recorded and none supplied, so there is nothing to look up.`);
}

let wiki = flags.wiki ? String(flags.wiki) : "";
if (!wiki) {
  const wikis = await adoFetch(ado, `${projectPath(ado)}/_apis/wiki/wikis?api-version=${API}`);
  const all = wikis?.value ?? [];
  if (all.length !== 1) {
    die(all.length
      ? `'${ado.project}' has ${all.length} wikis. Pass --wiki to say which one holds this page.`
      : `'${ado.project}' has no wiki, so the page cannot exist.`);
  }
  wiki = all[0].name;
}

const url =
  `${projectPath(ado)}/_apis/wiki/wikis/${encodeURIComponent(wiki)}/pages` +
  `?path=${encodeURIComponent(pagePath)}&api-version=${API}`;

const res = await fetch(url, {
  headers: { Authorization: ado.auth, Accept: `application/json;api-version=${API}` },
}).catch(e => { die(`Could not reach Azure DevOps: ${e.message}`); });

if (res.status === 404) {
  die([
    `Azure DevOps has no page at that path — so nothing was published.`,
    ``,
    `  wiki: ${wiki}`,
    `  path: ${pagePath}`,
    ``,
    `A record exists in ${publishedFile} but the page behind it does not.`,
    `The publish step reported success it had not earned.`,
  ].join("\n"));
}

if (!res.ok) {
  const body = (await res.text().catch(() => "")).slice(0, 400);
  die([
    `Azure DevOps answered ${res.status} for that page.`,
    res.status === 401
      ? `\n  A 401 here usually means the token is VALID and lacks the wiki scope —\n` +
        `  Azure DevOps answers a missing scope with 401, not 403. Confirm with\n` +
        `  node scripts/ado-publish.mjs --verify`
      : `\n  ${body}`,
  ].join("\n"));
}

console.log(`  ✓ the page exists in Azure DevOps  (${wiki} :: ${pagePath})`);

// ------------------------------------------------------- 3. the work items
//
// The page was the only thing this script checked, and for the requirements
// stage the page is half the deliverable. Measured against the live
// organisation while diagnosing exactly this: SA-Power-Networks held a
// published wiki page and **zero** work items, and the issue had closed green,
// because nothing downstream ever asked whether the backlog arrived.
//
// The same two-part shape as above, for the same reason: `adoId` in
// stories.json is a file the agent wrote about itself, so the ids are then
// resolved over the API. An agent that can invent a reason for failing can
// invent a record of succeeding.
if (storiesFile) {
  let stories = null;
  try {
    stories = JSON.parse(await fsp.readFile(storiesFile, "utf8"));
  } catch (e) {
    die(`--stories ${storiesFile} could not be read: ${e.message}`);
  }
  if (!Array.isArray(stories)) die(`${storiesFile} is not an array of stories.`);

  const ids = stories.map((st) => st?.adoId ?? st?.fields?.adoId).filter(Boolean);
  if (ids.length !== stories.length) {
    die([
      `${stories.length - ids.length} of ${stories.length} stor${stories.length === 1 ? "y" : "ies"} carry no \`adoId\`, so the backlog was not created.`,
      ``,
      `  file: ${storiesFile}`,
      ``,
      `The wiki page published, which is why this step got this far. The work`,
      `items are the other half of this stage and they are missing.`,
      ``,
      `The step BEFORE this one creates them — an exec running`,
      `scripts/ado-workitems.mjs, which writes each new id straight back into the`,
      `file above. So reaching this message means that step did not run at all,`,
      `or something rewrote stories.json after it did. Check the timeline for a`,
      `"Creating the work items" step; if there is none, this issue was started`,
      `on a workflow compiled before that step existed and needs restarting`,
      `rather than resuming.`,
      ``,
      `To do it by hand — it is idempotent, and updates rather than duplicating:`,
      `  node scripts/ado-workitems.mjs ${storiesFile} \\`,
      `    --published-json projects/${project}/.published.json --artefact-key "${artefact}"`,
    ].join("\n"));
  }

  const probe = await adoFetch(
    ado,
    `${projectPath(ado)}/_apis/wit/workitemsbatch?api-version=${API}`,
    {
      method: "POST",
      // Explicit, because adoFetch does not set one for a body and Azure
      // DevOps answers a missing content type with 400, not with a hint.
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ids.slice(0, 200).map(Number), fields: ["System.Id"] }),
    },
  ).catch((e) => die(`Could not confirm the work items: ${e.message}`));

  const found = (probe?.value ?? []).length;
  if (found !== Math.min(ids.length, 200)) {
    die(`stories.json names ${ids.length} work item(s) but Azure DevOps returned ${found}.`);
  }
  console.log(`  ✓ ${ids.length} work item(s) exist in Azure DevOps`);
}

console.log(`\n${artefact} is published.\n`);
