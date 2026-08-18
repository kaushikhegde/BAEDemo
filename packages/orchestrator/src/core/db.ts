import { readdir, readFile } from "node:fs/promises";
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface Db {
  /**
   * Run one or more SQL statements.
   *
   * Whether `params` is supplied changes the protocol used underneath, which
   * in turn changes whether multiple `;`-separated statements are allowed:
   * omit `params` to run a whole file (e.g. a migration) as one batch; pass
   * `params` to bind values, which restricts `sql` to a single statement.
   */
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

export interface DbOptions {
  driver: "pglite" | "native" | "external";
  dir?: string;   // pglite | native
  url?: string;   // external
}

/**
 * Take an exclusive lock on a PGlite data directory, or explain who holds it.
 *
 * PGlite does NOT lock the directory itself — this was measured, not assumed.
 * Two processes open the same `dir` happily, each gets its own in-memory view,
 * and they diverge silently: writer B can delete every row while writer A goes
 * on reporting the old ones, and whichever flushes last wins. There is no
 * error, no warning, and nothing in the data afterwards records that it
 * happened.
 *
 * So the lock is ours. A sidecar file beside the data directory holds the
 * owning pid; a lock whose pid is no longer alive is stale (a crash, a SIGKILL)
 * and is taken over rather than blocking a restart forever.
 *
 * `signal 0` is the standard liveness probe: it performs the permission and
 * existence checks without delivering anything. EPERM means the process exists
 * but belongs to another user — still alive, so still the owner.
 */
function lockPath(dir: string): string {
  return dir.replace(/[/\\]+$/, "") + ".lock";
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Directories this process currently holds. The pid check below cannot catch a
 * second open from the SAME process — `held.pid === process.pid` looks like our
 * own lock — and two PGlite instances in one process diverge exactly as two
 * processes do.
 */
const held = new Map<string, () => void>();

/**
 * ONE exit handler for every lock this process takes, registered lazily.
 *
 * A `process.once("exit", …)` per open leaks a listener per database — the test
 * suite opens dozens and Node starts warning about an EventEmitter leak at
 * eleven. Releasing from a single handler keeps the count at one however many
 * are open.
 */
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => { for (const release of [...held.values()]) release(); });
}

function acquireLock(dir: string): () => void {
  const file = lockPath(dir);
  const key = resolve(dir);
  if (held.has(key)) {
    throw new Error(
      `the database at ${dir} is already open in this process.\n` +
      `  PGlite gives each instance its own view of the data; two of them diverge\n` +
      `  silently and the last to flush wins. Close the first before opening another.`);
  }
  try {
    const owner = JSON.parse(readFileSync(file, "utf8")) as { pid?: number; since?: string };
    if (typeof owner.pid === "number" && owner.pid !== process.pid && pidAlive(owner.pid)) {
      throw new Error(
        `the database at ${dir} is already open in process ${owner.pid}` +
        (owner.since ? ` (since ${owner.since})` : "") + `.\n` +
        `  PGlite does not detect this itself: a second writer gets its own view of the\n` +
        `  data, the two diverge silently, and the last one to flush wins.\n` +
        `  Stop that process, or use its HTTP API instead.`);
    }
  } catch (err) {
    // A missing or unreadable lock file is not an error — it is the normal
    // case, and a corrupt one must not wedge the database shut. Only OUR
    // "already open" error is rethrown.
    if (err instanceof Error && err.message.includes("already open in process")) throw err;
  }

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }), "utf8");
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    held.delete(key);
    // Only ever remove OUR lock: a takeover of a stale file could otherwise
    // delete the lock a newer, legitimate owner has since written.
    try {
      const now = JSON.parse(readFileSync(file, "utf8")) as { pid?: number };
      if (now.pid === process.pid) rmSync(file, { force: true });
    } catch { /* already gone */ }
  };

  held.set(key, release);
  // A crash or a Ctrl-C must not leave a lock that blocks the next start.
  installExitHook();
  return release;
}

export async function openDb(opts: DbOptions): Promise<Db> {
  if (opts.driver === "pglite") {
    const { PGlite } = await import("@electric-sql/pglite");
    const release = acquireLock(opts.dir ?? ".");
    let pg;
    try {
      pg = new PGlite(opts.dir);
    } catch (err) {
      release();
      throw err;
    }
    return {
      async query(sql, params) {
        // PGlite's `query()` uses the Extended Query protocol and only accepts
        // a single statement. Migration files are multiple `create table …;`
        // statements in one string, so unparameterised calls go through
        // `exec()` (Simple Query protocol, multi-statement) instead — the last
        // statement's rows are what a caller reading back a result wants.
        // Parameterised calls always go through `query()`, which is the only
        // one of the two that accepts bind parameters.
        if (params === undefined) {
          const results = await pg.exec(sql);
          const last = results[results.length - 1];
          return { rows: (last?.rows ?? []) as any[] };
        }
        const r = await pg.query(sql, params as any[]);
        return { rows: (r.rows ?? []) as any[] };
      },
      async close() { await pg.close(); release(); },
    };
  }
  if (opts.driver === "external") {
    if (!opts.url) throw new Error("driver 'external' requires a url");
    const { default: pgLib } = await import("pg");
    const client = new pgLib.Client({ connectionString: opts.url });
    await client.connect();
    return {
      async query(sql, params) {
        const r = await client.query(sql, params as any[]);
        return { rows: r.rows };
      },
      async close() { await client.end(); },
    };
  }
  throw new Error(`driver '${opts.driver}' is not implemented in the prototype`);
}

export async function migrate(db: Db, dir: string): Promise<{ applied: string[] }> {
  await db.query(
    `create table if not exists _migrations (
       name text primary key,
       applied_at timestamptz not null default now())`
  );
  const { rows } = await db.query<{ name: string }>(`select name from _migrations`);
  const done = new Set(rows.map(r => r.name));
  const files = (await readdir(dir)).filter(f => f.endsWith(".sql")).sort();

  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(join(dir, f), "utf8");
    await db.query(sql);
    await db.query(`insert into _migrations (name) values ($1)`, [f]);
    applied.push(f);
  }
  return { applied };
}
