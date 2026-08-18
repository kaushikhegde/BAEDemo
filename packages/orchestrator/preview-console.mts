// A throwaway second orchestrator on :3199 with its OWN pgdata, seeded with
// realistic rows, purely so the rewritten console can be exercised against a
// live API without touching the dev server's database (PGlite is single-writer).
import express from "express";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import base from "../../orchestrator.config.js";
import { createOrchestrator } from "./src/index.js";
import { createRouter } from "./src/http/router.js";

const dir = mkdtempSync(join(tmpdir(), "orch-preview-"));
const orch = await createOrchestrator({ ...base, db: { driver: "pglite", dir: join(dir, "pgdata") } });

const repo = orch.repo, companyId = orch.companyId;
const agent = async (k: string) => (await repo.getAgentByKey(companyId, k));

// --- seed: one issue at a gate, one blocked, one running, one done ----------
const ba = await agent("ba"), dm = await agent("dataModeler"), sa = await agent("solutionArchitect");

const gated = await repo.createIssue({ companyId, title: "Generate data model — RTWSA / Appeals",
  workflowKey: "datamodel", params: { project: "RTWSA", feature: "Appeals & Reviews" },
  assigneeAgentId: dm!.id, status: "in_review" });
await repo.updateIssue(gated.id, { stepIndex: 4 });
await repo.addComment(gated.id, "Staged 3 documents from `projects/RTWSA/Appeals & Reviews/`.", { user: "orchestrator" });
await repo.addComment(gated.id, "Wrote `outputs/salesforce-data-model.md` — 12 sections, 4 custom objects, 1 ERD.", { agentId: dm!.id });
await repo.attachWorkProduct(gated.id, { type: "document", provider: "local",
  title: "salesforce-data-model.md",
  url: "file:///Users/x/projects/RTWSA/Appeals/solutions/DataModel/outputs/salesforce-data-model.md" });
await repo.createGate(gated.id, { title: "Approve the Salesforce data model",
  summary: "4 custom objects, 31 fields, 1 Mermaid ERD.\nStandard-object-first: Case, Account and User reused.\nPublishes to Confluence space RTWSA on approval." });
const r1 = await repo.startRun({ issueId: gated.id, agentId: dm!.id, stepIndex: 1, phase: "generate",
  logPath: "/tmp/x.jsonl" });
await repo.finishRun(r1.id, { status: "succeeded", exitCode: 0, inputTokens: 148231, outputTokens: 21044,
  cacheReadTokens: 992104, cacheCreationTokens: 41221, costUsd: 3.1917, durationMs: 1_512_000, numTurns: 61 });

const blocked = await repo.createIssue({ companyId, title: "Generate requirements — RTWSA / Appeals",
  workflowKey: "requirements", params: { project: "RTWSA", feature: "Appeals & Reviews", confluenceSpace: "RTWSA" },
  assigneeAgentId: ba!.id, status: "blocked" });
await repo.updateIssue(blocked.id, { stepIndex: 2 });
await repo.addComment(blocked.id,
  "Agent `ba` failed (exit 1) — retrying once, because the run died after 2.4s having accounted for no tokens.\n\n```\nError: connect ETIMEDOUT 160.79.104.10:443\n```",
  { user: "orchestrator" });
await repo.addComment(blocked.id,
  "Agent `ba` failed (exit 1) after 2 attempts. Not retrying: it already had its one retry.\n\n```\nError: connect ETIMEDOUT 160.79.104.10:443\n```",
  { user: "orchestrator" });
const b1 = await repo.startRun({ issueId: blocked.id, agentId: ba!.id, stepIndex: 2, phase: "generate", logPath: "/tmp/b1.jsonl" });
await repo.finishRun(b1.id, { status: "failed", exitCode: 1, durationMs: 2400 });
const b2 = await repo.startRun({ issueId: blocked.id, agentId: ba!.id, stepIndex: 2, phase: "generate", logPath: "/tmp/b2.jsonl" });
await repo.finishRun(b2.id, { status: "failed", exitCode: 1, durationMs: 2100 });

const running = await repo.createIssue({ companyId, title: "Generate solution architecture — RTWSA / Appeals",
  workflowKey: "architecture", params: { project: "RTWSA", feature: "Appeals & Reviews" },
  assigneeAgentId: sa!.id, status: "in_progress" });
await repo.updateIssue(running.id, { stepIndex: 1 });
await repo.startRun({ issueId: running.id, agentId: sa!.id, stepIndex: 1, phase: "generate", logPath: "/tmp/r.jsonl" });

const done = await repo.createIssue({ companyId, title: "Project Baseline — RTWSA",
  workflowKey: "baseline", params: { project: "RTWSA" }, assigneeAgentId: (await agent("capArchitect"))!.id, status: "done" });
await repo.updateIssue(done.id, { stepIndex: 6 });

await repo.setBudget(companyId, "agent", "ba", { maxTokens: 2_000_000, maxCostUsd: 15, maxDurationMs: 45 * 60_000 });

const app = express();
app.use(express.json());
app.get("/", (_q, s) => s.redirect("/orch"));
app.use(createRouter(orch));
app.listen(3199, "127.0.0.1", () => console.log("preview on http://127.0.0.1:3199/orch  (pgdata " + dir + ")"));
