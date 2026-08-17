#!/usr/bin/env node
// The operator's command line for @scyne/orchestrator. A plain process.argv
// parser — no dependency pulled in just to read flags.

import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
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
  const issues = await orch.repo.listIssues(orch.companyId);
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
    app.use(createRouter(orch));

    const port = Number(flag("port") ?? 3100);
    await new Promise<void>((res) => { app.listen(port, "127.0.0.1", () => res()); });

    console.log(`▶ scyne-orchestrator listening on http://127.0.0.1:${port}`);
    console.log(`  GET  /health        liveness + db check`);
    console.log(`  GET  /openapi.json  this contract, as JSON`);
    console.log(`  GET  /docs          self-contained API reference`);

    const shutdown = (): void => {
      void orch.close().finally(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;   // the listening server keeps the process alive from here
  }

  const orch = await createOrchestrator(await loadConfig());
  try {
    switch (verb) {
      case "seed": {
        const agents = await orch.repo.listAgents(orch.companyId);
        console.log(`✓ ${agents.length} agent(s) reconciled for company ${orch.companyId}`);
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
            for (const iss of await orch.repo.listIssues(orch.companyId)) {
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
          const { events } = filterRunLog(raw);
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
