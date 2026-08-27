#!/usr/bin/env node
/**
 * Confirm a Scyne project's Confluence target BEFORE anything publishes to it.
 *
 * The Atlassian counterpart of `ensure-ado-project.mts`, and it does two jobs.
 *
 * VERIFY, NEVER CREATE
 * --------------------
 * `atlassianProvision.ts` used to CREATE a missing Jira project or Confluence
 * space during approval, and that was retired on purpose: a half-created space
 * is a worse thing to hand a client than a clear refusal, and the refusal
 * arrives before anyone has approved a document that then has nowhere to go.
 * This checks and says precisely what is wrong.
 *
 * AND CATCH A TARGET MISMATCH
 * ---------------------------
 * A workflow's prompt is a fixed string compiled at boot from `PUBLISH_TARGET`.
 * A project carrying an `adoTarget` under an Atlassian install would be handed
 * Confluence instructions while its own scripts resolved Azure DevOps — half a
 * delivery pack in each system, which is worse than either. Refusing here costs
 * nothing.
 *
 *   node scripts/ensure-confluence-space.mjs <project> [--space KEY]
 */

import path from "node:path";
import process from "node:process";
import {
  atlassianFetch, fail, loadAtlassian, parseArgs, readAtlassianTarget,
  CONFLUENCE_V2, JIRA_V3,
} from "./lib/atlassian.mjs";
import { readPublished, resolvePublishTarget } from "./lib/publish-shared.mjs";
import { WORK_ROOT } from "./lib/roots.mjs";

const { flags, positional } = parseArgs(process.argv.slice(2));
const project = positional[0];
if (!project) fail(`usage: node scripts/ensure-confluence-space.mjs <project> [--space KEY]`);

const publishedFile = path.join(WORK_ROOT, "projects", project, ".published.json");

// The mismatch check first: it is the cheapest, and it is the one whose failure
// means "do not run this pipeline at all" rather than "fix a setting".
const target = await resolvePublishTarget({ publishedFile });
if (target !== "atlassian") {
  const p = await readPublished(publishedFile);
  fail(
    `Project '${project}' publishes to ${target.toUpperCase()}, but this installation is\n` +
    `  configured for Atlassian (PUBLISH_TARGET=atlassian).\n` +
    (p?.adoTarget?.project
      ? `  Its .published.json records adoTarget.project = "${p.adoTarget.project}".\n`
      : "") +
    `  A project keeps the system it has already published into — a client has links to\n` +
    `  those documents, and splitting a pack across two systems is worse than either.\n` +
    `  Run this project with PUBLISH_TARGET=ado, or migrate it deliberately.`);
}

const recorded = await readAtlassianTarget(publishedFile);
const space = flags.space || recorded?.space;
if (!space) {
  fail(
    `Project '${project}' has no Confluence space recorded.\n` +
    `  Expected atlassianTarget.space in ${publishedFile}.\n` +
    `  It is written when the project is created; a project made before that needs one\n` +
    `  backfilled. There is deliberately no environment fallback — one space for the\n` +
    `  whole installation would file a client's document in another client's space.`);
}

const creds = await loadAtlassian({ space, jiraProject: recorded?.jiraProject });

const spaces = await atlassianFetch(creds,
  `${CONFLUENCE_V2}/spaces?keys=${encodeURIComponent(space)}`);
const row = (spaces?.results ?? [])[0];
if (!row) {
  fail(
    `Confluence space '${space}' does not exist, or this user cannot see it.\n` +
    `  This script deliberately does NOT create it: a half-provisioned space is worse\n` +
    `  to hand a client than a clear refusal. Create it in Confluence, or correct\n` +
    `  atlassianTarget.space in ${publishedFile}.`);
}

// The Jira half only matters for the requirements stage, which is the only one
// that delivers a backlog — but checking it here means a missing project is
// found before a document is written rather than after it is approved.
let jiraNote = "";
if (recorded?.jiraProject) {
  try {
    await atlassianFetch(creds,
      `${JIRA_V3}/project/${encodeURIComponent(recorded.jiraProject)}`);
    jiraNote = `, Jira project ${recorded.jiraProject}`;
  } catch (e) {
    fail(
      `Confluence space '${space}' is fine, but Jira project '${recorded.jiraProject}' is not:\n` +
      `  ${String(e.message).split("\n").slice(0, 2).join("\n  ")}\n` +
      `  The requirements stage creates one issue per story there and would fail after\n` +
      `  its gate was approved.`);
  }
}

console.log(`✓ ${project} → Confluence space ${space} (id ${row.id})${jiraNote}`);
