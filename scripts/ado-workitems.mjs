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
 *        [--published-json <file>]    projects/<project>/.published.json
 *        [--artefact-key <key>]       e.g. "CRM-Management/requirements".
 *                                     With --published-json it does two things
 *                                     from the one record: adds a real
 *                                     Links-tab Wiki relation to each item,
 *                                     and supplies --summary-url when none was
 *                                     passed — which is what lets the
 *                                     requirements workflow run this as a
 *                                     plain `exec` step, since the page URL
 *                                     does not exist when that command is
 *                                     compiled.
 *        [--dry-run] [--json]
 *
 * Re-running UPDATES rather than duplicating: the created id is written back
 * into stories.json, and a story that already has one is patched.
 *
 * THE WIKI LINK'S ARTIFACT URI IS NOT DOCUMENTED ANYWHERE PUBLIC
 * ---------------------------------------------------------------
 * `vstfs:///Wiki/WikiPage/{projectId}%2F{wikiId}%2F{pagePath, no leading
 * slash, URL-encoded}` — reverse-engineered by comparing a manually-created
 * link's stored relation against a guessed construction (2026-08-22). Verified
 * two ways: it matched the manual one byte-for-byte, and Azure DevOps itself
 * confirmed the match by refusing a duplicate with `RelationAlreadyExistsException`
 * when both were present on the same work item. The first guess put the page
 * path's leading "/" through `encodeURIComponent` as part of the segment
 * instead of stripping it first, which double-encoded it (`%2f%2F` instead of
 * `%2F`) and created a relation ADO accepted (200) but never rendered — a
 * PATCH returning success here is not evidence the link is real.
 */

import fs from "node:fs/promises";
import process from "node:process";
import { API, adoFetch, fail, loadAdo, parseArgs, projectPath, readAdoTarget, readPublished }
  from "./lib/ado.mjs";

const { flags, positional } = parseArgs(process.argv.slice(2));
const json = Boolean(flags.json);
const say = (s) => { if (!json) console.log(s); };

const storiesFile = positional[0];
if (!storiesFile) fail(`usage: node scripts/ado-workitems.mjs <stories.json> [--parent <id>]\n  [--summary-url <url> | --published-json <file> --artefact-key <key>]`);

// Same target resolution as ado-publish.mjs: the Scyne project's own
// .published.json, never an installation-wide environment default.
const publishedJson = typeof flags["published-json"] === "string" ? flags["published-json"] : null;
// Read once, here, because BOTH of the things this file does with a published
// page need it: resolving the summary URL when --summary-url is absent, and
// building the Links-tab wiki relation. Two consts reading one flag is how the
// two quietly stop agreeing about which page an item points at.
const artefactKey = typeof flags["artefact-key"] === "string" ? flags["artefact-key"] : null;
const target = await readAdoTarget(publishedJson);

const ado = await loadAdo({
  org: flags.org || target?.org,
  project: flags.project || target?.project,
  workItemType: flags.type || target?.workItemType,
});
if (!ado.project) {
  fail(
    `No Azure DevOps project.\n` +
    `  Pass --project, or point --published-json at a projects/<project>/.published.json\n` +
    `  carrying an "adoTarget". A project created before per-project targets needs one\n` +
    `  backfilled — see docs/superpowers/specs/2026-08-21-ado-project-per-scyne-project-design.md.`);
}

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

// `ado.workItemType` already folds in `--type` and the project's recorded
// `adoTarget.workItemType`. Discovery below is still the fallback, so a
// project with no recorded type is a correct guess rather than a crash.
const type = await resolveType(ado.workItemType ?? undefined);
say(`Creating work items as '${type}' in ${ado.org}/${ado.project}`);

const raw = JSON.parse(await fs.readFile(storiesFile, "utf8").catch(() => fail(`Cannot read ${storiesFile}`)));
// stories.json has been written as both a bare array and {stories:[...]}.
const stories = Array.isArray(raw) ? raw : (raw.stories ?? raw.items ?? []);
if (!stories.length) fail(`${storiesFile} contains no stories.`);

/**
 * The wiki URL substituted for `{{PRODUCT_SUMMARY_URL}}` in every description.
 *
 * `--summary-url` still wins, but it no longer has to be supplied. The page
 * was published moments before this runs, and `ado-publish.mjs` recorded its
 * URL under `ado.<artefact-key>` in the same `.published.json` this script
 * already reads its target from — so the URL is on disk by the time it is
 * needed.
 *
 * That is what lets the backlog half of the requirements stage be an ordinary
 * `exec` step. A workflow command is a fixed string compiled before the run;
 * it cannot name a URL that will not exist until the step before it has
 * finished. Reading it back from the record the publish just wrote can.
 */
