#!/usr/bin/env node
/**
 * Read-only browser for the orchestrator's PGlite database.
 *
 * PGlite is embedded Postgres compiled to WASM — there is no listening socket,
 * so `psql` cannot reach it and only ONE process may hold `.orchestrator/pgdata`
 * at a time. Two openers do not error: they diverge silently, and whichever
 * flushes last wins (see CLAUDE.md → Gotchas).
 *
 * So this script never opens the live directory while a server holds it. It
 * copies pgdata to a scratch directory and queries the COPY, which is a
 * filesystem snapshot: crash-consistent on open via WAL replay, and impossible
 * to corrupt the original with. When nothing holds the lock it opens the real
 * directory directly, still refusing anything that is not a read.
 *
 *   node scripts/db-query.mjs --tables
 *   node scripts/db-query.mjs --schema issues
 *   node scripts/db-query.mjs "select identifier, title, status from issues order by created_at desc limit 20"
 *   node scripts/db-query.mjs --json "select * from runs limit 5"
 */
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, "packages/orchestrator/package.json"));
const { PGlite } = require("@electric-sql/pglite");

const dataDir = join(root, ".orchestrator/pgdata");
const lockFile = join(root, ".orchestrator/pgdata.lock");

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const args = argv.filter(a => a !== "--json");

/** A lock whose pid is dead is stale — the same rule `openDb` applies. */
function lockHolder() {
  if (!existsSync(lockFile)) return null;
  try {
    const { pid, since } = JSON.parse(readFileSync(lockFile, "utf8"));
    process.kill(pid, 0);          // throws ESRCH if that process is gone
    return { pid, since };
  } catch { return null; }
}

/**
 * Anything that is not plainly a read is refused. This is a viewer: a typo in a
 * `delete` against a copy destroys nothing, but the same command typed while the
 * server happens to be down would hit the real database.
 */
const WRITE = /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|copy|vacuum|reindex|call|do)\b/i;

const QUERIES = {
  tables: `select table_name,
                  (select count(*) from information_schema.columns c
                    where c.table_name = t.table_name) as columns
             from information_schema.tables t
            where table_schema = 'public'
            order by table_name`,
  schema: name => [`select column_name, data_type, is_nullable, column_default
                      from information_schema.columns
                     where table_schema = 'public' and table_name = $1
                     order by ordinal_position`, [name]],
};

function resolveQuery() {
  if (args.includes("--tables")) return [QUERIES.tables, []];
  const i = args.indexOf("--schema");
  if (i !== -1) {
    const name = args[i + 1];
    if (!name) die("--schema needs a table name, e.g. --schema issues");
    return QUERIES.schema(name);
  }
  const sql = args.find(a => !a.startsWith("--"));
  if (!sql) die(usage());
  if (WRITE.test(sql)) die("refusing: this is a read-only viewer, and that statement writes.");
  return [sql, []];
}

function usage() {
  return [
    "usage:",
    "  node scripts/db-query.mjs --tables                 list every table",
    "  node scripts/db-query.mjs --schema <table>         its columns",
    "  node scripts/db-query.mjs \"select …\"               any read query",
    "  …with --json                                      raw JSON instead of a table",
  ].join("\n");
}

function die(msg) { console.error(msg); process.exit(1); }

/** Column-aligned output, with nulls and json rendered so they read as data. */
function render(rows) {
  if (!rows.length) return console.log("(0 rows)");
  const cols = Object.keys(rows[0]);
  const cell = v =>
    v === null || v === undefined ? "—"
    : v instanceof Date ? v.toISOString().replace("T", " ").slice(0, 19)
    : typeof v === "object" ? JSON.stringify(v)
    : String(v);
  const text = rows.map(r => cols.map(c => cell(r[c])));
  const width = cols.map((c, i) =>
    Math.min(60, Math.max(c.length, ...text.map(r => r[i].length))));
  const clip = (s, w) => (s.length > w ? s.slice(0, w - 1) + "…" : s.padEnd(w));
  console.log(cols.map((c, i) => clip(c, width[i])).join("  "));
  console.log(width.map(w => "─".repeat(w)).join("  "));
  for (const r of text) console.log(r.map((v, i) => clip(v, width[i])).join("  "));
  console.log(`\n(${rows.length} row${rows.length === 1 ? "" : "s"})`);
}

const [sql, params] = resolveQuery();

if (!existsSync(dataDir)) die(`no database at ${dataDir} — nothing has run yet.`);

const held = lockHolder();
let target = dataDir;
let scratch = null;

if (held) {
  scratch = mkdtempSync(join(tmpdir(), "scyne-db-"));
  target = join(scratch, "pgdata");
  cpSync(dataDir, target, { recursive: true });
  // The copy inherits a postmaster.pid naming a pid that is alive in THIS
  // machine's process table; PGlite would read it as its own directory being
  // in use. It is a snapshot, so the file is meaningless here.
  rmSync(join(target, "postmaster.pid"), { force: true });
  console.error(`# server pid ${held.pid} holds the database — querying a snapshot copy\n`);
}

const db = await PGlite.create({ dataDir: target });
try {
  const { rows } = await db.query(sql, params);
  if (asJson) console.log(JSON.stringify(rows, null, 2));
  else render(rows);
} finally {
  await db.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}
