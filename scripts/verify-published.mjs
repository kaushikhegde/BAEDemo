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
 *        [--org <org>] [--project <adoProject>] [--wiki <wiki>]
 *
 * `--artefact` is the key under `ado.` in `.published.json` — matching
 * `artefactKeyTpl` in orchestrator.workflows.ts (`capabilities`, or
 * `<feature>/datamodel`).
 *
 * Exit 0 = the page is really there. Non-zero = the issue blocks, with the
 * reason, which is the entire point.
 */

import process from "node:process";
import { API, adoFetch, loadAdo, parseArgs, projectPath, readPublished } from "./lib/ado.mjs";

const { flags, positional } = parseArgs(process.argv.slice(2));
const project = positional[0];
const artefact = flags.artefact ? String(flags.artefact) : "";
const wantedPath = flags.path ? String(flags.path) : "";

const die = (msg) => { console.error(`\n✗ ${msg}\n`); process.exit(1); };

if (!project)   die(`No Scyne project. Usage: verify-published.mjs <project> --artefact <key> --path <page path>`);
if (!artefact)  die(`No --artefact key to look for in .published.json.`);

const publishedFile = `projects/${project}/.published.json`;

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

console.log(`  ✓ ${publishedFile} records ado.${artefact}`);
if (record.path) console.log(`    path: ${record.path}`);
if (record.url)  console.log(`    url:  ${record.url}`);

if (wantedPath && record.path && record.path !== wantedPath) {
  die([
    `The recorded page path is not the one this stage publishes to.`,
    ``,
    `  recorded: ${record.path}`,
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
  ado = await loadAdo({ org: flags.org, project: flags.project });
} catch {
  ado = null;
}

if (!ado?.auth || !ado?.project) {
  console.log(
    `\n  ! NOT VERIFIED AGAINST AZURE DEVOPS — no credential is configured here.\n` +
    `    Only the local record was checked, and that file is written by the\n` +
    `    same agent whose work it vouches for. Set ADO_ORG / ADO_PROJECT and a\n` +
    `    PAT to make this check mean something.\n`);
  process.exit(0);
}

const pagePath = record.path || wantedPath;
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
console.log(`\n${artefact} is published.\n`);