async function resolveSummaryUrl() {
  const explicit = flags["summary-url"];
  if (typeof explicit === "string" && explicit) return explicit;

  if (!publishedJson || !artefactKey) return null;

  const record = (await readPublished(publishedJson))?.ado?.[artefactKey] ?? null;
  if (!record) return null;

  if (record.url) {
    say(`Summary URL read from ${publishedJson} -> ado.${artefactKey}`);
    return record.url;
  }

  // `ado-publish.mjs` records `url` alongside `wikiPath`; a record written by
  // hand after a `wiki_upsert_page` tool call may carry only the path. Rebuild
  // it from the same parts that script uses rather than failing the whole
  // backlog over a missing convenience field — the page identity is the path,
  // and that is what is actually recorded.
  const pagePath = record.wikiPath ?? record.path ?? null;
  const wikiName = record.wiki ?? null;
  if (pagePath && wikiName) {
    const built = `${projectPath(ado)}/_wiki/wikis/${encodeURIComponent(wikiName)}` +
      `?pagePath=${encodeURIComponent(pagePath)}`;
    say(`Summary URL rebuilt from ado.${artefactKey}.wikiPath (no url recorded)`);
    return built;
  }
  return null;
}
const summaryUrl = await resolveSummaryUrl();

/**
 * The work item every story is linked under, when there is one.
 *
 * `--parent` wins. The fallback is the workflow param, which reaches an exec
 * step through the environment rather than through a `{placeholder}` in its
 * command: the engine's interpolator THROWS on a placeholder the issue does
 * not carry, and `adoParentEpicId` is optional on every run.
 */
const parentId = flags.parent ?? process.env.SCYNE_PARAM_ADOPARENTEPICID ?? null;
if (parentId) say(`Linking each new item under work item #${parentId}`);

// A real Links-tab relation, not just the inline hyperlink --summary-url
// gives the description. Optional: needs --published-json AND --artefact-key
// to name which published page to link, so an invocation without them just
// skips this — the inline hyperlink still happens regardless.
async function resolveWikiArtifactUri() {
  if (!publishedJson || !artefactKey) return null;
  const record = (await readPublished(publishedJson))?.ado?.[artefactKey];
  if (!record?.wikiId || !record?.wikiPath) return null;

  const project = await adoFetch(ado, `${orgUrl(ado)}/_apis/projects/${encodeURIComponent(ado.project)}?api-version=${API}`);
  const pagePath = String(record.wikiPath).replace(/^\//, "");
  return `vstfs:///Wiki/WikiPage/${project.id}%2F${record.wikiId}%2F${encodeURIComponent(pagePath)}`;
}

function orgUrl(a) { return `https://dev.azure.com/${encodeURIComponent(a.org)}`; }

const wikiArtifactUri = await resolveWikiArtifactUri();
if (artefactKey && !wikiArtifactUri) {
  say(`  (no recorded wiki page for artefact "${artefactKey}" — skipping the Links-tab relation, inline hyperlink only)`);
}

/** Best-effort — a failed link must never fail the work item it belongs to. */
async function linkToWikiPage(id) {
  if (!wikiArtifactUri) return "skipped";
  const ops = [{ op: "add", path: "/relations/-", value: { rel: "ArtifactLink", url: wikiArtifactUri, attributes: { name: "Wiki Page" } } }];
  try {
    await adoFetch(ado, `${projectPath(ado)}/_apis/wit/workitems/${id}?api-version=${API}`,
      { method: "PATCH", headers: { "Content-Type": "application/json-patch+json" }, body: JSON.stringify(ops) });
    return "linked";
  } catch (e) {
    if (String(e.message).includes("RelationAlreadyExistsException")) return "already";
    say(`  · #${id}: could not add the wiki link (${String(e.message).split("\n")[0]})`);
    return "failed";
  }
}

/** ADO descriptions are HTML, not Atlassian Document Format and not markdown. */
const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// `requirement-generator` still writes `fields.description` as Jira WIKI
// MARKUP (`h3. Heading`, `*bold*`, `* bullet`) — the body template the skill
// still uses is unchanged from the Jira/Confluence era, ADO descriptions are
// HTML. Dumped through `esc()` alone, every story rendered as one
// unformatted paragraph with literal "h3." and "*" characters visible.
// Blocks are separated by a blank line, same convention Jira wiki markup
// itself uses, so splitting on that is enough to recover the structure.
function jiraWikiToHtml(text) {
  const bold = (raw) => esc(raw).replace(/\*([^\n*]+)\*/g, "<b>$1</b>");
  const blocks = String(text ?? "").split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((block) => {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 1 && /^h3\.\s+/.test(lines[0])) {
      return `<h3>${bold(lines[0].replace(/^h3\.\s+/, ""))}</h3>`;
    }
    if (lines.every((l) => l.startsWith("* "))) {
      return `<ul>${lines.map((l) => `<li>${bold(l.slice(2))}</li>`).join("")}</ul>`;
    }
    // "*Acceptance Criteria (AC):*" followed by its "* " bullets is one block
    // — the label and the list render separately, not as one bullet.
    if (lines.length > 1 && lines.slice(1).every((l) => l.startsWith("* "))) {
      return `<p>${bold(lines[0])}</p><ul>${lines.slice(1).map((l) => `<li>${bold(l.slice(2))}</li>`).join("")}</ul>`;
    }
    return `<p>${bold(lines.join(" "))}</p>`;
  }).join("");
}

