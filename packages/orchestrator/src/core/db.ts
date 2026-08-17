import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

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

export async function openDb(opts: DbOptions): Promise<Db> {
  if (opts.driver === "pglite") {
    const { PGlite } = await import("@electric-sql/pglite");
    const pg = new PGlite(opts.dir);
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
      async close() { await pg.close(); },
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
