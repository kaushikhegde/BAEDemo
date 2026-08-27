#!/usr/bin/env node
/**
 * Create or update Jira issues from a `stories.json` on disk.
 *
 * The Atlassian counterpart of `scripts/ado-workitems.mjs`, and it keeps every
 * guarantee that file earned the hard way:
 *
 *   · the issue type is DISCOVERED from the project, never assumed
 *   · `{{PRODUCT_SUMMARY_URL}}` is substituted here, and an unsubstituted
 *     placeholder is a hard refusal rather than something a client reads
 *   · created ids are written back, so a re-run UPDATES rather than
 *     duplicating a client's backlog — the one failure re-running cannot undo
 *
 * WHY THIS IS AN `exec` STEP AND NOT A PROMPT
 * -------------------------------------------
 * SA-Power-Networks / CRM-Management: 45 stories, the page published cleanly,
 * ZERO issues created, and the agent's turn finished normally — so the run
 * recorded `succeeded`. An exit code says a model stopped talking; it has never
 * said the work happened, and 45 sequential tool calls in one turn is where it
 * stops. A script always does it.
 *
 * WHY REST v2 AND NOT v3
 * ----------------------
 * v3 takes descriptions as Atlassian Document Format — a JSON document tree.
 * v2 takes a string and renders it as wiki markup, which is EXACTLY what
 * `requirement-generator` already writes into `stories.json`
 * (`h3. Heading`, `*bold*`, `* bullet`). Going through v3 would mean a
 * markup→ADF conversion layer whose only purpose is to undo the format the
 * skill already produces. The ADO path had to convert that markup to HTML for
 * the opposite reason; here it travels untouched.
 *
 * `stories.json` is in fact still shaped as Atlassian create-issue payloads —
 * `{fields: {summary, description}}` — a leftover from before this pipeline
 * moved to Azure DevOps that nobody removed. Moving back to Jira makes it the
 * native shape again, so every field read below prefers `story.fields.*`.
 *
 * USAGE
 * -----
 *   node scripts/jira-issues.mjs <stories.json>
 *        [--project KEY]              Jira project key; else the recorded target
 *        [--type Story]               override the discovered issue type
 *        [--parent KEY-123]           link each issue under this epic
 *        [--summary-url <url>]        substituted for {{PRODUCT_SUMMARY_URL}}
 *        [--published-json <file>]    projects/<project>/.published.json
 *        [--artefact-key <key>]       supplies --summary-url when none is passed,
 *                                     and adds a remote link to the Confluence page
 *        [--dry-run] [--json]
 */

import fs from "node:fs/promises";
import process from "node:process";
import {
  atlassianFetch, fail, loadAtlassian, parseArgs, readAtlassianTarget, readPublished,
} from "./lib/atlassian.mjs";

// v2, not the JIRA_V3 exported beside it — see the header on why. The two are
// the same endpoints with different description formats.
const V2 = "/rest/api/2";

const { flags, positional } = parseArgs(process.argv.slice(2));
const json = Boolean(flags.json);
const say = (s) => { if (!json) console.log(s); };

const storiesFile = positional[0];
if (!storiesFile) {
  fail(`usage: node scripts/jira-issues.mjs <stories.json> [--parent KEY-123]\n` +
       `  [--summary-url <url> | --published-json <file> --artefact-key <key>]`);
}

const publishedJson = typeof flags["published-json"] === "string" ? flags["published-json"] : null;
// Read once, here, because BOTH things this file does with a published page
// need it: resolving the summary URL, and building the remote link. Two consts
// reading one flag is how the two quietly stop agreeing about which page an
// issue points at.
const artefactKey = typeof flags["artefact-key"] === "string" ? flags["artefact-key"] : null;
const target = await readAtlassianTarget(publishedJson);

const creds = await loadAtlassian({
  jiraProject: flags.project || target?.jiraProject,
  issueType: flags.type || target?.issueType,
});
if (!creds.jiraProject) {
  fail(
    `No Jira project.\n` +
    `  Pass --project, or point --published-json at a projects/<project>/.published.json\n` +
    `  carrying an "atlassianTarget" with a jiraProject. It is written when the project\n` +
    `  is created; a project made before that needs one backfilled.`);
}

/**
 * The type to create stories as.
 *
 * Preference order rather than a single default, for the same reason the ADO
 * path discovers its work item type: what "a unit of deliverable work" is
 * called depends on the project's template. A company-managed Scrum project has
 * Story; a Kanban one may only have Task; a team-managed project can be
 * configured with neither.
 */
const PREFERRED = ["Story", "User Story", "Task", "Requirement"];

