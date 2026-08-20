import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDb, migrate, type Db } from "../src/core/db.js";

let dir: string;
let db: Db;

const MIGRATIONS = new URL("../migrations", import.meta.url).pathname;

/** company → user → project → feature, the chain everything else hangs off. */
async function seed(): Promise<{ company: string; user: string; project: string; feature: string }> {
  const company = randomUUID(), user = randomUUID(), project = randomUUID(), feature = randomUUID();
  await db.query(`insert into companies (id, name, slug) values ($1,'Scyne','scyne')`, [company]);
  await db.query(`insert into users (id, company_id, email) values ($1,$2,'a@b.co')`, [user, company]);
  await db.query(`insert into projects (id, company_id, name) values ($1,$2,'RTWSA')`, [project, company]);
  await db.query(`insert into features (id, project_id, name) values ($1,$2,'Appeals')`, [feature, project]);
  return { company, user, project, feature };
}

async function putBlob(sha: string, body = "x"): Promise<void> {
  await db.query(
    `insert into blobs (sha256, bytes, content, content_type) values ($1,$2,$3,'text/markdown')
     on conflict (sha256) do nothing`,
    [sha, body.length, Buffer.from(body)]);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-platform-"));
  db = await openDb({ driver: "pglite", dir });
  await migrate(db, MIGRATIONS);
});
afterEach(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("002_platform schema", () => {
  it("applies on top of 001 and is idempotent", async () => {
    const again = await migrate(db, MIGRATIONS);
    expect(again.applied).toEqual([]);

    const { rows } = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema='public'`);
    const names = rows.map(r => r.table_name);
    for (const t of ["users", "api_tokens", "sessions", "installations", "projects", "features",
                     "project_members", "blobs", "documents", "actions", "conversations",
                     "messages", "run_events"]) {
      expect(names).toContain(t);
    }
    // 001's tables must survive untouched.
    for (const t of ["companies", "agents", "issues", "runs", "gates"]) expect(names).toContain(t);
  });

  it("keeps 001 additive: issues gained its project, runs.log_path became optional", async () => {
    const { rows } = await db.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns
        where table_schema='public' and table_name in ('issues','runs')`);
    const byName = new Map(rows.map(r => [r.column_name, r.is_nullable]));
    expect(byName.has("project_id")).toBe(true);
    expect(byName.has("feature_id")).toBe(true);
    expect(byName.get("log_path")).toBe("YES");   // events live in run_events now
  });

  it("dedupes content by hash: one blob, many documents", async () => {
    const { project, feature } = await seed();
    await putBlob("sha-aaa", "the same bytes");

    await db.query(
      `insert into documents (id, project_id, feature_id, path, category, sha256)
       values ($1,$2,$3,'requirements/SOP/policy.md','sop','sha-aaa')`,
      [randomUUID(), project, feature]);
    await db.query(
      `insert into documents (id, project_id, feature_id, path, category, sha256)
       values ($1,$2,null,'documents/policy.md','sop','sha-aaa')`,
      [randomUUID(), project]);

    const blobs = await db.query<{ n: string }>(`select count(*)::text as n from blobs`);
    const docs = await db.query<{ n: string }>(`select count(*)::text as n from documents`);
    expect(blobs.rows[0].n).toBe("1");
    expect(docs.rows[0].n).toBe("2");
  });

  it("allows only one CURRENT version of a path, but any number of superseded ones", async () => {
    const { project, feature } = await seed();
    await putBlob("sha-v1"); await putBlob("sha-v2");
    const path = "outputs/product-summary.md";

    const insert = (sha: string, version: number, current: boolean) =>
      db.query(
        `insert into documents (id, project_id, feature_id, path, sha256, version, is_current)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), project, feature, path, sha, version, current]);

    await insert("sha-v1", 1, true);
    // A second CURRENT row for the same path is the bug the index exists to stop.
    await expect(insert("sha-v2", 2, true)).rejects.toThrow();

    // Supersede, then the new version is allowed.
    await db.query(`update documents set is_current = false where project_id=$1 and path=$2`, [project, path]);
    await insert("sha-v2", 2, true);

    const { rows } = await db.query<{ n: string }>(
      `select count(*)::text as n from documents where project_id=$1 and path=$2`, [project, path]);
    expect(rows[0].n).toBe("2");
  });

  it("scopes that uniqueness by level — a project doc and a feature doc may share a path", async () => {
    const { project, feature } = await seed();
    await putBlob("sha-x");
    const path = "documents/overview.md";
    await db.query(
      `insert into documents (id, project_id, feature_id, path, sha256) values ($1,$2,null,$3,'sha-x')`,
      [randomUUID(), project, path]);
    // Same path, feature level — a different document, and must be permitted.
    await db.query(
      `insert into documents (id, project_id, feature_id, path, sha256) values ($1,$2,$3,$4,'sha-x')`,
      [randomUUID(), project, feature, path]);
    const { rows } = await db.query<{ n: string }>(
      `select count(*)::text as n from documents where path=$1`, [path]);
    expect(rows[0].n).toBe("2");
  });

  it("refuses a duplicate project name, a duplicate feature within a project, and a duplicate email", async () => {
    const { company, project } = await seed();
    await expect(db.query(
      `insert into projects (id, company_id, name) values ($1,$2,'RTWSA')`, [randomUUID(), company])
    ).rejects.toThrow();
    await expect(db.query(
      `insert into features (id, project_id, name) values ($1,$2,'Appeals')`, [randomUUID(), project])
    ).rejects.toThrow();
    await expect(db.query(
      `insert into users (id, company_id, email) values ($1,$2,'a@b.co')`, [randomUUID(), company])
    ).rejects.toThrow();
  });

  it("stores a token by hash and prefix only — never the secret", async () => {
    const { user } = await seed();
    await db.query(
      `insert into api_tokens (id, user_id, name, prefix, token_hash)
       values ($1,$2,'laptop','scy_abcd','hash-1')`, [randomUUID(), user]);
    // A reused hash is a collision or a copy; either way it must not be stored twice.
    await expect(db.query(
      `insert into api_tokens (id, user_id, name, prefix, token_hash)
       values ($1,$2,'other','scy_efgh','hash-1')`, [randomUUID(), user])
    ).rejects.toThrow();

    const { rows } = await db.query<{ c: string }>(
      `select string_agg(column_name, ',' order by column_name) as c
         from information_schema.columns
        where table_schema='public' and table_name='api_tokens'`);
    expect(rows[0].c).not.toContain("token,");   // no plaintext column exists at all
  });

  it("cascades a deleted project through its features, documents and actions", async () => {
    const { company, project, feature } = await seed();
    await putBlob("sha-c");
    await db.query(
      `insert into documents (id, project_id, feature_id, path, sha256) values ($1,$2,$3,'a.md','sha-c')`,
      [randomUUID(), project, feature]);
    await db.query(
      `insert into actions (id, company_id, project_id, verb) values ($1,$2,$3,'project.create')`,
      [randomUUID(), company, project]);

    await db.query(`delete from projects where id=$1`, [project]);

    for (const t of ["features", "documents", "actions"]) {
      const { rows } = await db.query<{ n: string }>(`select count(*)::text as n from ${t}`);
      expect(rows[0].n).toBe("0");
    }
    // The blob survives: content is shared, so it is not any one project's to delete.
    const blobs = await db.query<{ n: string }>(`select count(*)::text as n from blobs`);
    expect(blobs.rows[0].n).toBe("1");
  });

  it("keeps run events ordered per run, and orders them independently of wall-clock", async () => {
    const { company, project } = await seed();
    const issue = randomUUID(), run = randomUUID();
    await db.query(
      `insert into issues (id, company_id, identifier, title, status, project_id)
       values ($1,$2,'SCY-1','t','todo',$3)`, [issue, company, project]);
    await db.query(
      `insert into runs (id, issue_id, status, log_path) values ($1,$2,'running',null)`, [run, issue]);

    for (const [seq, chunk] of [[2, "second"], [1, "first"], [3, "third"]] as const) {
      await db.query(
        `insert into run_events (run_id, seq, stream, chunk) values ($1,$2,'stdout',$3)`,
        [run, seq, chunk]);
    }
    await expect(db.query(
      `insert into run_events (run_id, seq, stream, chunk) values ($1,1,'stdout','dup')`, [run])
    ).rejects.toThrow();

    const { rows } = await db.query<{ chunk: string }>(
      `select chunk from run_events where run_id=$1 order by seq`, [run]);
    expect(rows.map(r => r.chunk)).toEqual(["first", "second", "third"]);
  });

  it("numbers chat messages per conversation, so two chats cannot collide", async () => {
    const { company, project, user } = await seed();
    const c1 = randomUUID(), c2 = randomUUID();
    for (const c of [c1, c2]) {
      await db.query(
        `insert into conversations (id, company_id, project_id, user_id) values ($1,$2,$3,$4)`,
        [c, company, project, user]);
      await db.query(
        `insert into messages (id, conversation_id, seq, role, content)
         values ($1,$2,1,'user','[{"type":"text","text":"hi"}]'::jsonb)`, [randomUUID(), c]);
    }
    await expect(db.query(
      `insert into messages (id, conversation_id, seq, role, content)
       values ($1,$2,1,'user','[]'::jsonb)`, [randomUUID(), c1])
    ).rejects.toThrow();

    const { rows } = await db.query<{ n: string }>(`select count(*)::text as n from messages`);
    expect(rows[0].n).toBe("2");
  });

  it("records an installation per machine, and refuses a second row for the same one", async () => {
    const { company, user } = await seed();
    await db.query(
      `insert into installations (id, company_id, user_id, machine_id, hostname, plugin_version)
       values ($1,$2,$3,'machine-1','alice-mbp','0.3.1')`, [randomUUID(), company, user]);
    await expect(db.query(
      `insert into installations (id, company_id, machine_id) values ($1,$2,'machine-1')`,
      [randomUUID(), company])
    ).rejects.toThrow();
  });
});

describe("005_tenancy schema", () => {
  const columns = async (table: string): Promise<Set<string>> => {
    const { rows } = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = $1`, [table]);
    return new Set(rows.map(r => r.column_name));
  };

  it("gives every organisation a slug, a status and an archive marker", async () => {
    const c = await columns("companies");
    expect(c.has("slug")).toBe(true);
    expect(c.has("status")).toBe(true);
    expect(c.has("archived_at")).toBe(true);
  });

  it("derives a slug for an organisation that predates the column", async () => {
    // seed() inserts (id, name) only — exactly as every row written before
    // this migration existed did. The backfill has to cope with those.
    await db.query(`insert into companies (id, name, slug) values ($1,'Scyne AI Lab','scyne-ai-lab')`,
      [randomUUID()]);
    const { rows } = await db.query<{ slug: string }>(
      `select slug from companies where name = 'Scyne AI Lab'`);
    expect(rows[0]?.slug).toBe("scyne-ai-lab");
  });

  it("refuses two organisations with the same slug", async () => {
    await db.query(`insert into companies (id, name, slug) values ($1,'Acme','acme')`, [randomUUID()]);
    await expect(
      db.query(`insert into companies (id, name, slug) values ($1,'Acme Two','acme')`, [randomUUID()]),
    ).rejects.toThrow();
  });

  it("refuses an organisation with no slug at all", async () => {
    await expect(
      db.query(`insert into companies (id, name) values ($1,'Sluggless')`, [randomUUID()]),
    ).rejects.toThrow();
  });

  it("records who started an issue, and tolerates not knowing", async () => {
    expect((await columns("issues")).has("created_by")).toBe(true);
    const { company } = await seed();
    const issue = randomUUID();
    await db.query(
      `insert into issues (id, company_id, identifier, title, status)
       values ($1,$2,'SCY-1','Untracked start','todo')`, [issue, company]);
    const { rows } = await db.query<{ created_by: string | null }>(
      `select created_by from issues where id=$1`, [issue]);
    expect(rows[0].created_by).toBeNull();
  });

  it("keeps an issue when the user who started it is deleted", async () => {
    const { company, user } = await seed();
    const issue = randomUUID();
    await db.query(
      `insert into issues (id, company_id, identifier, title, status, created_by)
       values ($1,$2,'SCY-2','Attributed','todo',$3)`, [issue, company, user]);
    await db.query(`delete from users where id=$1`, [user]);
    const { rows } = await db.query<{ created_by: string | null }>(
      `select created_by from issues where id=$1`, [issue]);
    // set null, not cascade: deleting a person must not delete their work.
    expect(rows).toHaveLength(1);
    expect(rows[0].created_by).toBeNull();
  });
});

describe("006_issue_control schema", () => {
  // A distinct identifier per insert: (company_id, identifier) is unique, and
  // three issues sharing one would fail on THAT constraint rather than on the
  // control-request check this test is actually about.
  let issueSeq = 0;
  const newIssue = async (company: string, extra = "", params: unknown[] = []) => {
    const id = randomUUID();
    await db.query(
      `insert into issues (id, company_id, identifier, title, status${extra ? ", " + extra : ""})
       values ($1,$2,$3,'Controlled','in_progress'${params.map((_, i) => `,$${i + 4}`).join("")})`,
      [id, company, `SCY-C${++issueSeq}`, ...params]);
    return id;
  };

  it("carries a control request, who asked and when", async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'issues'`);
    const cols = new Set(rows.map(r => r.column_name));
    expect(cols.has("control_request")).toBe(true);
    expect(cols.has("control_requested_by")).toBe(true);
    expect(cols.has("control_requested_at")).toBe(true);
  });

  it("defaults to no request at all", async () => {
    const { company } = await seed();
    const id = await newIssue(company);
    const { rows } = await db.query<{ control_request: string | null }>(
      `select control_request from issues where id=$1`, [id]);
    expect(rows[0].control_request).toBeNull();
  });

  it("accepts the three verbs and refuses anything else", async () => {
    const { company } = await seed();
    for (const verb of ["pause", "pause_now", "cancel"]) {
      const id = await newIssue(company, "control_request", [verb]);
      const { rows } = await db.query<{ control_request: string }>(
        `select control_request from issues where id=$1`, [id]);
      expect(rows[0].control_request).toBe(verb);
    }
    // A typo in a route handler must fail at the database rather than sit in
    // the column forever as a request the engine will never recognise.
    await expect(newIssue(company, "control_request", ["halt"])).rejects.toThrow();
  });

  it("keeps the request when the person who made it is deleted", async () => {
    const { company, user } = await seed();
    const id = await newIssue(company, "control_request, control_requested_by", ["cancel", user]);
    await db.query(`delete from users where id=$1`, [user]);
    const { rows } = await db.query<{ control_request: string; control_requested_by: string | null }>(
      `select control_request, control_requested_by from issues where id=$1`, [id]);
    expect(rows[0].control_request).toBe("cancel");
    expect(rows[0].control_requested_by).toBeNull();
  });
});

describe("007_model_prices schema", () => {
  const cols = async (table: string) => {
    const { rows } = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = $1`, [table]);
    return new Set(rows.map(r => r.column_name));
  };

  it("carries a price table", async () => {
    const c = await cols("model_prices");
    for (const col of ["provider", "model", "input_per_mtok", "cached_input_per_mtok",
                       "output_per_mtok", "currency", "retires_on", "source_url", "fetched_at"]) {
      expect(c.has(col), col).toBe(true);
    }
  });

  it("records which model ran, and what it is estimated to have cost", async () => {
    const c = await cols("runs");
    expect(c.has("model")).toBe(true);
    expect(c.has("est_cost_usd")).toBe(true);
    expect(c.has("cost_source")).toBe(true);
  });

  it("seeds the models Codex actually offers today", async () => {
    const { rows } = await db.query<{ model: string; input_per_mtok: string; output_per_mtok: string }>(
      `select model, input_per_mtok, output_per_mtok from model_prices where model = 'gpt-5.6-terra'`);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].input_per_mtok)).toBe(2);
    expect(Number(rows[0].output_per_mtok)).toBe(12);
  });

  it("flags the models retiring from Codex on 31 August 2026", async () => {
    const { rows } = await db.query<{ model: string }>(
      `select model from model_prices where retires_on = date '2026-08-31' order by model`);
    expect(rows.map(r => r.model)).toEqual(["gpt-5.4", "gpt-5.4-mini"]);
  });

  it("seeds a model with no published price as UNPRICED rather than as free", async () => {
    const { rows } = await db.query<{ input_per_mtok: string | null }>(
      `select input_per_mtok from model_prices where model = 'gpt-5.3-codex-spark'`);
    expect(rows).toHaveLength(1);
    // null, not 0 — "$0.00" reads as a run that cost nothing.
    expect(rows[0].input_per_mtok).toBeNull();
  });

  it("refuses a negative rate", async () => {
    await expect(db.query(
      `insert into model_prices (provider, model, input_per_mtok) values ('openai','bad',-1)`,
    )).rejects.toThrow();
  });

  it("holds one row per provider and model", async () => {
    await expect(db.query(
      `insert into model_prices (provider, model, input_per_mtok) values ('openai','gpt-5',1)`,
    )).rejects.toThrow();
  });

  it("carries no cost_source for a run that predates the column", async () => {
    const { company } = await seed();
    const issue = randomUUID(), run = randomUUID();
    await db.query(
      `insert into issues (id, company_id, identifier, title, status) values ($1,$2,'SCY-P','x','todo')`,
      [issue, company]);
    await db.query(
      `insert into runs (id, issue_id, status, log_path) values ($1,$2,'succeeded','/tmp/x.jsonl')`,
      [run, issue]);
    const { rows } = await db.query<{ cost_source: string | null; model: string | null }>(
      `select cost_source, model from runs where id=$1`, [run]);
    expect(rows[0].cost_source).toBeNull();
    expect(rows[0].model).toBeNull();
  });
});
