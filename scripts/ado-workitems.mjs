#!/usr/bin/env node
/**
 * Create or update Azure DevOps work items from a `stories.json` on disk.
 *
 * WHAT IT REPLACES
 * ----------------
 * The Jira path told the model to substitute `{{PRODUCT_SUMMARY_URL}}` into
 * every description before creating the issue — and that doubled brace exists
 * only because the engine's own interpolator once matched the inner
 * `{PRODUCT_SUMMARY_URL}` and blocked every requirements run at publish,
 * immediately after a human had approved its gate. `--summary-url` moves that
 * substitution here, where it is a string replace instead of an instruction a
 * model can forget.
 *
 * THE WORK ITEM TYPE IS DISCOVERED, NOT ASSUMED
 * ---------------------------------------------
 * "User Story" only exists in the Agile process template. Measured on the real
 * target (Scyne-AI-Lab / Scyne AI Project, 20 Aug 2026): it runs the **Basic**
 * template, whose types are Epic → Issue → Task, with no User Story at all. A
 * script that hard-coded `$User Story` would fail on every single story with
 * "type does not exist". So the type is read from the project and matched
 * against a preference order, and `--type` overrides.
 *
 * USAGE
 * -----
 *   node scripts/ado-workitems.mjs <stories.json>
 *        [--org <org>] [--project <project>]
 *        [--type "User Story"]        override the discovered type
 *        [--parent <id>]              link each item under this work item
 *        [--summary-url <url>]        substituted for {{PRODUCT_SUMMARY_URL}}
 *        [--dry-run] [--json]
 *
 * Re-running UPDATES rather than duplicating: the created id is written back
 * into stories.json, and a story that already has one is patched.
 */

import fs from "node:fs/promises";
import process from "node:process";
import { API, adoFetch, fail, loadAdo, parseArgs, projectPath } from "./lib/ado.mjs";

const { flags, positional } = parseArgs(process.argv.slice(2));
const json = Boolean(flags.json);
const say = (s) => { if (!json) console.log(s); };

const storiesFile = positional[0];
if (!storiesFile) fail(`usage: node scripts/ado-workitems.mjs <stories.json> [--parent <id>] [--summary-url <url>]`);

const ado = await loadAdo({ org: flags.org, project: flags.project });
if (!ado.project) fail(`No project. Pass --project, or set ADO_PROJECT in .env.`);

/**
 * The type to create stories as.
 *
 * Preference order rather than a single default: whichever of these the
 * project actually has is the one that means "a unit of deliverable work" in
 * its template.
 */
const PREFERRED = ["User Story", "Product Backlog Item", "Issue", "Requirement", "Task"];

async function resolveType(explicit) {
  const meta = await adoFetch(ado, `${projectPath(ado)}/_apis/wit/workitemtypes?api-version=${API}`);
  const available = (meta.value ?? []).map((t) => t.name);
  if (explicit) {
    if (!available.includes(explicit)) {
      fail(`'${ado.project}' has no work item type '${explicit}'.\n  It has: ${available.join(", ")}`);
    }
    return explicit;
  }
  const hit = PREFERRED.find((p) => available.includes(p));
  if (!hit) fail(`'${ado.project}' has none of ${PREFERRED.join(", ")}. It has: ${available.join(", ")}`);
  return hit;
}

const type = await resolveType(typeof flags.type === "string" ? flags.type : undefined);
say(`Creating work items as '${type}' in ${ado.org}/${ado.project}`);

const raw = JSON.parse(await fs.readFile(storiesFile, "utf8").catch(() => fail(`Cannot read ${storiesFile}`)));
// stories.json has been written as both a bare array and {stories:[...]}.
const stories = Array.isArray(raw) ? raw : (raw.stories ?? raw.items ?? []);
if (!stories.length) fail(`${storiesFile} contains no stories.`);

const summaryUrl = typeof flags["summary-url"] === "string" ? flags["summary-url"] : null;

