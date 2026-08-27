#!/usr/bin/env node
/**
 * Create or update a Confluence page from a markdown file on disk.
 *
 * WHY THIS EXISTS
 * ---------------
 * The publishing agents used to be told: read your document, then pass it to
 * the MCP's createConfluencePage as a tool argument. Measured on a real run
 * (SCY-6, 18 Aug 2026) that fails badly for any real deliverable. The data
 * model is 110 KB; the agent read it into context three times trying to build
 * the tool call, hit a context compaction 13 minutes in, lost its place, and
 * restarted the same approach — $2.73 spent, no page created, and it would have
 * run to the 45-minute budget kill.
 *
 * The document does not need to travel through a language model to reach
 * Confluence. This script sends it straight from disk. The agent's job is to
 * decide WHAT to publish and to render the diagrams; moving bytes is not a
 * reasoning task.
 *
 * Same auth story as confluence-attach.mjs: the API token, Basic, site domain.
 * Publishing a SMALL page can equally go through the Atlassian MCP; this script
 * is what the publish prompt reaches for above ~40 KB, and it is the only thing
 * that can attach the diagrams either way.
 *
 * USAGE
 * -----
 *   node scripts/confluence-publish.mjs <file.md> --space SAPN --title "Title"
 *        [--page-id 12345]                 update this page (skips the title lookup)
 *        [--parent-id 6789]                create under this parent
 *        [--published-json <path> --artefact-key <key>]
 *                                          record {pageId,url,title,space} there
 *        [--render-mermaid]                render every ```mermaid block to PNG
 *                                          and attach it, all in one pass
 *        [--json]                          machine-readable result only
 *
 * Idempotent by title within the space: if a page with the same title already
 * exists it is UPDATED (version + 1), never duplicated. That is what a revision
 * needs — republishing must not leave the client with two documents.
 *
 * IMAGES: markdown `![alt](diagram.png)` becomes
 * `<ac:image><ri:attachment ri:filename="diagram.png"/></ac:image>`, which is
 * how a diagram resolves once `confluence-attach.mjs` has uploaded it. Render
 * and attach the PNGs as well — this script only writes the reference.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  loadAtlassian, fail, resolvePageId, recordPublished, readAtlassianTarget,
} from "./lib/atlassian.mjs";
import { INSTALL_ROOT } from "./lib/roots.mjs";

// `marked` lives in the chatbot's tree — the only place in this repo with a
// markdown parser. Resolved from there rather than added as a second copy at
// the root, which would be a second version to keep in step.
//
// From INSTALL_ROOT rather than process.cwd(): this script is run BY AN AGENT,
// whose working directory is the project tree — and after materialisation that
// is a temp directory with no scyne-chatbot/ in it. The same reasoning already
// governs lib/atlassian.mjs's REPO_ROOT.
const require = createRequire(path.join(INSTALL_ROOT, "scyne-chatbot", "package.json"));
let marked;
try {
  ({ marked } = await import(require.resolve("marked")));
} catch (e) {
  fail(`Could not load 'marked' from scyne-chatbot/node_modules (${e.message}).\n` +
       `  Run: npm --prefix scyne-chatbot install`);
}

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(`--${name}`);

const file = args[0];
if (!file || file.startsWith("--")) {
  fail(`usage: node scripts/confluence-publish.mjs <file.md> --space KEY --title "Title"`);
}
const title = flag("title");
if (!title) fail("--title is required");

const JSON_ONLY = has("json");
const say = (msg) => { if (!JSON_ONLY) console.log(msg); };

/**
 * Render every fenced ```mermaid block to a PNG and swap the fence for an image
 * reference. Folded into this script rather than left to the agent because it
 * is pure plumbing — and because a page published with its diagrams as raw code
 * fences is the single most common way this pipeline has shipped a document
 * that looks broken to the client.
 *
 * PNG, not SVG: Confluence renders PNG inline and shows an SVG attachment as a
 * download link.
 */