async function resolveType(explicit) {
  const meta = await atlassianFetch(creds,
    `${V2}/issue/createmeta?projectKeys=${encodeURIComponent(creds.jiraProject)}` +
    `&expand=projects.issuetypes`);
  const project = (meta.projects ?? [])[0];
  if (!project) {
    fail(`Jira project '${creds.jiraProject}' does not exist, or this user cannot create issues in it.`);
  }
  // Sub-tasks are excluded: they cannot exist without a parent, so creating a
  // backlog of them would fail one story at a time after the gate was approved.
  const available = (project.issuetypes ?? []).filter((t) => !t.subtask).map((t) => t.name);
  if (explicit) {
    if (!available.includes(explicit)) {
      fail(`'${creds.jiraProject}' has no issue type '${explicit}'.\n  It has: ${available.join(", ")}`);
    }
    return explicit;
  }
  const hit = PREFERRED.find((p) => available.includes(p));
  if (!hit) fail(`'${creds.jiraProject}' has none of ${PREFERRED.join(", ")}. It has: ${available.join(", ")}`);
  return hit;
}

const type = await resolveType(creds.issueType ?? undefined);
say(`Creating issues as '${type}' in ${creds.jiraProject}`);

const raw = JSON.parse(await fs.readFile(storiesFile, "utf8").catch(() => fail(`Cannot read ${storiesFile}`)));
// stories.json has been written as both a bare array and {stories:[...]}.
const stories = Array.isArray(raw) ? raw : (raw.stories ?? raw.items ?? []);
if (!stories.length) fail(`${storiesFile} contains no stories.`);

/**
 * The Confluence URL substituted for `{{PRODUCT_SUMMARY_URL}}`.
 *
 * `--summary-url` still wins, but it no longer has to be supplied. The page was
 * published moments before this runs and its URL was recorded under
 * `atlassian.<artefact-key>` in the same `.published.json` this script already
 * reads its target from.
 *
 * That is what lets the backlog half of the requirements stage be an ordinary
 * `exec` step: a workflow command is a fixed string compiled before the run, so
 * it cannot name a URL that will not exist until the step before it finishes.
 * Reading it back from the record the publish just wrote can.
 */
async function resolveSummaryUrl() {
  const explicit = flags["summary-url"];
  if (typeof explicit === "string" && explicit) return explicit;
  if (!publishedJson || !artefactKey) return null;

  const record = (await readPublished(publishedJson))?.atlassian?.[artefactKey] ?? null;
  if (!record) return null;
  if (record.url) {
    say(`Summary URL read from ${publishedJson} -> atlassian.${artefactKey}`);
    return record.url;
  }
  // A record written by hand after an MCP page call may carry only the id.
  // Rebuild rather than failing the whole backlog over a missing convenience
  // field — the page identity is the id, and that is what is actually recorded.
  if (record.pageId && record.space) {
    const built = `${creds.site}/wiki/spaces/${record.space}/pages/${record.pageId}`;
    say(`Summary URL rebuilt from atlassian.${artefactKey}.pageId (no url recorded)`);
    return built;
  }
  return null;
}
const summaryUrl = await resolveSummaryUrl();

/**
 * The epic every story is linked under, when there is one.
 *
 * `--parent` wins. The fallback is the workflow param, which reaches an exec
 * step through the ENVIRONMENT rather than through a `{placeholder}` in its
 * command: the engine's interpolator THROWS on a placeholder the issue does not
 * carry, and a parent epic is optional on every run. That trap broke every
 * requirements publish once already.
 */
const parentKey = flags.parent
  ?? process.env.SCYNE_PARAM_JIRAPARENTEPICKEY
  ?? process.env.SCYNE_PARAM_ADOPARENTEPICID
  ?? null;
if (parentKey) say(`Linking each new issue under ${parentKey}`);

function describe(story, title) {
  // Wiki markup, untouched — see the header on why this is v2. The ADO path
  // had to convert this to HTML; here it is already the target format.
  const parts = [];
  const description = story.description ?? story.fields?.description;
  if (typeof description === "string" && description) parts.push(description);

  const ac = story.acceptanceCriteria ?? story.acceptance_criteria ?? [];
  if (Array.isArray(ac) && ac.length) {
    parts.push(`*Acceptance criteria*\n${ac.map((a) => `* ${a}`).join("\n")}`);
  }
  let text = parts.join("\n\n");

  if (summaryUrl) text = text.split("{{PRODUCT_SUMMARY_URL}}").join(summaryUrl);

  // The whole reason the substitution lives in this script rather than in a
  // model's instructions is that it must not be forgettable. Observed on the
  // ADO path while testing: a re-run WITHOUT --summary-url re-rendered the
  // description from source and quietly put the placeholder back over the
  // substituted one — silently un-publishing the link in every story.
  if (text.includes("{{PRODUCT_SUMMARY_URL}}")) {
    fail(
      `'${String(title ?? "a story")}' still contains {{PRODUCT_SUMMARY_URL}} and no --summary-url was given.\n` +
      `  Pass --summary-url <the published Confluence page URL>. Writing the placeholder into\n` +
      `  a client's backlog is worse than not writing the issue — and on a RE-RUN it would\n` +
      `  overwrite a link that was already correct.`);
  }
  return text;
}

