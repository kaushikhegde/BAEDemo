#!/usr/bin/env node
/**
 * Move every blob out of `blobs.content` and into Azure.
 *
 *   npm run migrate:blobs              # a PLAN — reads, writes nothing
 *   npm run migrate:blobs -- --apply   # do it
 *
 * Run through `tsx`, not bare `node`: it imports the orchestrator's own store
 * and the Azure backend, both TypeScript. The other scripts here are
 * dependency-free because they go over HTTP; this one cannot, because it
 * rewrites a column no route exposes.
 *
 * Keyed off the locator prefix 010 introduced: a row reading `pg:<sha>` still
 * has its bytes in the column, and one reading `azure:…` has been moved. So
 * this is idempotent and resumable — a run killed halfway leaves every row it
 * finished already correct, and re-running picks up only what is left.
 *
 * Content-addressed, so an upload is verified by reading the blob back and
 * comparing its hash to the row's own `sha256`. `content` is NOT cleared here:
 * dropping the column is migration 011, run once a full pass has verified, so
 * that a failed migration is recoverable from the database it started in.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../packages/orchestrator/src/core/db.js";
import { azureBlobBackend } from "../storage/azure-blobs.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");

try {
  const env = await readFile(path.join(ROOT, ".env"), "utf8");
  for (const line of env.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch { /* exported vars are fine */ }

const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
if (!conn) {
  console.error("AZURE_STORAGE_CONNECTION_STRING is not set — there is nothing to migrate into.");
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. This reads the database the orchestrator uses.");
  process.exit(2);
}

const db = await openDb({ driver: "external", url: process.env.DATABASE_URL });
const backend = azureBlobBackend({
  connectionString: conn,
  container: process.env.AZURE_DOCUMENTS_CONTAINER ?? "documents",
});

const { rows } = await db.query(
  `select sha256, bytes, content_type from blobs
    where blob_path is null or blob_path like 'pg:%' order by bytes asc`);

if (!rows.length) {
  console.log("Nothing to migrate — every blob already has an object-store locator.");
  await db.close();
  process.exit(0);
}

const total = rows.reduce((n, r) => n + Number(r.bytes), 0);
console.log(`${rows.length} blob(s), ${(total / 1024 / 1024).toFixed(1)} MB, still in Postgres.`);
if (!APPLY) {
  console.log(`\nRe-run with --apply to move them.`);
  await db.close();
  process.exit(0);
}

let moved = 0;
const failed = [];
for (const r of rows) {
  try {
    const got = await db.query(`select content from blobs where sha256 = $1`, [r.sha256]);
    const raw = got.rows[0]?.content;
    if (raw == null) { failed.push(`${r.sha256}: no bytes in the column to move`); continue; }
    const content = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);

    // The row claims a hash. If the bytes in the column do not match it, the
    // row is already corrupt and moving it would carry that corruption forward
    // under a name asserting it is fine.
    const actual = createHash("sha256").update(content).digest("hex");
    if (actual !== r.sha256) {
      failed.push(`${r.sha256}: column holds bytes hashing to ${actual}`);
      continue;
    }

    const locator = await backend.write(r.sha256, content, r.content_type ?? null);

    // Verified by reading back, because a locator recorded for a blob that is
    // not there is exactly the state that reads as an absent document later.
    const back = await backend.read(locator);
    if (!back || createHash("sha256").update(back).digest("hex") !== r.sha256) {
      failed.push(`${r.sha256}: wrote to ${locator} but it did not read back`);
      continue;
    }

    await db.query(`update blobs set blob_path = $2 where sha256 = $1`, [r.sha256, locator]);
    moved++;
    if (moved % 25 === 0) console.log(`  ${moved}/${rows.length}`);
  } catch (e) {
    failed.push(`${r.sha256}: ${e.message}`);
  }
}

console.log(`\n${moved}/${rows.length} moved.`);
for (const f of failed) console.error(`  ✗ ${f}`);
await db.close();
process.exit(failed.length ? 1 : 0);
