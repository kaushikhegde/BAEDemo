#!/usr/bin/env node
/**
 * Make a Scyne project's Atlassian target REAL before anything publishes to it.
 *
 * The Atlassian counterpart of `ensure-ado-project.mts`, and it does three jobs.
 *
 * PROVISION WHAT IS MISSING
 * -------------------------
 * This used to verify and never create, on the reasoning that a half-created
 * space is worse to hand a client than a clear refusal. That reasoning held
 * while every project was made through the chatbot's own `POST /api/projects`,
 * which derives a space key and records it. It stopped holding when the MCP
 * plugin became the front door: `create_project` posts to the orchestrator's
 * `POST /projects`, which records no Atlassian target at all — so EVERY project
 * made that way blocked here, at step 6 of 10, on a document that was already
 * written and about to be approved.
 *
 * A refusal is only better than a creation when somebody is going to act on it.
 * Nobody was: the pack is generated, the space it belongs in is implied by the
 * project, and the answer to "no space recorded" was always "record the obvious
 * one and carry on". So this now:
 *
 *   · records `atlassianTarget` when the project has none, deriving both keys
 *     from the project name (`atlassianKeyFor`)
 *   · creates the Confluence space when it does not exist
 *   · creates the Jira project, for the one stage that delivers a backlog
 *
 * Everything it does is idempotent and re-entrant: a recorded key always wins
 * over a derived one, an existing space or project is used as it stands, and a
 * "key already exists" from a racing step is resolved by looking again rather
 * than by failing.
 *
 * It still creates NOTHING silently — every creation is named on stdout, which
 * the engine narrates onto the issue.
 *
 * AND CATCH A TARGET MISMATCH
 * ---------------------------
 * A workflow's prompt is a fixed string compiled at boot from `PUBLISH_TARGET`.
 * A project carrying an `adoTarget` under an Atlassian install would be handed
 * Confluence instructions while its own scripts resolved Azure DevOps — half a
 * delivery pack in each system, which is worse than either. That refusal STAYS:
 * it is not a gap to fill in, it is two systems disagreeing about where a
 * client's documents live, and no default can resolve that safely.
 *
 *   node scripts/ensure-confluence-space.mjs <project> [--space KEY]
 *        [--jira-project KEY] [--with-jira] [--no-create]
 */

import path from "node:path";
import process from "node:process";
import {
  atlassianFetch, atlassianKeyFor, fail, loadAtlassian, parseArgs,
  readAtlassianTarget, recordAtlassianTarget,
  CONFLUENCE_V1, CONFLUENCE_V2, JIRA_V3,
} from "./lib/atlassian.mjs";
import { readEnvFile, readPublished, resolvePublishTarget } from "./lib/publish-shared.mjs";
import { WORK_ROOT } from "./lib/roots.mjs";

const { flags, positional } = parseArgs(process.argv.slice(2));
const project = positional[0];
if (!project) {
  fail(`usage: node scripts/ensure-confluence-space.mjs <project> [--space KEY] ` +
       `[--jira-project KEY] [--with-jira] [--no-create]`);
}

const publishedFile = path.join(WORK_ROOT, "projects", project, ".published.json");

/**
 * The same file, as a reader can act on it.
 *
 * `publishedFile` is absolute inside a per-step scratch tree
 * (`/var/folders/…/scyne-step-ZVUpre/projects/SAPN/.published.json`) that is
 * deleted the moment the step ends. Putting that in a message — and these
 * messages become issue comments a client reads — names a path that neither
 * exists nor is theirs.
 */
const publishedRel = `projects/${project}/.published.json`;

// The mismatch check first: it is the cheapest, and it is the one whose failure
// means "do not run this pipeline at all" rather than "fill in a blank".
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
// A recorded key always wins: it may have been edited deliberately, and a page
// already published under it is a link a client holds.
const derived = atlassianKeyFor(project);
const space = flags.space || recorded?.space || derived;
const jiraProject = flags["jira-project"] || recorded?.jiraProject || derived;

const creds = await loadAtlassian({ space, jiraProject });
const env = { ...(await readEnvFile(".env")), ...process.env };

/** `--no-create` verifies only — the old behaviour, for an operator who wants it. */
const mayCreate = !flags["no-create"];

/** What this run actually changed, so the summary can say so. */
const made = [];

// ---------------------------------------------------------------- the record

if (recorded?.space !== space || recorded?.jiraProject !== jiraProject || !recorded?.site) {
  await recordAtlassianTarget(publishedFile, {
    ...(recorded ?? {}), site: creds.site, space, jiraProject,
  });
  if (!recorded?.space) made.push(`recorded atlassianTarget (space ${space}, Jira ${jiraProject})`);
}

// ------------------------------------------------------------- the Confluence space

const findSpace = async () => {
  const res = await atlassianFetch(creds,
    `${CONFLUENCE_V2}/spaces?keys=${encodeURIComponent(space)}`);
  return (res?.results ?? [])[0] ?? null;
};