async function renderMermaid(md, outDir) {
  const blocks = [...md.matchAll(/```mermaid\s*\n([\s\S]*?)```/g)];
  if (!blocks.length) return { md, files: [] };

  await fs.mkdir(outDir, { recursive: true });
  const files = [];
  let out = md;

  for (const [i, block] of blocks.entries()) {
    const name = `diagram-${i + 1}`;
    const mmd = path.join(outDir, `${name}.mmd`);
    const png = path.join(outDir, `${name}.png`);
    await fs.writeFile(mmd, block[1].trim() + "\n");
    say(`  rendering ${name}.png …`);
    try {
      await execFileAsync("npx", ["-y", "@mermaid-js/mermaid-cli", "-i", mmd, "-o", png,
                                  "--backgroundColor", "white"],
                          { timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    } catch (e) {
      // A diagram that will not render is a finding, not a reason to abandon
      // the page: publish the rest and say which one failed.
      console.error(`  ! ${name} failed to render: ${String(e.message).slice(0, 200)}`);
      continue;
    }
    files.push(png);
    out = out.replace(block[0], `![${name}](${name}.png)`);
  }
  return { md: out, files };
}

/** Markdown → Confluence storage format (an XHTML subset). */
function toStorage(md) {
  // Pull image refs out BEFORE the markdown pass: `marked` would turn them into
  // <img> tags, and Confluence resolves an attachment only through <ac:image>.
  const images = [];
  const withTokens = md.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, src) => {
    const filename = path.basename(src);
    images.push({ filename, alt });
    return `@@CONFLUENCE_IMAGE_${images.length - 1}@@`;
  });

  let html = marked.parse(withTokens, { mangle: false, headerIds: false, async: false });

  // Storage format is XHTML: every void element must be closed, or the whole
  // body is rejected as malformed with an unhelpful 400.
  html = html
    .replace(/<br>/g, "<br/>")
    .replace(/<hr>/g, "<hr/>")
    .replace(/<img([^>]*?)\/?>/g, "<img$1/>");

  html = html.replace(/@@CONFLUENCE_IMAGE_(\d+)@@/g, (_m, i) => {
    const { filename, alt } = images[Number(i)];
    return `<ac:image ac:align="center" ac:alt="${alt.replace(/"/g, "&quot;")}">` +
           `<ri:attachment ri:filename="${filename}"/></ac:image>`;
  });

  return { html, images: images.map((i) => i.filename) };
}

