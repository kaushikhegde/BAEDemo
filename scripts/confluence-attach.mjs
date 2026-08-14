#!/usr/bin/env node
/**
 * Upload files as attachments to a Confluence page.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every publishing agent renders its Mermaid diagrams to PNG and embeds them
 * with `<ac:image>`, which only works if the PNG is attached to the page. The
 * Atlassian MCP cannot do that: the OAuth grant `mcp-remote` obtains carries 20
 * scopes, 8 of them Confluence, and NONE of them attachment scopes —
 *
 *   read:comment  read:confluence-user  read:hierarchical-content
 *   read:page     read:space            search  write:comment  write:page
 *
 * so `POST .../child/attachment` returns 401 "scope does not match" no matter
 * which host it is sent to. That scope list is fixed by Atlassian's MCP OAuth
 * app, so re-authorising does not add it. Agents that improvised a raw curl
 * also aimed at the site domain with a 3LO bearer token, which is a second,
 * independent failure (3LO tokens are only valid against api.atlassian.com).
 *
 * The API token in `scyne-chatbot/.env` has the full permissions of the user it
 * belongs to, including attachments, and it authenticates with Basic auth
 * against the SITE domain. That is what this script uses.
 *
 * USAGE
 * -----
 *   node scripts/confluence-attach.mjs <pageId> <file> [<file> ...]
 *   node scripts/confluence-attach.mjs <pageId> <file> --json
 *
 * Idempotent: a file whose name is already attached is UPDATED in place (a new
 * version of that attachment) rather than rejected or duplicated, so a revision
 * re-publishing the same diagrams does not litter the page.
 *
 * Prints an `<ac:image>` snippet per uploaded file — paste it straight into the
 * page body where the Mermaid block was.
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".feature": "text/plain",
  ".txt": "text/plain",
};

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

/** Env vars win; otherwise read scyne-chatbot/.env (the only place these live). */
async function loadCredentials() {
  let site = process.env.ATLASSIAN_SITE_URL;
  let email = process.env.ATLASSIAN_EMAIL;
  let token = process.env.ATLASSIAN_API_TOKEN;

  if (!site || !email || !token) {
    const envPath = path.resolve(process.cwd(), "scyne-chatbot", ".env");
    let raw = "";
    try {
      raw = await fs.readFile(envPath, "utf8");
    } catch {
      fail(
        `No Atlassian API token available.\n` +
          `  Looked for ATLASSIAN_SITE_URL / ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN in the\n` +
          `  environment and in ${envPath}.\n` +
          `  The Atlassian MCP token CANNOT be used here — its OAuth grant has no\n` +
          `  attachment scope. Set an API token from id.atlassian.com/manage-profile/security/api-tokens.`
      );
    }
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const val = m[2].replace(/^["']|["']$/g, "");
      if (m[1] === "ATLASSIAN_SITE_URL" && !site) site = val;
      if (m[1] === "ATLASSIAN_EMAIL" && !email) email = val;
      if (m[1] === "ATLASSIAN_API_TOKEN" && !token) token = val;
    }
  }

  const missing = [
    !site && "ATLASSIAN_SITE_URL",
    !email && "ATLASSIAN_EMAIL",
    !token && "ATLASSIAN_API_TOKEN",
  ].filter(Boolean);
  if (missing.length) fail(`Missing credential(s): ${missing.join(", ")}`);

  return {
    // Trailing slash breaks the concatenated paths below.
    site: site.replace(/\/+$/, ""),
    auth: "Basic " + Buffer.from(`${email}:${token}`).toString("base64"),
  };
}

/** Existing attachment id for `filename` on this page, or null. */
async function findExisting({ site, auth }, pageId, filename) {
  const url =
    `${site}/wiki/rest/api/content/${encodeURIComponent(pageId)}/child/attachment` +
    `?filename=${encodeURIComponent(filename)}`;
  const r = await fetch(url, { headers: { Authorization: auth, Accept: "application/json" } });
  if (r.status === 404) return null;
  if (!r.ok) {
    const body = await r.text();
    fail(`Could not list attachments on page ${pageId} (HTTP ${r.status}).\n  ${body.slice(0, 300)}`);
  }
  const data = await r.json();
  const hit = (data.results || []).find((a) => a.title === filename);
  return hit ? hit.id : null;
}

async function uploadOne(creds, pageId, file) {
  const abs = path.resolve(file);
  let buf;
  try {
    buf = await fs.readFile(abs);
  } catch {
    fail(`File not found: ${abs}`);
  }
  const filename = path.basename(abs);
  const type = MIME[path.extname(filename).toLowerCase()] || "application/octet-stream";

  const existingId = await findExisting(creds, pageId, filename);

  const form = new FormData();
  form.append("file", new Blob([buf], { type }), filename);
  form.append("minorEdit", "true");

  // Updating an existing attachment posts to its /data sub-resource; creating a
  // new one posts to the page's attachment collection. Posting a duplicate
  // filename to the collection is an error, which is why we branch.
  const url = existingId
    ? `${creds.site}/wiki/rest/api/content/${encodeURIComponent(pageId)}/child/attachment/${existingId}/data`
    : `${creds.site}/wiki/rest/api/content/${encodeURIComponent(pageId)}/child/attachment`;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: creds.auth,
      // Confluence rejects multipart uploads without this XSRF opt-out.
      "X-Atlassian-Token": "no-check",
      Accept: "application/json",
    },
    body: form,
  });

  const text = await r.text();
  if (!r.ok) {
    let hint = "";
    if (r.status === 401 || r.status === 403) {
      hint =
        `\n  ${r.status} usually means the credential cannot write here. Check that the\n` +
        `  API token belongs to a user with edit rights on this space — and note the\n` +
        `  MCP OAuth token will ALWAYS fail here (no attachment scope).`;
    }
    fail(`Upload failed for ${filename} (HTTP ${r.status}).\n  ${text.slice(0, 300)}${hint}`);
  }

  let id = existingId;
  try {
    const data = JSON.parse(text);
    id = data.id || data.results?.[0]?.id || existingId;
  } catch { /* update returns a body we don't need to parse */ }

  return { filename, id, action: existingId ? "updated" : "created" };
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const json = args.includes("--json");
  const rest = args.filter((a) => a !== "--json");
  const [pageId, ...files] = rest;

  if (!pageId || files.length === 0) {
    console.error("usage: node scripts/confluence-attach.mjs <pageId> <file> [<file> ...] [--json]");
    process.exit(2);
  }
  if (!/^\d+$/.test(pageId)) {
    fail(`Page id must be numeric (got "${pageId}"). It is the number in the page URL, e.g. .../pages/27230209.`);
  }

  const creds = await loadCredentials();

  const results = [];
  for (const f of files) {
    // Sequential on purpose: Confluence versions attachments, and parallel
    // updates to the same page race into version conflicts.
    results.push(await uploadOne(creds, pageId, f));
  }

  if (json) {
    console.log(JSON.stringify({ pageId, results }, null, 2));
    return;
  }

  console.log(`✓ ${results.length} attachment(s) on page ${pageId}\n`);
  for (const r of results) {
    console.log(`  ${r.action.padEnd(7)} ${r.filename}  (${r.id})`);
  }
  const images = results.filter((r) => /\.(png|jpe?g|svg)$/i.test(r.filename));
  if (images.length) {
    console.log(`\nEmbed each image in the page body with:\n`);
    for (const r of images) {
      console.log(`  <ac:image ac:align="center"><ri:attachment ri:filename="${r.filename}" /></ac:image>`);
    }
  }
}

main().catch((e) => fail(e?.stack || String(e)));
