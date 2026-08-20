#!/usr/bin/env node
/**
 * Create or update an Azure DevOps wiki page from a markdown file on disk.
 *
 * WHY THIS EXISTS
 * ---------------
 * Publishing is done through the Azure DevOps MCP by default — that is the
 * chosen design. This script is the escape hatch for the one failure mode that
 * has already been measured on this project: on run SCY-6 (18 Aug 2026) an
 * agent was told to read a 110 KB document and pass it to an MCP tool as a page
 * body. It read the document three times building the call, hit a context
 * compaction thirteen minutes in, lost its place and started again — $2.73
 * spent, no page created, and it would have run to the 45-minute budget kill.
 *
 * The document does not need to travel through a language model to reach a
 * wiki. This sends it straight from disk. Reach for it when a publish is large
 * enough to be at risk, or when the MCP is unavailable.
 *
 * It gets simpler than Confluence did: ADO wiki takes MARKDOWN NATIVELY, so
 * there is no storage-format conversion, and it renders ```mermaid fences
 * itself, so there is no PNG pass and nothing to attach.
 *
 * USAGE
 * -----
 *   node scripts/ado-publish.mjs <file.md> --path "/Scyne/RTWSA/Data Model"
 *        [--org <org>] [--project <project>] [--wiki <wiki>]
 *        [--attach diagram.png ...]         upload and rewrite the reference
 *        [--published-json <path> --artefact-key <key>]
 *        [--verify]                         check the target and exit
 *        [--json]
 *
 * IDEMPOTENT BY PATH. Republishing a revision updates the page in place and
 * can never leave the client with two documents — which is why identity is the
 * path rather than a title lookup plus a remembered id.
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { API, adoFetch, fail, loadAdo, orgPath, parseArgs, projectPath, readPublished, recordPublished }
  from "./lib/ado.mjs";

const { flags, positional } = parseArgs(process.argv.slice(2));
const json = Boolean(flags.json);
const say = (s) => { if (!json) console.log(s); };

const ado = await loadAdo({ org: flags.org, project: flags.project });
if (!ado.project) fail(`No project. Pass --project, or set ADO_PROJECT in .env.`);

/** The wiki to write to: named, or the project's only one. */
async function resolveWiki(name) {
  let wikis;
  try {
    wikis = await adoFetch(ado, `${projectPath(ado)}/_apis/wiki/wikis?api-version=${API}`);
  } catch (err) {
    fail(
      `Cannot list the wikis in '${ado.project}'.\n  ${String(err.message).split("\n").join("\n  ")}\n\n` +
      `  If projects and work items work but this does not, the token is missing the\n` +
      `  **wiki** scope specifically (vso.wiki / vso.wiki_write). Azure DevOps answers a\n` +
      `  missing scope with 401, which reads exactly like a bad token.`);
  }
  const all = wikis.value ?? [];
  if (!all.length) {
    fail(`Project '${ado.project}' has no wiki. Create one in Azure DevOps first — this script\n` +
         `  will not create it, because a wiki is a one-off decision about where a client's\n` +
         `  documents live and not something a publish step should make on its own.`);
  }
  if (name) {
    const hit = all.find((w) => w.name === name || w.id === name);
    if (!hit) fail(`No wiki '${name}' in '${ado.project}'. There is: ${all.map((w) => w.name).join(", ")}`);
    return hit;
  }
  if (all.length > 1) {
    fail(`'${ado.project}' has ${all.length} wikis (${all.map((w) => w.name).join(", ")}).\n` +
         `  Name one with --wiki — guessing which of a client's wikis to write to is not a\n` +
         `  guess worth making.`);
  }
  return all[0];
}

// ------------------------------------------------------------------- verify