async function api(creds, method, urlPath, body, opts = {}) {
  const r = await fetch(`${creds.site}${urlPath}`, {
    method,
    headers: {
      Authorization: creds.auth,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (r.status === 404 && opts.allow404) return null;
  if (!r.ok) {
    fail(`${method} ${urlPath} → HTTP ${r.status}\n  ${text.slice(0, 600)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function main() {
  const publishedJson = flag("published-json");
  const artefactKey = flag("artefact-key");

  // The space comes from the PROJECT's own recorded target, exactly as the
  // Azure path takes its project from `adoTarget` rather than from a global.
  // `--space` still wins, for a caller publishing something one-off. There is
  // deliberately no environment fallback: one space for the whole install is
  // what per-project targets replaced, and defaulting to one would file a
  // client's document in another client's space.
  const target = publishedJson ? await readAtlassianTarget(publishedJson) : null;
  const space = flag("space") || target?.space;
  if (!space) {
    fail(`No Confluence space. Pass --space, or record an atlassianTarget in\n` +
         `  ${publishedJson ?? ".published.json"} when the project is created.`);
  }

  const creds = await loadAtlassian({ space });

  let md = await fs.readFile(path.resolve(file), "utf8").catch(() => fail(`File not found: ${file}`));

  let rendered = [];
  if (has("render-mermaid")) {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "confluence-diagrams-"));
    const r = await renderMermaid(md, outDir);
    md = r.md;
    rendered = r.files;
    if (rendered.length) say(`  rendered ${rendered.length} diagram(s) into ${outDir}`);
  }

  const { html, images } = toStorage(md);
  say(`  source: ${file} (${md.length} chars → ${html.length} chars of storage format)`);
  if (images.length) say(`  images referenced: ${images.join(", ")}`);

  // Space key → numeric id, which is what the v2 create endpoint wants.
  const spaces = await api(creds, "GET", `/wiki/api/v2/spaces?keys=${encodeURIComponent(space)}`);
  const spaceRow = (spaces.results || [])[0];
  if (!spaceRow) {
    fail(`Confluence space '${space}' does not exist, and this script will not create one.\n` +
         `  Create it in Confluence, or publish to a space that exists.`);
  }

  // Find the existing page: an explicit id wins, otherwise match on title
  // within the space. Title matching is what makes a re-publish an update
  // rather than a duplicate when .published.json has been lost.
  //   1. an explicit --page-id
  //   2. the id recorded for this artefact in .published.json
  //   3. a title match within the space
  //
  // (2) is what the Azure path does with a recorded wikiPath, and it matters
  // MORE here: a Confluence page's title can be edited in the UI by anybody,
  // so title lookup alone would eventually publish a duplicate beside a page
  // somebody had simply renamed.
  let pageId = flag("page-id");
  if (!pageId && publishedJson && artefactKey) {
    pageId = await resolvePageId(publishedJson, artefactKey);
    if (pageId) say(`  page ${pageId} from ${artefactKey} in .published.json`);
  }
  if (!pageId) {
    const found = await api(creds, "GET",
      `/wiki/api/v2/spaces/${spaceRow.id}/pages?title=${encodeURIComponent(title)}&limit=1`);
    pageId = (found.results || [])[0]?.id;
  }

  let page;
  if (pageId) {
    // A recorded id can name a page somebody has since deleted. Falling back to
    // a create is right: the alternative is a run that blocks after its gate
    // was approved, over a page the client threw away on purpose.
    const current = await api(creds, "GET", `/wiki/api/v2/pages/${pageId}`, undefined, { allow404: true });
    if (!current) {
      say(`  recorded page ${pageId} no longer exists — creating a new one`);
      pageId = undefined;
    } else {
      page = await api(creds, "PUT", `/wiki/api/v2/pages/${pageId}`, {
        id: String(pageId),
        status: "current",
        title,
        body: { representation: "storage", value: html },
        version: {
          number: (current.version?.number ?? 1) + 1,
          message: "Updated by the Scyne orchestrator",
        },
      });
      say(`  updated page ${page.id} (version ${page.version?.number})`);
    }
  }
  if (!page) {
    page = await api(creds, "POST", `/wiki/api/v2/pages`, {
      spaceId: spaceRow.id,
      status: "current",
      title,
      body: { representation: "storage", value: html },
      ...(flag("parent-id") ? { parentId: flag("parent-id") } : {}),
    });
    say(`  created page ${page.id}`);
  }

  const url = `${creds.site}/wiki/spaces/${space}/pages/${page.id}`;

  if (publishedJson && artefactKey) {
    // Written here rather than left to the agent: it is the record that makes
    // the NEXT revision an update instead of a second page, and a step the
    // model can forget is a step that eventually gets forgotten.
    //
    // Nested under `atlassian.<key>`, mirroring the Azure path's `ado.<key>`,
    // so one file can hold both and `resolvePublishTarget` can read which a
    // project actually publishes through. The legacy script wrote the key at
    // the TOP level, which would now collide with `adoTarget`.
    await recordPublished(path.resolve(publishedJson), artefactKey,
      { pageId: String(page.id), url, title, space });
    say(`  recorded ${artefactKey} in ${publishedJson}`);
  }

  // Attach in the same pass. `<ac:image>` resolves by filename, so the upload
  // must land or the page publishes with its diagrams silently absent — which
  // is worse than not publishing, because it looks finished.
  if (rendered.length) {
    const attach = path.join(path.dirname(fileURLToPath(import.meta.url)), "confluence-attach.mjs");
    try {
      const { stdout } = await execFileAsync("node", [attach, String(page.id), ...rendered],
                                             { timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
      say(stdout.trim().split("\n").map((l) => `  ${l}`).join("\n"));
    } catch (e) {
      fail(`Page ${page.id} was published but its diagrams could not be attached:\n` +
           `  ${String(e.stderr || e.message).slice(0, 500)}\n` +
           `  The page now references images that are not there. Attach them with:\n` +
           `  node scripts/confluence-attach.mjs ${page.id} ${rendered.join(" ")}`);
    }
  }

  if (JSON_ONLY) {
    console.log(JSON.stringify({ pageId: String(page.id), url, title, space, images }, null, 2));
  } else {
    say(``);
    say(`  ${url}`);
    if (images.length && !rendered.length) {
      say(``);
      say(`  Now attach the diagrams, or they will be missing from the page:`);
      say(`    node scripts/confluence-attach.mjs ${page.id} ${images.join(" ")}`);
    }
  }
}

main().catch((e) => fail(e?.message ?? String(e)));