/** Best-effort — a failed link must never fail the issue it belongs to. The
 *  Jira equivalent of the ADO Links-tab wiki relation, and far simpler: a
 *  remote link takes a URL rather than an undocumented `vstfs://` artifact URI
 *  that had to be reverse-engineered. */
async function linkToPage(key) {
  if (!summaryUrl) return "skipped";
  try {
    await atlassianFetch(creds, `${V2}/issue/${encodeURIComponent(key)}/remotelink`, {
      method: "POST",
      body: JSON.stringify({
        // A stable globalId makes this idempotent: posting the same link twice
        // UPDATES it rather than adding a second identical row to the issue.
        globalId: `scyne-product-summary`,
        object: { url: summaryUrl, title: "Product Summary" },
      }),
    });
    return "linked";
  } catch (e) {
    say(`  · ${key}: could not add the Confluence link (${String(e.message).split("\n")[0]})`);
    return "failed";
  }
}

const results = [];
const linkCounts = { linked: 0, failed: 0, skipped: 0 };

for (const story of stories) {
  const title = story.summary ?? story.title ?? story.name ?? story.fields?.summary;
  if (!title) { say(`  · skipped a story with no title`); continue; }

  const fields = {
    project: { key: creds.jiraProject },
    issuetype: { name: type },
    summary: String(title).slice(0, 255),
    description: describe(story, title),
  };

  const existingKey = story.jiraKey ?? story.jira_key ?? null;
  if (flags["dry-run"]) {
    say(`  would ${existingKey ? `update ${existingKey}` : "create"}: ${title}` +
      (summaryUrl ? " (+ link to the Confluence page)" : ""));
    continue;
  }

  let key;
  if (existingKey) {
    // project and issuetype are not updatable on an existing issue, and sending
    // them is a 400 rather than a no-op — so they are dropped rather than
    // filtered at the call site.
    const { project: _p, issuetype: _t, ...updatable } = fields;
    await atlassianFetch(creds, `${V2}/issue/${encodeURIComponent(existingKey)}`,
      { method: "PUT", body: JSON.stringify({ fields: updatable }) });
    key = existingKey;
  } else {
    // A parent is set at CREATE time. In a team-managed project the field is
    // `parent`; in a company-managed one an epic link may be a custom field, so
    // a rejection here is reported and the issue is created without it rather
    // than lost.
    let created;
    try {
      created = await atlassianFetch(creds, `${V2}/issue`, {
        method: "POST",
        body: JSON.stringify({
          fields: { ...fields, ...(parentKey ? { parent: { key: parentKey } } : {}) },
        }),
      });
    } catch (e) {
      if (!parentKey) throw e;
      say(`  · could not set parent ${parentKey} (${String(e.message).split("\n")[0]}) — creating without it`);
      created = await atlassianFetch(creds, `${V2}/issue`,
        { method: "POST", body: JSON.stringify({ fields }) });
    }
    key = created.key;
  }

  const url = `${creds.site}/browse/${key}`;
  story.jiraKey = key;
  story.jiraUrl = url;

  const outcome = await linkToPage(key);
  linkCounts[outcome]++;

  results.push({
    story: story.process_number ?? story.number ?? story._meta?.story_number ?? title,
    key, url, pageLink: outcome,
  });
  say(`  ${existingKey ? "updated" : "created"} ${key}  ${title}`);
}

// Written back so a re-run UPDATES rather than duplicating. Nothing else
// records the mapping, and duplicating a client's backlog is not recoverable by
// re-running anything.
if (!flags["dry-run"]) {
  await fs.writeFile(storiesFile, JSON.stringify(raw, null, 2) + "\n", "utf8");
}

if (json) {
  console.log(JSON.stringify({ ok: true, type, issues: results, pageLinks: linkCounts }, null, 2));
} else {
  console.log("");
  console.log("| story | issue | url |");
  console.log("|---|---|---|");
  for (const r of results) console.log(`| ${r.story} | ${r.key} | ${r.url} |`);
  if (summaryUrl) {
    console.log("");
    console.log(`Confluence links: ${linkCounts.linked} added` +
      (linkCounts.failed ? `, ${linkCounts.failed} FAILED — see above` : "") + ".");
  }
}