/** ADO descriptions are HTML, not Atlassian Document Format and not markdown. */
const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function describe(story, title) {
  const parts = [];
  if (story.description) parts.push(`<p>${esc(story.description)}</p>`);
  const ac = story.acceptanceCriteria ?? story.acceptance_criteria ?? [];
  if (Array.isArray(ac) && ac.length) {
    parts.push(`<p><b>Acceptance criteria</b></p><ul>${ac.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>`);
  }
  let html = parts.join("");
  if (summaryUrl) html = html.split("{{PRODUCT_SUMMARY_URL}}").join(esc(summaryUrl));

  // The whole reason the substitution lives in this script rather than in a
  // model's instructions is that it must not be forgettable. Observed while
  // testing: a re-run WITHOUT --summary-url re-rendered the description from
  // source and quietly put the placeholder back over the substituted one —
  // silently un-publishing the link in every story.
  if (html.includes("{{PRODUCT_SUMMARY_URL}}")) {
    fail(
      `'${String(title ?? "a story")}' still contains {{PRODUCT_SUMMARY_URL}} and no --summary-url was given.\n` +
      `  Pass --summary-url <the published wiki page URL>. Writing the placeholder into a\n` +
      `  client's backlog is worse than not writing the item — and on a RE-RUN it would\n` +
      `  overwrite a link that was already correct.`);
  }
  return html;
}

const results = [];
for (const story of stories) {
  const title = story.summary ?? story.title ?? story.name;
  if (!title) { say(`  · skipped a story with no title`); continue; }

  const acText = (story.acceptanceCriteria ?? story.acceptance_criteria ?? []);
  const ops = [
    { op: "add", path: "/fields/System.Title", value: String(title).slice(0, 255) },
    { op: "add", path: "/fields/System.Description", value: describe(story, title) },
  ];
  if (Array.isArray(acText) && acText.length) {
    ops.push({
      op: "add", path: "/fields/Microsoft.VSTS.Common.AcceptanceCriteria",
      value: `<ul>${acText.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>`,
    });
  }

  const existingId = story.adoId ?? story.ado_id ?? null;
  if (flags["dry-run"]) {
    say(`  would ${existingId ? `update #${existingId}` : "create"}: ${title}`);
    continue;
  }

  let item;
  if (existingId) {
    item = await adoFetch(ado,
      `${projectPath(ado)}/_apis/wit/workitems/${existingId}?api-version=${API}`,
      { method: "PATCH", headers: { "Content-Type": "application/json-patch+json" }, body: JSON.stringify(ops) });
  } else {
    if (flags.parent) {
      // Hierarchy-Reverse points from the CHILD to its parent, which is the
      // direction this link has to be created in.
      ops.push({
        op: "add", path: "/relations/-",
        value: {
          rel: "System.LinkTypes.Hierarchy-Reverse",
          url: `${projectPath(ado)}/_apis/wit/workItems/${flags.parent}`,
        },
      });
    }
    item = await adoFetch(ado,
      `${projectPath(ado)}/_apis/wit/workitems/$${encodeURIComponent(type)}?api-version=${API}`,
      { method: "POST", headers: { "Content-Type": "application/json-patch+json" }, body: JSON.stringify(ops) });
  }

  const url = `${projectPath(ado)}/_workitems/edit/${item.id}`;
  story.adoId = item.id;
  story.adoUrl = url;
  results.push({ story: story.process_number ?? story.number ?? title, id: item.id, url });
  say(`  ${existingId ? "updated" : "created"} #${item.id}  ${title}`);
}

// Written back so a re-run UPDATES rather than duplicating. Nothing else
// records the mapping, and duplicating a client's backlog is not recoverable
// by re-running anything.
if (!flags["dry-run"]) {
  await fs.writeFile(storiesFile, JSON.stringify(raw, null, 2) + "\n", "utf8");
}

if (json) console.log(JSON.stringify({ ok: true, type, items: results }, null, 2));
else {
  console.log("");
  console.log("| story | work item | url |");
  console.log("|---|---|---|");
  for (const r of results) console.log(`| ${r.story} | ${r.id} | ${r.url} |`);
}
