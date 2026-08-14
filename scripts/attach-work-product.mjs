#!/usr/bin/env node
/**
 * Attach local files to a Paperclip issue as work-products.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every agent's Phase 1 ends with "attach the outputs as work-products", and
 * every agent then rediscovers the payload the hard way. The API rejects, in
 * this order: a missing `type` (enum: preview_url | runtime_service |
 * pull_request | branch | commit | artifact | document), a missing `provider`,
 * a missing `title`, and finally `url` with `invalid_string` because a relative
 * path is not a URL. That is four failed round-trips per agent, per run, for a
 * contract that never changes.
 *
 * The shape, confirmed against a real work-product on SCY-1:
 *
 *   { "type": "document", "provider": "local",
 *     "title": "capability-process.md",
 *     "url":   "file:///absolute/path/to/capability-process.md" }
 *
 * USAGE
 * -----
 *   node scripts/attach-work-product.mjs <issueId> <file> [<file> ...]
 *   node scripts/attach-work-product.mjs <issueId> <file> --title "Nice Name"
 *   node scripts/attach-work-product.mjs <issueId> <file> --json
 *
 * `--title` applies to the FIRST file only; the rest are titled by filename.
 * Idempotent: a file already attached to this issue at the same url is skipped,
 * so a re-run after a partial failure does not create duplicates.
 *
 * No auth — Paperclip is local_trusted. Do not add an Authorization header.
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const BASE = (process.env.PAPERCLIP_API_URL || "http://127.0.0.1:3100/api").replace(/\/$/, "");

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function existingUrls(issueId) {
  const r = await fetch(`${BASE}/issues/${encodeURIComponent(issueId)}/work-products`);
  if (!r.ok) return new Set(); // listing is best-effort; a failure just means no dedupe
  const data = await r.json().catch(() => null);
  const list = Array.isArray(data) ? data : data?.workProducts ?? [];
  return new Set(list.map((w) => w?.url).filter(Boolean));
}

async function attachOne(issueId, file, title, already) {
  const abs = path.resolve(file);
  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) fail(`Not a file: ${abs}`);
  } catch {
    fail(`File not found: ${abs}\n  Attach the artefact only after the skill has written it.`);
  }

  const url = pathToFileURL(abs).href;
  if (already.has(url)) return { title: title || path.basename(abs), url, action: "skipped" };

  const body = {
    type: "document",
    provider: "local",
    title: title || path.basename(abs),
    url,
  };

  const r = await fetch(`${BASE}/issues/${encodeURIComponent(issueId)}/work-products`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    fail(
      `Attach failed for ${body.title} (HTTP ${r.status}).\n  ${text.slice(0, 400)}\n` +
      `  Payload sent: ${JSON.stringify(body)}`
    );
  }
  let id = null;
  try { id = JSON.parse(text)?.id ?? null; } catch { /* empty body is fine */ }
  return { title: body.title, url, id, action: "attached" };
}

async function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const ti = argv.indexOf("--title");
  const title = ti >= 0 ? argv[ti + 1] : null;
  // Guard on `ti >= 0`: with no --title, ti is -1 and `i !== ti + 1` would drop
  // argv[0] — the issue id — leaving the script printing usage forever.
  const rest = argv.filter((a, i) => a !== "--json" && (ti < 0 || (i !== ti && i !== ti + 1)));
  const [issueId, ...files] = rest;

  if (!issueId || files.length === 0) {
    console.error("usage: node scripts/attach-work-product.mjs <issueId> <file> [<file> ...] [--title \"Name\"] [--json]");
    process.exit(2);
  }

  const already = await existingUrls(issueId);
  const results = [];
  for (const [i, f] of files.entries()) {
    results.push(await attachOne(issueId, f, i === 0 ? title : null, already));
  }

  if (json) { console.log(JSON.stringify({ issueId, results }, null, 2)); return; }
  console.log(`✓ ${results.filter((r) => r.action === "attached").length} attached, ` +
              `${results.filter((r) => r.action === "skipped").length} already present\n`);
  for (const r of results) console.log(`  ${r.action.padEnd(9)} ${r.title}`);
}

main().catch((e) => fail(e?.stack || String(e)));
