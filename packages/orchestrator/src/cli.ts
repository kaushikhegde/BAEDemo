#!/usr/bin/env node
// The operator's command line for @scyne/orchestrator. A plain process.argv
// parser — no dependency pulled in just to read flags.

import { join, resolve } from "node:path";
import { readFile, readdir, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import express from "express";
import { createOrchestrator, createRouter, type OrchestratorConfig, type Orchestrator } from "./index.js";
import { filterRunLog, type TranscriptEvent } from "./core/transcript.js";
import type { GateRow, RunRow } from "./core/repo.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `status`/`runs`/`gate list --issue` accept either the raw uuid `repo`
 * works with internally, or the human-facing identifier (`SCY-7`) every
 * other verb prints — an operator only ever SEES the identifier, so
 * requiring the uuid verbatim would make the CLI's own output unusable as
 * input to its next command.
 */
async function resolveIssueId(orch: Orchestrator, given: string): Promise<string> {
  if (UUID_RE.test(given)) return given;
  const issues = await orch.repo.listIssues(orch.homeCompanyId);
  const match = issues.find(i => i.identifier === given);
  if (!match) throw new Error(`issue '${given}' not found (tried as both a uuid and an identifier like 'SCY-7')`);
  return match.id;
}

const [verb, ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}

/**
 * Reads a required positional argument. Rejects `undefined` AND a token that
 * merely LOOKS like the next flag (`--config`) — without this a missing
 * positional (`status --config foo.ts`) would silently resolve "--config"
 * itself as the issueId and fail with a confusing "not found" instead of a
 * clear "status requires an issueId".
 */
function requirePositional(value: string | undefined, message: string): string {
  if (!value || value.startsWith("--")) throw new Error(message);
  return value;
}

async function loadConfig(): Promise<OrchestratorConfig> {
  const path = resolve(process.cwd(), flag("config") ?? "orchestrator.config.ts");
  const mod = (await import(pathToFileURL(path).href)) as { default?: OrchestratorConfig };
  if (!mod.default) {
    throw new Error(`config file '${path}' has no default export (expected the result of defineOrchestrator(...))`);
  }
  return mod.default;
}

const usage = `
scyne-orchestrator <verb>

  seed                                 reconcile the database to orchestrator.config.ts
  reset [--hard] [--all] [--yes]       clear issues/runs/gates/budgets, keep the org. Prints a plan
                                        unless --yes. --hard also drops agents and the overrides
                                        overlay, so the next boot rebuilds the org from the config file.
                                        --all additionally removes users, projects, documents,
                                        installations and chats — a factory reset, after which the
                                        installation must be claimed again with \`scyne init\`
  run <workflow> --project P [--feature F]
                                        start a workflow and advance it as far as it will go
  status <issueId>                     issue, step index, comments, work products, gates
  gate list [--issue ID]               pending gates (all issues, or one)
  gate approve <gateId> [--note "…"]   approve a gate and resume the workflow
  gate reject  <gateId> [--note "…"]   reject a gate and rewind to the generating step
  runs <issueId>                       one line per run: agent, phase, status, duration, tokens, cost
  log <runId> [--raw]                  a run's transcript — filtered by default, --raw prints the file verbatim
  serve [--port 3100]                  mount the HTTP router and listen (GET /health, /docs, /openapi.json, ...)

  --config <path>                      path to the config file (default: ./orchestrator.config.ts)
`;

function fmtDuration(ms: string | number | null): string {
  if (ms === null) return "-";
  const n = Number(ms);
  return Number.isFinite(n) ? `${(n / 1000).toFixed(1)}s` : "-";
}

function fmtTokens(input: string | number | null, output: string | number | null): string {
  if (input === null && output === null) return "-";
  const i = input === null ? 0 : Number(input);
  const o = output === null ? 0 : Number(output);
  return `${i}+${o}`;
}

function fmtCost(costUsd: string | number | null): string {
  if (costUsd === null) return "-";
  const n = Number(costUsd);
  return Number.isFinite(n) ? `$${n.toFixed(4)}` : "-";
}

function fmtRun(r: RunRow, agentLabel: string): string {
  return [
    r.id,
    agentLabel.padEnd(16),
    (r.phase ?? "-").padEnd(10),
    r.status.padEnd(11),
    fmtDuration(r.duration_ms).padEnd(8),
    fmtTokens(r.input_tokens, r.output_tokens).padEnd(10),
    fmtCost(r.cost_usd),
  ].join(" ");
}

function fmtEvent(e: TranscriptEvent): string {
  switch (e.kind) {
    case "assistant":   return `[${e.ts}] assistant    ${e.text}`;
    case "tool_use":     return `[${e.ts}] tool_use     ${e.tool}: ${e.preview}`;
    case "tool_result":  return `[${e.ts}] tool_result  ${e.preview}`;
    case "skill":         return `[${e.ts}] skill        ${e.name}`;
    case "framing":       return `[${e.ts}] framing      ${e.text}`;
  }
}

/**
 * `run <workflow> [--key value ...]` — every `--key value` pair after the
 * workflow name (besides the global `--config`) becomes a workflow param,
 * so `--project` / `--feature` fall out of the same generic parsing rather
 * than being special-cased.
 */
function parseRunParams(args: string[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    const tok = args[i];
    if (!tok?.startsWith("--")) continue;
    const key = tok.slice(2);
    const value = args[i + 1];
    if (key === "config" || value === undefined) { i++; continue; }
    params[key] = value;
    i++;
  }
  return params;
}

async function main(): Promise<void> {
  if (!verb || verb === "help") {
    console.log(usage);
    return;
  }

  // `serve` handles its own orchestrator lifecycle rather than falling
  // through to the generic `createOrchestrator()` + `finally { close() }`
  // path below: the db connection has to stay open for the life of the HTTP
  // process, not just for the duration of one command, so it is closed from
  // a signal handler instead.
  if (verb === "serve") {
    const orch = await createOrchestrator(await loadConfig());
    const app = express();
    app.use(express.json());
    // Standalone: the console is the product's face, so `/` goes there. When the
    // router is embedded in a consumer's app, `/` stays the consumer's.
    app.get("/", (_req, res) => { res.redirect("/orch"); });
    app.use(createRouter(orch));

    const port = Number(flag("port") ?? 3100);
    await new Promise<void>((res) => { app.listen(port, "127.0.0.1", () => res()); });

    console.log(`▶ scyne-orchestrator listening on http://127.0.0.1:${port}`);
    console.log(`  GET  /health        liveness + db check`);
    console.log(`  GET  /openapi.json  this contract, as JSON`);
    console.log(`  GET  /docs          self-contained API reference`);
    console.log(`  GET  /orch          the operator console`);

    const shutdown = (): void => {
      void orch.close().finally(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;   // the listening server keeps the process alive from here
  }

  // PGlite allows exactly one writer. When `npm run dev` (or `orch serve`) holds
  // `.orchestrator/pgdata`, every CLI verb fails on the lock — a raw lock error
  // reads like corruption, so name the cause and the way round it.
  let orch: Orchestrator;
  try {
    orch = await createOrchestrator(await loadConfig());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/lock|LOCK|EAGAIN|already in use|resource busy/i.test(msg)) {
      throw new Error(
        `the database is held by another process — PGlite allows one writer.\n` +
        `  If \`npm run dev\` or \`orch serve\` is running, use the HTTP API instead:\n` +
        `    curl -s http://127.0.0.1:3100/issues | head\n` +
        `  Otherwise stop that process and retry.\n\n  (${msg})`);
    }
    throw err;
  }

  try {
    switch (verb) {
      case "seed": {
        const agents = await orch.repo.listAgents(orch.homeCompanyId);
        console.log(`✓ ${agents.length} agent(s) reconciled for company ${orch.homeCompanyId}`);
        break;
      }

      /**
       * Clear the operational history and leave a freshly reconciled org.
       *
       * Deleting `.orchestrator/pgdata` by hand does the same job, but it also
       * discards the migration state and cannot be done while a server holds
       * the directory — and if the path is ever mistyped it takes something
       * else with it. This does it in SQL, reports what it removed, and
       * refuses to run without `--yes`.
       *
       * SKILLS ARE NOT TOUCHED, because they are not in the database: they are
       * files under `skillsDir`, and the agent-to-skill mapping is derived from
       * the workflows at read time. Nothing to reseed.
       */
      case "reset": {
        // Three depths, each a superset of the last:
        //   (bare)    the work — issues, runs, gates, comments, budgets
        //   --hard    + the org chart and console overrides
        //   --all     + identity and content: users, projects, documents,
        //             installations, chats. A genuine factory reset, and the
        //             only one that lets the installation be claimed again.
        const all = rest.includes("--all");
        const hard = rest.includes("--hard") || all;
        const confirmed = rest.includes("--yes");

        const agents = await orch.repo.listAgents(orch.homeCompanyId);
        const issues = await orch.repo.listIssues(orch.homeCompanyId);
        const logDir = join(orch.config.workspace, ".orchestrator", "runs");
        let logs: string[] = [];
        try { logs = (await readdir(logDir)).filter(f => f.endsWith(".jsonl")); } catch { logs = []; }

        if (!confirmed) {
          // Destructive by request only: the bare verb is a dry run, so a
          // half-remembered command cannot cost anyone their history.
          console.log(`Would delete, for company ${orch.homeCompanyId}:`);
          console.log(`  ${issues.length} issue(s) and every comment, work product, gate and run under them`);
          console.log(`  every budget`);
          console.log(`  ${logs.length} raw run log(s) in .orchestrator/runs/`);
          console.log(hard
            ? `  ${agents.length} agent(s) AND .orchestrator/overrides.json — the next boot rebuilds\n` +
              `    the org from orchestrator.config.ts, discarding console edits`
            : `  keeping ${agents.length} agent(s) and .orchestrator/overrides.json`);

          if (hard) {
            // Named in the plan because it touches data outside the company
            // being reset. The agents are re-seeded with new ids, so the
            // pointer is dangling either way — but a person should be told.
            const { rows } = await orch.db.query<{ n: string }>(
              `select count(*)::text n from issues
                where company_id <> $1
                  and assignee_agent_id in (select id from agents where company_id=$1)`,
              [orch.homeCompanyId]);
            const n = Number(rows[0]?.n ?? 0);
            if (n) {
              console.log(`  ${n} issue(s) in OTHER organisations lose their agent pointer\n` +
                          `    (kept, not deleted — the org chart is rebuilt with new ids)`);
            }
          }

          if (all) {
            const n = async (sql: string): Promise<string> =>
              (await orch.db.query<{ n: string }>(sql, [orch.homeCompanyId])).rows[0]?.n ?? "0";
            console.log(
              `  ${await n(`select count(*)::text n from users where company_id=$1`)} user(s), ` +
              `every API token and session`);
            console.log(
              `  ${await n(`select count(*)::text n from projects where company_id=$1`)} project(s) ` +
              `with their features, members and audit trail`);
            console.log(
              `  ${await n(`select count(*)::text n from documents d join projects p on p.id=d.project_id where p.company_id=$1`)} ` +
              `stored document(s) — the DATABASE copy; files under projects/ on disk are untouched`);
            console.log(
              `  ${await n(`select count(*)::text n from installations where company_id=$1`)} plugin installation(s), ` +
              `and every saved chat`);
            console.log(`\n  After this the installation is UNCLAIMED — run \`scyne init\` to set it up again.`);

            // Scoped to ONE company, which is easy to miss when the message
            // above says "the installation". Another organisation's projects
            // and people survive a `--all`, so anyone expecting a blank
            // database needs to be told what will still be in it.
            const { rows: others } = await orch.db.query<{ name: string; slug: string }>(
              `select name, slug from companies where id <> $1 order by name`, [orch.homeCompanyId]);
            if (others.length) {
              console.log(`\n  NOT touched — this resets one organisation, not the database:`);
              for (const o of others) console.log(`    ${o.name} (${o.slug})`);
              console.log(`    Remove those with \`scyne org archive <slug>\`, or delete`);
              console.log(`    .orchestrator/pgdata for a genuinely empty database.`);
            }
          } else {
            console.log(`  keeping every user, project and stored document (add --all to remove those too)`);
          }
          console.log(`\nNothing has been deleted. Re-run with --yes to do it.`);
          console.log(`Skills are files, not rows — ${"reset"} never touches them.`);
          break;
        }

        const summary = await orch.repo.resetCompany(orch.homeCompanyId, { agents: hard, platform: all });

        // The logs are referenced by run rows that no longer exist; leaving
        // them behind is orphaned disk that no console view can reach.
        for (const f of logs) await rm(join(logDir, f), { force: true });

        if (hard) {
          await rm(join(orch.config.workspace, ".orchestrator", "overrides.json"), { force: true });
          // Put the org back immediately rather than waiting for the next boot,
          // so `reset --hard` leaves a usable orchestrator rather than an empty
          // one that only works after a restart.
          for (const spec of orch.config.org) await orch.repo.upsertAgent(orch.homeCompanyId, spec);
        }

        const now = await orch.repo.listAgents(orch.homeCompanyId);
        console.log(`✓ deleted ${summary.issues} issue(s), ${summary.runs} run(s), ` +
                    `${summary.budgets} budget(s), ${logs.length} log file(s)`);
        if (hard) console.log(`✓ dropped the overrides overlay and rebuilt the org from the config file`);
        if (summary.detachedIssues) {
          console.log(`✓ detached ${summary.detachedIssues} issue(s) in other organisations from the old agent rows`);
        }
        console.log(`✓ ${now.length} agent(s) present`);
        console.log(`  Skills are untouched — they are files under ` +
                    `${orch.config.skillsDir ?? "(no skillsDir configured)"}, not rows.`);
        break;
      }

      case "run": {
        const workflow = requirePositional(rest[0], "run requires a workflow name — try 'run requirements --project P'");
        const params = parseRunParams(rest);

        const issue = await orch.engine.start(workflow, params);
        console.log(`▶ ${issue.identifier}  ${issue.title}`);
        console.log(`  id: ${issue.id}`);
        await orch.engine.advance(issue.id);

        const after = await orch.repo.getIssue(issue.id);
        if (!after) throw new Error(`issue ${issue.id} vanished after advance()`);
        console.log(`● ${after.status}  (step ${after.step_index})`);

        if (after.status === "in_review") {
          const gate = (await orch.repo.listGates(issue.id)).find(g => g.status === "pending");
          if (gate) {
            console.log(`\n⏸  Awaiting approval — gate ${gate.id}`);
            console.log(`   ${gate.payload.title}`);
            console.log(`\n   scyne-orchestrator gate approve ${gate.id}`);
          }
        } else if (after.status === "blocked") {
          const comments = await orch.repo.listComments(issue.id);
          const last = comments[comments.length - 1];
          console.log(`\n✗ blocked${last ? `: ${last.body}` : ""}`);
        }
        break;
      }

      case "status": {
        const given = requirePositional(rest[0], "status requires an issueId");
        const issueId = await resolveIssueId(orch, given);
        const issue = await orch.repo.getIssue(issueId);
        if (!issue) throw new Error(`issue '${issueId}' not found`);

        console.log(`${issue.identifier}  ${issue.title}`);
        console.log(`status: ${issue.status}   step: ${issue.step_index}   workflow: ${issue.workflow_key ?? "-"}`);
        if (Object.keys(issue.params).length) console.log(`params: ${JSON.stringify(issue.params)}`);

        const comments = await orch.repo.listComments(issueId);
        console.log(`\nComments (${comments.length}):`);
        for (const c of comments) {
          console.log(`  [${c.created_at}] ${c.author_user ?? c.author_agent_id ?? "?"}: ${c.body}`);
        }

        const products = await orch.repo.listWorkProducts(issueId);
        console.log(`\nWork products (${products.length}):`);
        for (const p of products) console.log(`  - ${p.title}  ${p.url}`);

        const gates = await orch.repo.listGates(issueId);
        console.log(`\nGates (${gates.length}):`);
        for (const g of gates) console.log(`  - ${g.id}  ${g.status}  ${g.payload.title}`);
        break;
      }

      case "gate": {
        const sub = rest[0];
        if (sub === "list") {
          const issueArg = flag("issue");
          const rows: Array<{ gate: GateRow; issueLabel: string }> = [];
          if (issueArg) {
            const issueId = await resolveIssueId(orch, issueArg);
            const issue = await orch.repo.getIssue(issueId);
            if (!issue) throw new Error(`issue '${issueId}' not found`);
            for (const g of await orch.repo.listGates(issueId)) {
              if (g.status === "pending") rows.push({ gate: g, issueLabel: issue.identifier });
            }
          } else {
            for (const iss of await orch.repo.listIssues(orch.homeCompanyId)) {
              for (const g of await orch.repo.listGates(iss.id)) {
                if (g.status === "pending") rows.push({ gate: g, issueLabel: iss.identifier });
              }
            }
          }
          if (!rows.length) { console.log("No pending gates."); break; }
          for (const { gate, issueLabel } of rows) {
            console.log(`${gate.id}  ${issueLabel}  ${gate.payload.title}`);
          }
        } else if (sub === "approve" || sub === "reject") {
          const gateId = requirePositional(rest[1], `gate ${sub} requires a gateId`);
          const note = flag("note");
          const by = process.env.USER ?? "cli";
          const decision = sub === "approve" ? "approved" : "rejected";
          await orch.engine.decideGate(gateId, decision, note, by);
          const gate = await orch.repo.getGate(gateId);
          const issue = gate ? await orch.repo.getIssue(gate.issue_id) : null;
          console.log(`✓ gate ${gateId} ${decision}${issue ? ` — issue now ${issue.status}` : ""}`);
        } else {
          throw new Error(`unknown gate subcommand '${sub ?? ""}' — use 'list', 'approve', or 'reject'`);
        }
        break;
      }

      case "runs": {
        const given = requirePositional(rest[0], "runs requires an issueId");
        const issueId = await resolveIssueId(orch, given);
        const issue = await orch.repo.getIssue(issueId);
        if (!issue) throw new Error(`issue '${issueId}' not found`);

        const [runs, agents] = await Promise.all([
          orch.repo.listRuns(issueId),
          orch.repo.listAgents(issue.company_id),
        ]);
        if (!runs.length) { console.log("No runs yet."); break; }

        const agentLabel = new Map(agents.map(a => [a.id, a.key]));
        for (const r of runs) {
          console.log(fmtRun(r, r.agent_id ? (agentLabel.get(r.agent_id) ?? r.agent_id) : "-"));
        }
        break;
      }

      case "log": {
        const runId = requirePositional(rest[0], "log requires a runId");
        const run = await orch.repo.getRun(runId);
        if (!run) throw new Error(`run '${runId}' not found`);

        let raw: string;
        try {
          raw = await readFile(run.log_path, "utf8");
        } catch (err) {
          throw new Error(`could not read log at '${run.log_path}': ${err instanceof Error ? err.message : String(err)}`);
        }

        if (rest.includes("--raw")) {
          process.stdout.write(raw);
        } else {
          const { events } = filterRunLog(raw, run.adapter);
          for (const e of events) console.log(fmtEvent(e));
        }
        break;
      }

      default:
        throw new Error(`unknown verb '${verb}' — run 'scyne-orchestrator help' for usage`);
    }
  } finally {
    await orch.close();
  }
}

main().catch((err: unknown) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