// `requirement-generator` still writes stories.json as Atlassian Cloud
// REST v3 create-issue payloads — `{fields: {summary, description, ...}}` —
// a leftover from before this pipeline moved off Jira/Confluence that the
// skill was never updated to drop. Every field read here falls back through
// `story.fields.*` for that reason: without it, EVERY story in EVERY
// project's stories.json reads as titleless and this script silently
// creates nothing, which is what happened here before this fallback existed.
function describe(story, title) {
  const parts = [];
  const description = story.description ?? story.fields?.description;
  if (description) parts.push(jiraWikiToHtml(description));
  const ac = story.acceptanceCriteria ?? story.acceptance_criteria ?? [];
  if (Array.isArray(ac) && ac.length) {
    parts.push(`<p><b>Acceptance criteria</b></p><ul>${ac.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>`);
  }
  let html = parts.join("");
  if (summaryUrl) {
    // A real hyperlink, not the bare URL as text — {{PRODUCT_SUMMARY_URL}}
    // sits after a "Product Summary:" label (see jiraWikiToHtml), so this is
    // the one place in the description a reader can click through to the
    // wiki page rather than having to copy a plain string.
    html = html.split("{{PRODUCT_SUMMARY_URL}}").join(`<a href="${esc(summaryUrl)}">${esc(summaryUrl)}</a>`);
  }

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
const linkCounts = { linked: 0, already: 0, failed: 0, skipped: 0 };
for (const story of stories) {
  const title = story.summary ?? story.title ?? story.name ?? story.fields?.summary;
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
    say(`  would ${existingId ? `update #${existingId}` : "create"}: ${title}` +
      (wikiArtifactUri ? ` (+ link to wiki page)` : ""));
    continue;
  }

  let item;
  if (existingId) {
    item = await adoFetch(ado,
      `${projectPath(ado)}/_apis/wit/workitems/${existingId}?api-version=${API}`,
      { method: "PATCH", headers: { "Content-Type": "application/json-patch+json" }, body: JSON.stringify(ops) });
  } else {
    if (parentId) {
      // Hierarchy-Reverse points from the CHILD to its parent, which is the
      // direction this link has to be created in.
      ops.push({
        op: "add", path: "/relations/-",
        value: {
          rel: "System.LinkTypes.Hierarchy-Reverse",
          url: `${projectPath(ado)}/_apis/wit/workItems/${parentId}`,
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

  const linkOutcome = await linkToWikiPage(item.id);
  linkCounts[linkOutcome]++;

  results.push({ story: story.process_number ?? story.number ?? story._meta?.story_number ?? title, id: item.id, url, wikiLink: linkOutcome });
  say(`  ${existingId ? "updated" : "created"} #${item.id}  ${title}`);
}

// Written back so a re-run UPDATES rather than duplicating. Nothing else
// records the mapping, and duplicating a client's backlog is not recoverable
// by re-running anything.
if (!flags["dry-run"]) {
  await fs.writeFile(storiesFile, JSON.stringify(raw, null, 2) + "\n", "utf8");
}

if (json) console.log(JSON.stringify({ ok: true, type, items: results, wikiLinks: linkCounts }, null, 2));
else {
  console.log("");
  console.log("| story | work item | url |");
  console.log("|---|---|---|");
  for (const r of results) console.log(`| ${r.story} | ${r.id} | ${r.url} |`);
  if (wikiArtifactUri) {
    console.log("");
    console.log(`Wiki page links: ${linkCounts.linked} added, ${linkCounts.already} already there` +
      (linkCounts.failed ? `, ${linkCounts.failed} FAILED — see above` : "") + ".");
  }
}