if (flags.verify) {
  const result = { org: ado.org, project: ado.project, checks: [] };
  const check = async (label, fn) => {
    try { const v = await fn(); result.checks.push({ label, ok: true, detail: v }); say(`  ✓ ${label}${v ? ` — ${v}` : ""}`); }
    catch (err) {
      result.checks.push({ label, ok: false, detail: String(err.message).split("\n")[0] });
      say(`  ✗ ${label}\n      ${String(err.message).split("\n").join("\n      ")}`);
    }
  };
  say(`Checking ${ado.org} / ${ado.project}`);
  await check("organisation reachable and the token is valid", async () => {
    const r = await adoFetch(ado, `${orgPath(ado)}/_apis/projects?api-version=${API}`);
    return `${r.count} project(s)`;
  });
  await check("project exists", async () => {
    const r = await adoFetch(ado, `${orgPath(ado)}/_apis/projects/${encodeURIComponent(ado.project)}?api-version=${API}`);
    return r.name;
  });
  await check("token has the WIKI scope", async () => {
    const r = await adoFetch(ado, `${projectPath(ado)}/_apis/wiki/wikis?api-version=${API}`);
    return `${r.count} wiki(s): ${(r.value ?? []).map((w) => w.name).join(", ") || "none"}`;
  });
  await check("token has the WORK ITEM scope", async () => {
    const r = await adoFetch(ado, `${projectPath(ado)}/_apis/wit/workitemtypes?api-version=${API}`);
    return `${(r.value ?? []).length} type(s)`;
  });

  const failed = result.checks.filter((c) => !c.ok);
  if (json) console.log(JSON.stringify({ ...result, ok: !failed.length }, null, 2));
  else if (failed.length) {
    console.log("");
    console.log(`${failed.length} check(s) failed. Fix these before a run reaches the publish step —`);
    console.log(`a target that is wrong is far cheaper to discover now than after a document is built.`);
  } else say(`\nAll checks passed.`);
  process.exit(failed.length ? 1 : 0);
}

// ------------------------------------------------------------------ publish

const file = positional[0];
if (!file) fail(`usage: node scripts/ado-publish.mjs <file.md> --path "/Some/Page" [--wiki <name>]`);
const pagePath = flags.path;
if (typeof pagePath !== "string" || !pagePath.startsWith("/")) {
  fail(`--path is required and must start with "/" (e.g. --path "/Scyne/RTWSA/Data Model")`);
}

let content = await fs.readFile(file, "utf8").catch(() => fail(`Cannot read ${file}`));
const wiki = await resolveWiki(typeof flags.wiki === "string" ? flags.wiki : undefined);

// Attachments. ADO stores them per wiki and serves them from /.attachments/,
// so the markdown reference has to be rewritten to that path.
const attachments = [].concat(flags.attach ?? []).filter((a) => typeof a === "string");
for (const rel of attachments) {
  const name = path.basename(rel);
  const bytes = await fs.readFile(path.resolve(path.dirname(file), rel))
    .catch(() => fail(`Cannot read attachment ${rel}`));
  await adoFetch(ado,
    `${projectPath(ado)}/_apis/wiki/wikis/${wiki.id}/attachments` +
    `?name=${encodeURIComponent(name)}&api-version=${API}`,
    { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: bytes });
  // Re-uploading a name replaces it in place, which is what a revision needs.
  content = content.split(`](${rel})`).join(`](/.attachments/${name})`);
  if (rel !== name) content = content.split(`](${name})`).join(`](/.attachments/${name})`);
  say(`  attached ${name}`);
}

const pageUrl = `${projectPath(ado)}/_apis/wiki/wikis/${wiki.id}/pages` +
  `?path=${encodeURIComponent(pagePath)}&api-version=${API}`;

// An UPDATE needs the current ETag in If-Match; a CREATE is the bare PUT.
// Fetching first is how we tell which this is — and it is also what makes the
// operation idempotent by path rather than by remembered id.
let etag = null;
try {
  const res = await fetch(pageUrl, { headers: { Authorization: ado.auth, Accept: `application/json;api-version=${API}` } });
  if (res.ok) etag = res.headers.get("etag");
} catch { /* treated as "does not exist yet" */ }

const saved = await adoFetch(ado, pageUrl, {
  method: "PUT",
  headers: { "Content-Type": "application/json", ...(etag ? { "If-Match": etag } : {}) },
  body: JSON.stringify({ content }),
});

const viewUrl = `${projectPath(ado)}/_wiki/wikis/${encodeURIComponent(wiki.name)}` +
  `?pagePath=${encodeURIComponent(pagePath)}`;

if (flags["published-json"] && flags["artefact-key"]) {
  await recordPublished(String(flags["published-json"]), String(flags["artefact-key"]), {
    wikiPath: pagePath, wiki: wiki.name, wikiId: wiki.id,
    project: ado.project, org: ado.org, url: viewUrl,
    pageId: saved?.id ?? null, publishedAt: new Date().toISOString(),
  });
}

if (json) {
  console.log(JSON.stringify({ ok: true, action: etag ? "updated" : "created", path: pagePath, url: viewUrl }, null, 2));
} else {
  say(`✓ ${etag ? "updated" : "created"} ${pagePath} in wiki '${wiki.name}'`);
  console.log(viewUrl);
}