let row = await findSpace();
if (!row) {
  if (!mayCreate) {
    fail(
      `Confluence space '${space}' does not exist, or this user cannot see it, and\n` +
      `  --no-create was passed. Create it in Confluence, or correct\n` +
      `  atlassianTarget.space in ${publishedRel}.`);
  }
  try {
    // v1, not v2: `POST /wiki/api/v2/spaces` is not available on every Cloud
    // site, and `POST /wiki/rest/api/space` is. The two halves of this module
    // already speak different versions for the same kind of reason.
    const createdSpace = await atlassianFetch(creds, `${CONFLUENCE_V1}/space`, {
      method: "POST",
      body: JSON.stringify({
        key: space,
        name: project,
        description: {
          plain: {
            value: `Delivery pack for ${project}, published by Scyne.`,
            representation: "plain",
          },
        },
      }),
    });
    row = { id: String(createdSpace?.id ?? ""), key: space };
    made.push(`created Confluence space ${space}`);
  } catch (e) {
    // Two things answer "a space with this key already exists": a racing step,
    // and a space this user could not SEE a moment ago but can now. Look again
    // before calling it a failure — the check above cannot tell them apart.
    row = await findSpace();
    if (!row) {
      fail(
        `Could not create Confluence space '${space}' for project '${project}':\n` +
        `  ${String(e.message).split("\n").slice(0, 3).join("\n  ")}\n` +
        `  Creating a space needs the 'Create Spaces' global permission. Grant it, create\n` +
        `  the space by hand, or set atlassianTarget.space in ${publishedRel} to one that\n` +
        `  already exists.`);
    }
  }
}

// -------------------------------------------------------------- the Jira project
//
// Only for the stage that delivers a backlog. Every other stage publishes a
// page and nothing else, and a Jira project conjured into a client's site by a
// run that was never going to put an issue in it is exactly the kind of thing
// the old "never create" rule was right about.

const JIRA_TEMPLATES = env.ATLASSIAN_JIRA_TEMPLATE
  ? [{
      projectTypeKey: env.ATLASSIAN_JIRA_PROJECT_TYPE || "software",
      projectTemplateKey: env.ATLASSIAN_JIRA_TEMPLATE,
    }]
  : [
      // READ OFF A REAL SITE, not recalled: `GET /rest/project-templates/1.0/templates`
      // lists what a site actually has, and the first draft of this ladder was
      // wrong in the way a plausible guess is — `com.pyxis.jira:…` instead of
      // `com.pyxis.greenhopper.jira:…`, which is a 400 on every rung.
      //
      // Scrum first because the requirements stage delivers stories and that
      // template gives a project Story, Task, Bug and Epic; `jira-issues.mjs`
      // then resolves the type off createmeta. Kanban is the same issue types
      // without a backlog, and `business` is what a site with no Jira Software
      // licence has instead of either.
      { projectTypeKey: "software", projectTemplateKey: "com.pyxis.greenhopper.jira:gh-scrum-template" },
      { projectTypeKey: "software", projectTemplateKey: "com.pyxis.greenhopper.jira:gh-kanban-template" },
      { projectTypeKey: "business",
        projectTemplateKey: "com.atlassian.jira-core-project-templates:jira-core-project-management" },
    ];

const jiraExists = async () => {
  try {
    await atlassianFetch(creds, `${JIRA_V3}/project/${encodeURIComponent(jiraProject)}`);
    return true;
  } catch {
    return false;
  }
};

let jiraNote = "";
if (flags["with-jira"]) {
  if (await jiraExists()) {
    jiraNote = `, Jira project ${jiraProject}`;
  } else if (!mayCreate) {
    fail(
      `Jira project '${jiraProject}' does not exist and --no-create was passed.\n` +
      `  The requirements stage creates one issue per story there and would fail after\n` +
      `  its gate was approved.`);
  } else {
    // The lead is required and there is no sensible default but "whoever this
    // token belongs to" — the same account that will own the issues.
    const me = await atlassianFetch(creds, `${JIRA_V3}/myself`);
    const leadAccountId = me?.accountId;
    if (!leadAccountId) {
      fail(`Jira did not return an accountId for this token, so a project cannot be created\n` +
           `  (every Jira project needs a lead). Create '${jiraProject}' by hand.`);
    }

    const refused = [];
    for (const t of JIRA_TEMPLATES) {
      try {
        await atlassianFetch(creds, `${JIRA_V3}/project`, {
          method: "POST",
          body: JSON.stringify({
            key: jiraProject, name: project, leadAccountId,
            description: `Delivery backlog for ${project}, created by Scyne.`,
            ...t,
          }),
        });
        made.push(`created Jira project ${jiraProject} (${t.projectTemplateKey})`);
        jiraNote = `, Jira project ${jiraProject}`;
        break;
      } catch (e) {
        refused.push(`${t.projectTemplateKey}: ${String(e.message).split("\n").slice(1, 2).join(" ").trim()}`);
      }
    }

    if (!jiraNote) {
      // Same reasoning as the space: the key may have been taken by a racing
      // step between the check and the create.
      if (await jiraExists()) {
        jiraNote = `, Jira project ${jiraProject}`;
      } else {
        fail(
          `Could not create Jira project '${jiraProject}' for '${project}'. Every template\n` +
          `  was refused:\n` +
          refused.map((r) => `    - ${r}`).join("\n") + `\n` +
          `  Creating a project needs Jira administrator rights and the CREATE_PROJECT\n` +
          `  permission, and the template has to exist on this site. What this one has is\n` +
          `  listed at /rest/project-templates/1.0/templates — set ATLASSIAN_JIRA_TEMPLATE\n` +
          `  (and ATLASSIAN_JIRA_PROJECT_TYPE) in the workspace .env to one of those, or\n` +
          `  create the project by hand and record it as atlassianTarget.jiraProject in\n` +
          `  ${publishedRel}.`);
      }
    }
  }
} else if (recorded?.jiraProject && !(await jiraExists())) {
  // Not this stage's job to create, but worth saying now rather than after a
  // human has approved a document: a recorded project that is not there means
  // the requirements stage will fail at its own publish.
  console.log(
    `! Jira project '${recorded.jiraProject}' is recorded but not visible to this user. ` +
    `The requirements stage will provision it when it runs.`);
}

const changed = made.length ? ` — ${made.join("; ")}` : "";
console.log(`✓ ${project} → Confluence space ${space} (id ${row.id})${jiraNote}${changed}`);
