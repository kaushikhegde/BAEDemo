#!/usr/bin/env node
/**
 * Copy every document's bytes out of S3 (LocalStack) or Azure into the local
 * folder store, so the install no longer needs Docker or a cloud account.
 *
 *   npm run migrate:blobs:local              # a PLAN — reads, writes nothing
 *   npm run migrate:blobs:local -- --apply   # do it
 *
 * Run through `tsx`, not bare `node`: it imports the storage backends, which
 * are TypeScript. The other scripts here go over HTTP; this one cannot, because
 * it rewrites `blobs.blob_path`, which no route exposes.
 *
 * Reads through the SAME backends the orchestrator uses, so the object store
 * must still be reachable (LocalStack running) while this runs. The server may
 * be running too when the database is Postgres; PGlite is single-writer, so on
 * PGlite stop the server first.
 *
 * Idempotent and resumable: a row already reading `local:` is skipped, and each
 * row is rewritten only after its bytes have been written AND read back with a
 * matching hash. The originals are left where they were.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../packages/orchestrator/src/core/db.js";
import { selectBlobBackend, localBlobDir } from "../storage/blobs.js";
import { localBlobBackend } from "../storage/local-blobs.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPLY = process.argv.slice(2).includes("--apply");

try {
  const env = await readFile(path.join(ROOT, ".env"), "utf8");
  for (const line of env.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch { /* exported vars are fine */ }

const env = { SCYNE_INSTALL_ROOT: ROOT, ...process.env };
const dir = localBlobDir(env);
const source = await selectBlobBackend(env);
const target = localBlobBackend({ dir });

const db = await openDb(process.env.DATABASE_URL
  ? { driver: "external", url: process.env.DATABASE_URL }
  : { driver: "pglite", dir: path.join(ROOT, ".orchestrator/pgdata") });

const { rows } = await db.query(
  `select sha256, bytes, content_type, blob_path from blobs
    where blob_path is not null and blob_path not like 'local:%' order by bytes asc`);

if (!rows.length) {
  console.log(`Nothing to copy — every document is already in ${dir}.`);
  await db.close();
  process.exit(0);
}

const total = rows.reduce((n, r) => n + Number(r.bytes), 0);
console.log(`${rows.length} document(s), ${(total / 1024 / 1024).toFixed(1)} MB, to copy into ${dir}.`);
if (!APPLY) {
  console.log(`\nRe-run with --apply to copy them.`);
  await db.close();
  process.exit(0);
}

const sha = (b) => createHash("sha256").update(b).digest("hex");
let moved = 0;
const failed = [];
for (const r of rows) {
  try {
    const content = await source.read(r.blob_path);
    if (!content) { failed.push(`${r.sha256}: nothing at ${r.blob_path} (is the store running?)`); continue; }
    if (sha(content) !== r.sha256) { failed.push(`${r.sha256}: ${r.blob_path} holds different bytes`); continue; }

    const locator = await target.write(r.sha256, content, r.content_type ?? null);
    const back = await target.read(locator);
    if (!back || sha(back) !== r.sha256) { failed.push(`${r.sha256}: wrote ${locator} but it did not read back`); continue; }

    await db.query(`update blobs set blob_path = $2 where sha256 = $1`, [r.sha256, locator]);
    moved++;
  } catch (e) {
    failed.push(`${r.sha256}: ${e.message}`);
  }
}

console.log(`\n${moved}/${rows.length} copied.`);
for (const f of failed) console.error(`  ✗ ${f}`);
await db.close();
process.exit(failed.length ? 1 : 0);
