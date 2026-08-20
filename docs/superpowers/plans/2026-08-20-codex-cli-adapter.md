# Codex CLI Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register `codex` as an orchestrator adapter so any agent step can run on OpenAI's Codex CLI instead of Claude Code, selected per step, per agent, per project or globally.

**Architecture:** Codex is a whole agent like Claude Code, so it sits beside `createClaudeRunner`, not behind `createLoopRunner`. The child-process machinery currently baked into `runner.ts` is extracted to `core/spawn.ts` and shared; each runner becomes an argv builder plus a usage extractor over the top. Codex has no `--system-prompt-file`, so the agent bundle and the step's `SKILL.md` are prepended to the prompt on stdin using the framing `agent-loop.ts` already uses.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest 2.1, Node ≥ 22 (`node:child_process`), PGlite, `@openai/codex` ≥ 0.148.0 installed globally.

**Spec:** `docs/superpowers/specs/2026-08-20-codex-cli-adapter-design.md`

## Global Constraints

- **Commit inside this worktree, on branch `sdd/2026-08-20-codex-ado-admin`, and nowhere else.**
  The user commits their own work on their own branch — `feat-paperclip` is never
  touched. This branch exists so the review machinery (which is entirely
  `git diff BASE HEAD`) has something to read; the user chooses at the end what,
  if anything, is integrated.
- Nothing under `packages/orchestrator/` may import `scripts/pipeline.mjs`, `orchestrator.config.ts`, or anything under `projects/`. The library stays generic; consumer knowledge lives in `orchestrator.config.ts`.
- Australian English in all user-facing strings ("behaviour", "authorise", "organisation").
- Tests: `npm test` from the repo root (runs `vitest run` in `packages/orchestrator`). Type check: `npm run typecheck`.
- All imports inside `packages/orchestrator/src/` use the `.js` extension (NodeNext resolution), even for `.ts` files.
- Postgres `bigint` / `numeric` columns come back as **strings**. `Number()` them before arithmetic.
- The spec's single "migration 004" is split: this plan owns `004_run_adapter.sql`, the super-admin plan owns `005_issue_attribution.sql`, so each plan stands alone.
- Codex CLI flags are fixed by the spec's §2 table and were verified against `@openai/codex@0.148.0`. Do not invent flags.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/orchestrator/migrations/004_run_adapter.sql` | NEW — `runs.adapter` column |
| `packages/orchestrator/src/core/repo.ts` | MODIFY — `startRun` accepts and writes `adapter` |
| `packages/orchestrator/src/core/engine.ts` | MODIFY — pass `rt.adapter` to `startRun`; report unpriced runs |
| `packages/orchestrator/src/core/platform.ts` | MODIFY — spend-by-adapter groups on `runs.adapter` |
| `packages/orchestrator/src/core/spawn.ts` | NEW — the child-process machinery both runners share |
| `packages/orchestrator/src/core/runner.ts` | MODIFY — `createClaudeRunner` reduced to argv + usage over `spawn.ts` |
| `packages/orchestrator/src/core/prompt.ts` | NEW — `buildSystemPrompt`, moved out of `agent-loop.ts` |
| `packages/orchestrator/src/core/agent-loop.ts` | MODIFY — imports `buildSystemPrompt` instead of defining it |
| `packages/orchestrator/src/core/codex-runner.ts` | NEW — `buildCodexArgs` + `createCodexRunner` |
| `packages/orchestrator/src/core/usage.ts` | MODIFY — `extractCodexUsage` beside `extractUsage` |
| `packages/orchestrator/src/core/transcript.ts` | MODIFY — decoder selected by adapter |
| `packages/orchestrator/src/index.ts` | MODIFY — export `createCodexRunner` |
| `orchestrator.config.ts` | MODIFY — register `codex` when the binary is present |

---

### Task 1: Record which adapter a run used

`runs` has no adapter column. `agents.adapter` cannot answer — migration 003 deliberately set it to null for every agent so the configured default would apply — which also means `spend(by:"adapter")` currently returns a single null row. One column fixes both, and Task 7 needs it to choose a transcript decoder.

**Files:**
- Create: `packages/orchestrator/migrations/004_run_adapter.sql`
- Modify: `packages/orchestrator/src/core/repo.ts:332-340`
- Modify: `packages/orchestrator/src/core/engine.ts:370-375`
- Modify: `packages/orchestrator/src/core/platform.ts:507-534`
- Test: `packages/orchestrator/test/repo.test.ts`, `packages/orchestrator/test/platform.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `runs.adapter` (nullable `text`); `StartRunInput.adapter?: string | null`; `spend(companyId, "adapter")` grouping on `r.adapter`.

- [ ] **Step 1: Write the failing test**

Add to `packages/orchestrator/test/repo.test.ts`:

```ts
it("records the adapter a run used", async () => {
  const issue = await repo.createIssue({
    companyId, title: "adapter round-trip", workflowKey: "requirements",
  });
  const run = await repo.startRun({
    issueId: issue.id, agentId: null, stepIndex: 0, phase: "generate",
    logPath: "/tmp/x.jsonl", adapter: "codex",
  });
  expect(run.adapter).toBe("codex");

  const back = await repo.listRuns(issue.id);
  expect(back[0].adapter).toBe("codex");
});

it("leaves the adapter null when the caller does not supply one", async () => {
  const issue = await repo.createIssue({
    companyId, title: "no adapter", workflowKey: "requirements",
  });
  const run = await repo.startRun({
    issueId: issue.id, agentId: null, stepIndex: 0, phase: "generate", logPath: "/tmp/y.jsonl",
  });
  expect(run.adapter).toBeNull();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- repo`
Expected: FAIL — `Object literal may only specify known properties, and 'adapter' does not exist in type 'StartRunInput'` at type check, and `run.adapter` is `undefined` at runtime.

- [ ] **Step 3: Add the migration**

Create `packages/orchestrator/migrations/004_run_adapter.sql`:

```sql
-- Which adapter actually ran this run.
--
-- It could not be derived. `runs.agent_id → agents.adapter` was the obvious
-- join, and migration 003 deliberately nulled that column so that "this agent
-- has no opinion" and "this agent is pinned" stopped being the same value —
-- which left nothing anywhere recording what a given run was executed by.
--
-- Two things need the answer. `core/transcript.ts` must pick an event decoder,
-- because Claude Code's stream-json and Codex's JSONL are different
-- vocabularies. And `platform.spend(by:'adapter')` groups on `agents.adapter`,
-- so since 003 it has returned exactly one row, labelled null, for every run in
-- the system.
--
-- Written by the engine from `resolveRuntime`, which is the only place that
-- knows: the value can come from the step, the agent, a project setting or the
-- global default.
--
-- Nullable, with no backfill. Runs recorded before this column existed were
-- all Claude Code, but writing 'claude_local' into them would be asserting
-- something the data never said. `—` is the honest rendering.
alter table runs add column adapter text;

create index on runs (adapter);
```

- [ ] **Step 4: Widen `StartRunInput` and the insert**

In `packages/orchestrator/src/core/repo.ts`, add `adapter` to the `StartRunInput` interface (find it near the other run types) and to `RunRow`:

```ts
// StartRunInput
  /**
   * The adapter that will execute this run, resolved by the engine through
   * step → agent → project setting → default. Nullable because a caller
   * outside the engine (a test, a backfill) may genuinely not know.
   */
  adapter?: string | null;
```

```ts
// RunRow
  adapter: string | null;
```

Replace `startRun` at `repo.ts:332-340`:

```ts
    async startRun(input: StartRunInput): Promise<RunRow> {
      const id = newId();
      const { rows } = await db.query<RunRow>(
        `insert into runs (id, issue_id, agent_id, step_index, phase, status, log_path, adapter)
         values ($1,$2,$3,$4,$5,'running',$6,$7) returning *`,
        [id, input.issueId, input.agentId ?? null, input.stepIndex ?? null,
         input.phase ?? null, input.logPath, input.adapter ?? null]);
      return rows[0];
    },
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- repo`
Expected: PASS, both new cases.

- [ ] **Step 6: Write the failing spend test**

Add to `packages/orchestrator/test/platform.test.ts`:

```ts
it("groups spend by the adapter the run used, not the agent's pin", async () => {
  // Two runs on one issue, different adapters. `agents.adapter` is null for
  // every agent since migration 003, so grouping on it collapses both to one
  // null row — the bug this fixes.
  const issue = await repo.createIssue({
    companyId, title: "mixed adapters", workflowKey: "datamodel",
  });
  for (const [adapter, cost] of [["claude_local", 1.5], ["codex", 0]] as const) {
    const run = await repo.startRun({
      issueId: issue.id, agentId: null, stepIndex: 0, phase: "generate",
      logPath: `/tmp/${adapter}.jsonl`, adapter,
    });
    await repo.finishRun(run.id, {
      status: "succeeded", exitCode: 0, sessionId: null,
      inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0,
      costUsd: adapter === "codex" ? null : cost, durationMs: 1000, numTurns: 1,
    });
  }

  const rows = await platform.spend(companyId, "adapter");
  const byAdapter = Object.fromEntries(rows.map(r => [r.adapter, r]));
  expect(Object.keys(byAdapter).sort()).toEqual(["claude_local", "codex"]);
  expect(Number(byAdapter.claude_local.cost_usd)).toBeCloseTo(1.5);
  expect(byAdapter.codex.run_count).toBe("1");
});
```

- [ ] **Step 7: Run it and watch it fail**

Run: `npm test -- platform`
Expected: FAIL — one row keyed `null`, not two keyed by adapter name.

- [ ] **Step 8: Group on `runs.adapter`**

In `packages/orchestrator/src/core/platform.ts`, inside `spend()`, change the `adapter` entries of both maps from `a.adapter` to `r.adapter`:

```ts
      const dimension = {
        project: `p.id, p.name`,
        agent: `a.key`,
        adapter: `r.adapter`,
      }[by];
      const select = {
        project: `p.id as project_id, p.name as project_name, null::text as agent_key, null::text as adapter, null::uuid as user_id`,
        agent: `null::uuid as project_id, null::text as project_name, a.key as agent_key, null::text as adapter, null::uuid as user_id`,
        adapter: `null::uuid as project_id, null::text as project_name, null::text as agent_key, r.adapter as adapter, null::uuid as user_id`,
      }[by];
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npm test -- platform`
Expected: PASS.

- [ ] **Step 10: Pass the resolved adapter from the engine**

In `packages/orchestrator/src/core/engine.ts`, inside `attemptOnce` (around line 370), add `adapter` to the `startRun` call:

```ts
          const run = await repo.startRun({
            issueId: issue.id, agentId: agentRow?.id ?? null,
            stepIndex: issue.step_index, phase: step.phase, logPath,
            // `rt` is the ONLY place that knows: step → agent → project
            // setting → default. Recorded so the transcript can be decoded
            // and spend can be attributed.
            adapter: rt.adapter,
          });
```

- [ ] **Step 11: Run the whole suite**

Run: `npm test && npm run typecheck`
Expected: PASS. `engine.test.ts` must stay green — no behaviour changed for existing runs.

- [ ] **Step 12: Checkpoint**

Stop. Report: migration added, `runs.adapter` written by the engine, spend-by-adapter repaired. Do not commit — hand back for review.

---

### Task 2: Extract the shared child-process machinery

`createClaudeRunner` is ~200 lines of which only `buildArgs`, `extractUsage` and the stdin write are Claude-specific. Everything else — separate stdout/stderr line buffering, the JSONL envelope log, the SIGTERM-then-SIGKILL duration ceiling, `resolveOnce` idempotency, the EPIPE handler — is adapter-neutral. Copy-pasting it for Codex is how the transcript-corruption bug comes back on one adapter only.

This task changes **no behaviour**. `runner.test.ts` must pass untouched.

**Files:**
- Create: `packages/orchestrator/src/core/spawn.ts`
- Modify: `packages/orchestrator/src/core/runner.ts`
- Test: `packages/orchestrator/test/runner.test.ts` (unchanged — it is the regression harness for this refactor)

**Interfaces:**
- Consumes: `RunRequest`, `RunResult` from `runner.ts`.
- Produces:
  ```ts
  export interface SpawnSpec {
    bin: string;
    args: string[];
    /** Extract usage from the child's complete stdout. Null when it reported none. */
    extractUsage: (capturedStdout: string) => RunUsage | null;
  }
  export function runChild(req: RunRequest, spec: SpawnSpec): Promise<RunResult>;
  export const BACKSTOP_DURATION_MS: number;
  export const STDERR_TAIL_CHARS: number;
  ```

- [ ] **Step 1: Create `spawn.ts` by moving, not rewriting**

Create `packages/orchestrator/src/core/spawn.ts`. Move the body of `createClaudeRunner`'s returned `run()` verbatim — every comment included, they document real incidents — and replace the three Claude-specific points:

- `spawn(bin, buildArgs(req), …)` becomes `spawn(spec.bin, spec.args, …)`
- `extractUsage(captured)` becomes `spec.extractUsage(captured)`
- move `BACKSTOP_DURATION_MS`, `BUDGET_KILL_GRACE_MS`, `STDERR_TAIL_CHARS` and `takeCompleteLines` across

Header comment:

```ts
// The child-process machinery every subprocess adapter shares.
//
// Extracted from runner.ts when a second whole-agent adapter (Codex) arrived.
// None of what follows is Claude-specific: the separate stdout/stderr line
// buffering, the JSONL envelope log, the bounded budget kill, the idempotent
// resolution, the EPIPE swallow. Each of those exists because of a specific
// incident recorded in the comments below, and a second copy would be a second
// place for those incidents to come back.
//
// What an adapter supplies is a binary, an argv, and a way to read usage out of
// the stdout it produced. Nothing else.
```

- [ ] **Step 2: Reduce `runner.ts` to its Claude-specific parts**

`runner.ts` keeps `RunRequest`, `RunResult`, `Runner`, `buildArgs` (unchanged), and:

```ts
export function createClaudeRunner(opts: { bin?: string } = {}): Runner {
  const bin = opts.bin ?? "claude";
  return {
    run(req: RunRequest): Promise<RunResult> {
      return runChild(req, { bin, args: buildArgs(req), extractUsage });
    },
  };
}
```

Re-export `BACKSTOP_DURATION_MS` from `spawn.ts` so existing importers keep working:

```ts
export { BACKSTOP_DURATION_MS } from "./spawn.js";
```

- [ ] **Step 3: Run the existing suite unchanged**

Run: `npm test -- runner && npm run typecheck`
Expected: PASS with **no edits to `runner.test.ts`**. If a test needed changing, the refactor changed behaviour — revert and redo the move.

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: PASS. `engine.test.ts` and `retry.test.ts` exercise the runner indirectly.

- [ ] **Step 5: Checkpoint**

Stop. Report: pure refactor, `runner.test.ts` untouched and green.

---

### Task 3: Share the system-prompt framing

`buildSystemPrompt` is private in `agent-loop.ts:108` and already frames a bundle plus a `SKILL.md` for a provider that cannot discover skills itself. Codex is such a provider. Moving it out means the loop adapters and Codex frame a skill identically rather than drifting.

**Files:**
- Create: `packages/orchestrator/src/core/prompt.ts`
- Modify: `packages/orchestrator/src/core/agent-loop.ts:93-135`
- Test: `packages/orchestrator/test/prompt.test.ts` (new), `packages/orchestrator/test/agent-loop.test.ts` (unchanged)

**Interfaces:**
- Consumes: `skillFilePath` from `core/skills.js`.
- Produces:
  ```ts
  export function buildSystemPrompt(bundle: string, skill: { name: string; body: string } | null): string;
  export async function loadSkill(installRoot: string, skillsDir: string, name: string): Promise<string>;
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/orchestrator/test/prompt.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../src/core/prompt.js";

describe("buildSystemPrompt", () => {
  it("puts the skill body under a named heading after the bundle", () => {
    const out = buildSystemPrompt("You are the Data Modeler.", {
      name: "salesforce-data-modeler",
      body: "## Method\nStandard objects first.",
    });
    expect(out).toContain("You are the Data Modeler.");
    expect(out).toContain("# Skill: salesforce-data-modeler");
    expect(out).toContain("Standard objects first.");
    expect(out.indexOf("You are the Data Modeler.")).toBeLessThan(out.indexOf("# Skill:"));
  });

  it("omits the skill section entirely when the step names no skill", () => {
    const out = buildSystemPrompt("You are the Developer.", null);
    expect(out).not.toContain("# Skill:");
    expect(out).toContain("You are the Developer.");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- prompt`
Expected: FAIL — `Cannot find module '../src/core/prompt.js'`.

- [ ] **Step 3: Move the two functions**

Create `packages/orchestrator/src/core/prompt.ts` and move `loadSkill` (`agent-loop.ts:98`) and `buildSystemPrompt` (`agent-loop.ts:108`) into it **verbatim**, exported. Keep their comments — the `Unknown skill: <slug>` wording is load-bearing, because every runbook in this repo greps for that exact string.

Header:

```ts
// How a non-Claude agent is told who it is and what method to follow.
//
// Claude Code discovers `.claude/skills/<slug>/SKILL.md` for itself. Nothing
// else can — not the loop-driven providers, not Codex CLI — so the SKILL.md is
// read here and put in the system prompt. The skill files themselves stay
// provider-neutral markdown and are never touched.
//
// Shared rather than duplicated per adapter so that a change to how a skill is
// framed reaches every provider that needs the framing at once.
```

In `agent-loop.ts`, delete both definitions and import them:

```ts
import { buildSystemPrompt, loadSkill } from "./prompt.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- prompt agent-loop && npm run typecheck`
Expected: PASS. `agent-loop.test.ts` must be unchanged and green.

- [ ] **Step 5: Checkpoint**

Stop. Report: pure move, both suites green.

---

### Task 4: Build the Codex argv

Pure function, no process. Every flag is fixed by the spec's §2 table, verified against `@openai/codex@0.148.0`.

**Files:**
- Create: `packages/orchestrator/src/core/codex-runner.ts`
- Test: `packages/orchestrator/test/codex-runner.test.ts`

**Interfaces:**
- Consumes: `RunRequest` from `core/runner.js`.
- Produces: `export function buildCodexArgs(req: RunRequest, mcpServers: Record<string, McpServer>): string[]`, where
  ```ts
  export interface McpServer { command: string; args?: string[]; env?: Record<string, string> }
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/orchestrator/test/codex-runner.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildCodexArgs } from "../src/core/codex-runner.js";
import type { RunRequest } from "../src/core/runner.js";

const base: RunRequest = {
  agent: { key: "dataModeler" },
  prompt: "irrelevant — the prompt goes on stdin",
  cwd: "/work",
  logPath: "/logs/run.jsonl",
};

describe("buildCodexArgs", () => {
  it("runs non-interactively, streams JSONL, and never puts the prompt on argv", () => {
    const a = buildCodexArgs(base, {});
    expect(a[0]).toBe("exec");
    expect(a).toContain("--json");
    expect(a.join(" ")).not.toContain("irrelevant");
  });

  it("sets the working root, the sandbox and the git-repo escape", () => {
    const a = buildCodexArgs({ ...base, cwd: "/work/projects" }, {});
    expect(a).toContain("--cd");
    expect(a[a.indexOf("--cd") + 1]).toBe("/work/projects");
    expect(a[a.indexOf("--sandbox") + 1]).toBe("workspace-write");
    expect(a).toContain("--skip-git-repo-check");
  });

  it("leaves no session files behind and ignores the developer's own config", () => {
    const a = buildCodexArgs(base, {});
    expect(a).toContain("--ephemeral");
    expect(a).toContain("--ignore-user-config");
  });

  it("passes a model only when one is configured", () => {
    expect(buildCodexArgs(base, {})).not.toContain("--model");
    const a = buildCodexArgs({ ...base, model: "gpt-5-codex" }, {});
    expect(a[a.indexOf("--model") + 1]).toBe("gpt-5-codex");
  });

  it("translates effort into the config override Codex understands", () => {
    const a = buildCodexArgs({ ...base, effort: "high" }, {});
    expect(a).toContain("-c");
    expect(a.join(" ")).toContain('model_reasoning_effort="high"');
  });

  it("expands MCP servers into -c overrides, but only when the agent has MCP", () => {
    const servers = { ado: { command: "npx", args: ["-y", "@azure-devops/mcp", "scyne"] } };
    expect(buildCodexArgs(base, servers).join(" ")).not.toContain("mcp_servers");

    const withMcp = buildCodexArgs({ ...base, agent: { key: "ba", mcpEnabled: true } }, servers);
    const joined = withMcp.join(" ");
    expect(joined).toContain('mcp_servers.ado.command="npx"');
    expect(joined).toContain('mcp_servers.ado.args=["-y","@azure-devops/mcp","scyne"]');
  });

  it("encodes an MCP server's env as a TOML inline table, not a JSON object", () => {
    // JSON.stringify is valid TOML for the args array and NOT for this map:
    // `{"ADO_PAT":"x"}` is JSON object syntax, TOML wants `{ ADO_PAT = "x" }`.
    // Codex uses a `-c` value that fails to parse as a raw string, so getting
    // this wrong loses every credential in the map silently.
    const servers = { ado: { command: "npx", env: { ADO_PAT: "x" } } };
    const joined = buildCodexArgs({ ...base, agent: { key: "ba", mcpEnabled: true } }, servers).join(" ");
    expect(joined).toContain('mcp_servers.ado.env={ ADO_PAT = "x" }');
    expect(joined).not.toContain('"ADO_PAT":"x"');
  });

  it("appends the agent's extraArgs last so an operator can override anything", () => {
    const a = buildCodexArgs({ ...base, agent: { key: "ba", extraArgs: ["--add-dir", "/extra"] } }, {});
    expect(a.slice(-2)).toEqual(["--add-dir", "/extra"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- codex-runner`
Expected: FAIL — `Cannot find module '../src/core/codex-runner.js'`.

- [ ] **Step 3: Write `buildCodexArgs`**

Create `packages/orchestrator/src/core/codex-runner.ts`:

```ts
// The Codex CLI runner: spawns `codex exec --json`, writes the prompt on
// stdin, and reads token usage out of the JSONL it emits.
//
// Beside createClaudeRunner rather than behind createLoopRunner, deliberately.
// The loop runner exists to supply the agency a bare chat API lacks — it does
// the reading, writing and skill-loading itself. Codex is a whole agent and
// already does all of that, so wrapping it would be re-implementing the binary.
//
// Every flag below was verified against `codex exec --help` on
// @openai/codex@0.148.0. Two differences from Claude Code shape this file:
// there is no --system-prompt-file (so the bundle and SKILL.md are prepended
// to the prompt), and MCP servers are per-invocation config overrides rather
// than a file path.

import { readFile } from "node:fs/promises";
import type { RunRequest, RunResult, Runner } from "./runner.js";

export interface McpServer { command: string; args?: string[]; env?: Record<string, string> }

/**
 * Codex parses a `-c key=value` value as TOML, falling back to a raw string
 * when it fails to parse. This only ever has to encode three shapes for this
 * file's call sites — a string, an array of strings, and a flat
 * string-to-string map — so it is a small dispatcher, not a general TOML
 * serialiser, and should not grow into one.
 *
 * `JSON.stringify` is correct for the first two: TOML and JSON agree on
 * quoted-string and bracketed-array syntax, so `"npx"` and
 * `["-y","@azure-devops/mcp","scyne"]` are valid TOML as well as valid JSON.
 * It is NOT correct for the third. TOML's inline-table syntax is
 * `{ key = "value" }` — braces, but `=` rather than `:` — so
 * `JSON.stringify({ADO_PAT:"x"})` produces `{"ADO_PAT":"x"}`, which is JSON
 * object syntax and fails to parse as TOML. A value that fails to parse falls
 * back to being used as a raw string, so an `env` map encoded this way
 * silently loses every credential in it rather than erroring loudly. The
 * VALUES inside the table are still run through JSON.stringify so their
 * quoting and escaping stay correct — only the separator and the surrounding
 * punctuation change.
 */
const toml = (v: string | string[] | Record<string, string>): string => {
  if (typeof v === "string" || Array.isArray(v)) return JSON.stringify(v);
  const entries = Object.entries(v).map(([k, val]) => `${k} = ${JSON.stringify(val)}`);
  return `{ ${entries.join(", ")} }`;
};

export function buildCodexArgs(req: RunRequest, mcpServers: Record<string, McpServer>): string[] {
  const a = [
    "exec",
    "--json",              // JSONL events on stdout — the transcript's raw material
    "--ephemeral",         // no session files; the orchestrator owns run history
    "--skip-git-repo-check",
    "--ignore-user-config", // a developer's ~/.codex/config.toml must never leak into a run
    "--sandbox", "workspace-write",
    "--cd", req.cwd,
  ];

  if (req.model) a.push("--model", req.model);

  // Codex has no --effort. Its equivalent is a config key, so an explicit pin
  // on a step or an agent still reaches the model.
  if (req.effort) a.push("-c", `model_reasoning_effort=${toml(req.effort)}`);

  // MCP is configuration here rather than a file path. The SAME .mcp.json the
  // Claude runner is handed is expanded into overrides, so there is one source
  // of truth for what servers exist and two argument shapes for it.
  if (req.agent.mcpEnabled) {
    for (const [name, s] of Object.entries(mcpServers)) {
      a.push("-c", `mcp_servers.${name}.command=${toml(s.command)}`);
      if (s.args?.length) a.push("-c", `mcp_servers.${name}.args=${toml(s.args)}`);
      if (s.env && Object.keys(s.env).length) a.push("-c", `mcp_servers.${name}.env=${toml(s.env)}`);
    }
  }

  // Last, so an operator's extraArgs can override anything above.
  if (req.agent.extraArgs?.length) a.push(...req.agent.extraArgs);
  return a;
}

/** Read the `mcpServers` map out of the `.mcp.json` the engine points at. */
export async function readMcpServers(path: string | undefined): Promise<Record<string, McpServer>> {
  if (!path) return {};
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { mcpServers?: Record<string, McpServer> };
    return parsed.mcpServers ?? {};
  } catch {
    // A missing or malformed .mcp.json is not fatal: an agent with mcpEnabled
    // and no servers simply has no tools beyond its own. The Claude runner
    // behaves the same way — it passes the path and lets the CLI decide.
    return {};
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- codex-runner && npm run typecheck`
Expected: PASS, all seven cases.

- [ ] **Step 5: Checkpoint**

Stop. Report the argv the tests pin.

---

### Task 5: Capture a real Codex transcript and parse its usage

The event vocabulary is **not** taken from documentation. `usage.ts`'s existing parser earned its reliability by being written against `fixtures/result-event.jsonl` captured from a real run; this does the same. Codex reports token counts and **no dollar figure**, so `costUsd` is null and must never render as `$0.00`.

**Files:**
- Create: `packages/orchestrator/test/fixtures/codex-run.jsonl` (captured, not written)
- Modify: `packages/orchestrator/src/core/usage.ts`
- Test: `packages/orchestrator/test/usage.test.ts`

**Interfaces:**
- Consumes: `RunUsage` from `core/usage.js`.
- Produces: `export function extractCodexUsage(jsonlLines: string): RunUsage | null`.

- [ ] **Step 1: The fixture, and what is real about it**

`codex` 0.148.0 is installed, but `codex login` has not been run on this host, so an
authenticated capture is not available yet. A capture was taken anyway, against the
unauthenticated CLI — it fails at the model call but emits the real event envelope
first, and that envelope is already committed at
`packages/orchestrator/test/fixtures/codex-envelope-unauthenticated.jsonl`:

```
{"type":"thread.started","thread_id":"01a01e12-51ae-7511-8831-6cf53921a902"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"error","message":"…"}}
{"type":"error","message":"…"}
{"type":"turn.failed","error":{…}}
```

So the schema is **thread / turn / item**, the session id is a top-level `thread_id`,
and items nest under `item`. That much is observed, not guessed.

What is NOT observed is the usage line, because the run never reached the model. A
successful run additionally emits `turn.completed`, which is where the token counts
live. Build `test/fixtures/codex-run.jsonl` as the real envelope above **plus one
synthetic `turn.completed` line**, and mark it in the file itself:

```jsonl
{"_comment":"UNVERIFIED — synthetic turn.completed. Every other line in this file is a real capture. Replace this one from an authenticated run; see Task 10."}
{"type":"turn.completed","usage":{"input_tokens":1234,"cached_input_tokens":0,"output_tokens":56}}
```

Once `codex login` has been run, replace the whole file with a real capture:

```bash
codex exec --json --ephemeral --skip-git-repo-check --sandbox read-only \
  --cd /tmp "Reply with the single word: ready." \
  > packages/orchestrator/test/fixtures/codex-run.jsonl
```

- [ ] **Step 2: Confirm the field names off the fixture**

```bash
python3 -c "
import json,sys
for l in open('packages/orchestrator/test/fixtures/codex-run.jsonl'):
    l=l.strip()
    if not l.startswith('{'): continue
    o=json.loads(l)
    print(sorted(o.keys()), o.get('type') or (o.get('msg') or {}).get('type'))
"
```

Record the event kind that carries token counts and the exact key path to them. The
parser in Step 4 is written against **those names**. If a later authenticated capture
shows a different shape, change Step 4's code — not the fixture. The fallbacks in Step 4
exist precisely because only the envelope is confirmed.

- [ ] **Step 3: Write the failing test**

Add to `packages/orchestrator/test/usage.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { extractCodexUsage } from "../src/core/usage.js";

describe("extractCodexUsage", () => {
  const fixture = readFileSync(
    new URL("./fixtures/codex-run.jsonl", import.meta.url), "utf8");

  it("reads token counts off a real captured run", () => {
    const u = extractCodexUsage(fixture);
    expect(u).not.toBeNull();
    expect(u!.inputTokens).toBeGreaterThan(0);
    expect(u!.outputTokens).toBeGreaterThan(0);
  });

  it("reports no cost, because Codex does not price its own runs", () => {
    // null, NOT 0. A run that reads as free is worse than one that admits it
    // does not know: the console renders `—` for null and `$0.0000` for zero.
    expect(extractCodexUsage(fixture)!.costUsd).toBeNull();
  });

  it("returns null for a transcript with no usage event", () => {
    expect(extractCodexUsage('{"type":"item.started"}\n')).toBeNull();
  });

  it("skips malformed lines rather than throwing", () => {
    expect(() => extractCodexUsage("not json\n{\n")).not.toThrow();
  });
});
```

- [ ] **Step 4: Write the parser against the captured names**

Append to `packages/orchestrator/src/core/usage.ts`:

```ts
/**
 * Parse aggregate usage out of a `codex exec --json` transcript.
 *
 * Written against a real capture (test/fixtures/codex-run.jsonl), the same
 * discipline `extractUsage` above was written with — the field names are
 * observed, not remembered.
 *
 * `costUsd` is ALWAYS null: Codex reports tokens and does not price them, and
 * this repository deliberately holds no price table (see CLAUDE.md — a figure
 * in the console is the CLI's own arithmetic, never ours). Null renders as `—`;
 * returning 0 would render as `$0.0000` and read as a free run.
 */
export function extractCodexUsage(jsonlLines: string): RunUsage | null {
  let input = 0, output = 0, cachedInput = 0;
  let found = false;
  let sessionId: string | null = null;

  for (const line of jsonlLines.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    let o: any;
    try { o = JSON.parse(trimmed); } catch { continue; }

    // Session id. `thread.started` carries a top-level `thread_id` — observed in a
    // real capture. The others are fallbacks for versions that named it differently.
    sessionId ??= strOrNull(o.thread_id ?? o.session_id ?? o.msg?.session_id);

    // Token counts, carried on `turn.completed`. Codex has moved these between
    // shapes across versions, so every place it has put them is checked and the LAST
    // one wins — a transcript carries a running total, and the final one is the
    // aggregate. Only the ENVELOPE is confirmed against a real capture; the usage
    // key path is inferred, which is why the fallback chain is this wide.
    const u = o.usage ?? o.msg?.usage ?? o.info?.total_token_usage ?? o.item?.usage;
    if (u && typeof u === "object") {
      found = true;
      input = num(u.input_tokens ?? u.prompt_tokens ?? input);
      output = num(u.output_tokens ?? u.completion_tokens ?? output);
      cachedInput = num(u.cached_input_tokens ?? u.cache_read_input_tokens ?? cachedInput);
    }
  }

  if (!found) return null;
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cachedInput,
    cacheCreationTokens: 0,   // Codex reports no cache-creation figure
    costUsd: null,            // see the header — deliberately not zero
    durationMs: null,         // the runner supplies wall clock instead
    numTurns: null,
    sessionId,
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- usage`
Expected: PASS. If the first two fail, the fixture's field names differ from Step 4's guesses — fix the code from what Step 2 printed.

- [ ] **Step 6: Checkpoint**

Stop. Report the observed event shape and confirm `costUsd` is null.

---

### Task 6: Assemble `createCodexRunner`

**Files:**
- Modify: `packages/orchestrator/src/core/codex-runner.ts`
- Modify: `packages/orchestrator/src/index.ts`
- Test: `packages/orchestrator/test/codex-runner.test.ts`

**Interfaces:**
- Consumes: `runChild`/`SpawnSpec` (Task 2), `buildSystemPrompt`/`loadSkill` (Task 3), `buildCodexArgs`/`readMcpServers` (Task 4), `extractCodexUsage` (Task 5).
- Produces: `export function createCodexRunner(opts: { installRoot: string; skillsDir?: string; bin?: string }): Runner`.

- [ ] **Step 1: Write the failing test**

Add to `packages/orchestrator/test/codex-runner.test.ts`:

```ts
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexRunner } from "../src/core/codex-runner.js";

describe("createCodexRunner", () => {
  it("prepends the bundle and the SKILL.md to the prompt, since Codex has no --system-prompt-file", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-"));
    mkdirSync(join(root, "skills", "salesforce-data-modeler"), { recursive: true });
    writeFileSync(join(root, "skills", "salesforce-data-modeler", "SKILL.md"),
      "## Method\nStandard objects first.");
    writeFileSync(join(root, "bundle.md"), "You are the Data Modeler.");

    // A stand-in for `codex` that writes its stdin to a file and exits 0, so
    // the test can assert on what the runner actually sent.
    const seen = join(root, "stdin.txt");
    const fake = join(root, "fake-codex");
    writeFileSync(fake, `#!/bin/sh\ncat > ${seen}\nexit 0\n`, { mode: 0o755 });

    const runner = createCodexRunner({ installRoot: root, bin: fake });
    const res = await runner.run({
      agent: { key: "dataModeler", bundlePath: join(root, "bundle.md") },
      skill: "salesforce-data-modeler",
      prompt: "Generate the data model.",
      cwd: root,
      logPath: join(root, "run.jsonl"),
    });

    expect(res.exitCode).toBe(0);
    const sent = readFileSync(seen, "utf8");
    expect(sent).toContain("You are the Data Modeler.");
    expect(sent).toContain("# Skill: salesforce-data-modeler");
    expect(sent).toContain("Generate the data model.");
    expect(sent.indexOf("You are the Data Modeler.")).toBeLessThan(sent.indexOf("Generate the data model."));
  });

  it("fails with Claude Code's own wording when the skill does not exist", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-"));
    const runner = createCodexRunner({ installRoot: root, bin: "/bin/true" });
    const res = await runner.run({
      agent: { key: "dataModeler" },
      skill: "no-such-skill",
      prompt: "x", cwd: root, logPath: join(root, "run.jsonl"),
    });
    expect(res.status).toBe("failed");
    // Every runbook in this repo greps for this exact string.
    expect(res.stderrTail).toContain("Unknown skill: no-such-skill");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- codex-runner`
Expected: FAIL — `createCodexRunner is not a function`.

- [ ] **Step 3: Implement the runner**

Append to `packages/orchestrator/src/core/codex-runner.ts`:

Add to the imports at the top of the file (ESM imports are hoisted, but keep
them together — a reader scanning for dependencies should find them in one
place):

```ts
import { runChild, STDERR_TAIL_CHARS } from "./spawn.js";
import { buildSystemPrompt, loadSkill } from "./prompt.js";
import { extractCodexUsage } from "./usage.js";

export function createCodexRunner(
  opts: { installRoot: string; skillsDir?: string; bin?: string },
): Runner {
  const bin = opts.bin ?? "codex";
  const skillsDir = opts.skillsDir ?? "skills";

  return {
    async run(req: RunRequest): Promise<RunResult> {
      // Codex has no --system-prompt-file, so who-you-are and how-you-work
      // travel with the task on stdin. Same framing the loop adapters use, from
      // the same module, so the three non-Claude paths cannot drift.
      let system = "";
      try {
        const bundle = req.agent.bundlePath ? await readFile(req.agent.bundlePath, "utf8") : "";
        const skill = req.skill
          ? { name: req.skill, body: await loadSkill(opts.installRoot, skillsDir, req.skill) }
          : null;
        system = buildSystemPrompt(bundle, skill);
      } catch (err) {
        // A missing bundle or an unknown skill is a configuration error, and
        // spawning to discover it would bill a run to learn nothing. Fail here,
        // in the same shape a failed run takes, so the engine's blocking comment
        // reads identically either way.
        return {
          exitCode: -1, status: "failed", usage: null,
          stderrTail: String(err instanceof Error ? err.message : err).slice(-STDERR_TAIL_CHARS),
        };
      }

      const mcpServers = await readMcpServers(req.mcpConfigPath);
      return runChild(
        { ...req, prompt: `${system}\n\n---\n\n${req.prompt}` },
        { bin, args: buildCodexArgs(req, mcpServers), extractUsage: extractCodexUsage },
      );
    },
  };
}
```

Export it from `packages/orchestrator/src/index.ts` alongside `createClaudeRunner`:

```ts
export { createCodexRunner, buildCodexArgs } from "./core/codex-runner.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- codex-runner && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Stop.

---

### Task 7: Decode a Codex transcript in the console

`filterRunLog` parses Claude's stream-json vocabulary. A Codex log currently renders as an empty transcript — worse than a broken one, because an operator reads "nothing happened".

**Files:**
- Modify: `packages/orchestrator/src/core/transcript.ts`
- Modify: `packages/orchestrator/src/http/router.ts` (the `/runs/{id}/transcript` handler passes the run's adapter)
- Test: `packages/orchestrator/test/transcript.test.ts`

**Interfaces:**
- Consumes: `runs.adapter` (Task 1), `test/fixtures/codex-run.jsonl` (Task 5).
- Produces: `filterRunLog(rawLog: string, adapter?: string | null): FilterResult` — the second parameter is optional and defaults to the Claude decoder, so every existing caller keeps working.

- [ ] **Step 1: Write the failing test**

Add to `packages/orchestrator/test/transcript.test.ts`:

```ts
import { readFileSync } from "node:fs";

describe("filterRunLog on a codex transcript", () => {
  // The runner wraps each child line in {ts, stream, chunk}; rebuild that shape
  // from the captured fixture so the test exercises the real outer format.
  const envelope = readFileSync(new URL("./fixtures/codex-run.jsonl", import.meta.url), "utf8")
    .split("\n").filter(Boolean)
    .map(l => JSON.stringify({ ts: "2026-08-20T01:02:03.000Z", stream: "stdout", chunk: l + "\n" }))
    .join("\n") + "\n";

  it("produces assistant events rather than an empty transcript", () => {
    const { events } = filterRunLog(envelope, "codex");
    expect(events.length).toBeGreaterThan(0);
    expect(events.some(e => e.kind === "assistant")).toBe(true);
  });

  it("keeps the Claude decoder as the default for callers that pass nothing", () => {
    const claudeLine = JSON.stringify({
      ts: "2026-08-20T01:02:03.000Z", stream: "stdout",
      chunk: JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "hello" }] },
      }) + "\n",
    }) + "\n";
    const { events } = filterRunLog(claudeLine);
    expect(events).toContainEqual(expect.objectContaining({ kind: "assistant", text: "hello" }));
  });

  it("renders the real captured envelope rather than an empty transcript", () => {
    // codex-envelope-unauthenticated.jsonl is a genuine capture: the run failed at
    // the model call, but a failed run whose transcript is blank is the worst
    // possible output — an operator cannot tell it from a run that did nothing.
    const real = readFileSync(
      new URL("./fixtures/codex-envelope-unauthenticated.jsonl", import.meta.url), "utf8")
      .split("\n").filter(Boolean)
      .map(l => JSON.stringify({ ts: "2026-08-20T01:02:03.000Z", stream: "stdout", chunk: l + "\n" }))
      .join("\n") + "\n";
    const { events } = filterRunLog(real, "codex");
    expect(events.length).toBeGreaterThan(0);
    expect(events.some(e => "text" in e && /401|Unauthorized/i.test(e.text))).toBe(true);
  });

  it("passes an unrecognised event through as text instead of dropping it", () => {
    // A Codex version bump must degrade the transcript, never empty it.
    const odd = JSON.stringify({
      ts: "2026-08-20T01:02:03.000Z", stream: "stdout",
      chunk: JSON.stringify({ type: "some_future_event", detail: "brand new thing" }) + "\n",
    }) + "\n";
    const { events } = filterRunLog(odd, "codex");
    expect(events.some(e => "text" in e && e.text.includes("brand new thing"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- transcript`
Expected: FAIL — the codex fixture yields zero events; `filterRunLog` takes one argument.

- [ ] **Step 3: Split the inner pass by adapter**

In `packages/orchestrator/src/core/transcript.ts`, extract the existing inner classification loop (the `for (const { ts, line } of innerLines)` body) into `decodeClaudeLine(ts, line, events)`, unchanged. Add beside it:

```ts
/**
 * Codex CLI's JSONL vocabulary.
 *
 * Written against a real capture, like the Claude decoder. Codex has moved
 * event names between versions, so anything unrecognised is emitted as text
 * rather than dropped: a version bump must degrade this transcript, never empty
 * it — an operator reading "nothing happened" for a working run is the failure
 * mode worth engineering against.
 */
function decodeCodexLine(ts: string, obj: any, events: TranscriptEvent[]): void {
  // Envelope confirmed against a real capture: thread.started / turn.started /
  // turn.completed / turn.failed / item.completed / error, with the payload of an
  // item nested under `item` and its own kind on `item.type` (agent_message,
  // command_execution, error). `msg` is a fallback for older builds.
  const kind = obj.type ?? obj.msg?.type ?? "";
  const body = obj.item ?? obj.msg ?? obj;

  // Assistant prose, wherever this version puts it.
  const text = body.text ?? body.message ?? body.delta ?? body.last_agent_message;
  if (typeof text === "string" && text.trim() && !/token|usage/i.test(kind)) {
    events.push({ ts, kind: "assistant", text: scrub(summarise(text, 600)) });
    return;
  }

  // Shell commands Codex ran. `run_command` is this repo's own tool vocabulary
  // in tools.ts, so the transcript reads the same across adapters.
  const command = body.command ?? body.cmd;
  if (command) {
    const shown = Array.isArray(command) ? command.join(" ") : String(command);
    events.push({ ts, kind: "tool_use", tool: "run_command", preview: scrub(summarise(shown)) });
    return;
  }

  // An error is worth showing — a failed run whose transcript is blank tells an
  // operator nothing about why.
  if (kind === "error" || body?.type === "error") {
    const m = scrub(summarise(String(obj.message ?? body?.message ?? ""), 300));
    if (m) events.push({ ts, kind: "framing", text: m });
    return;
  }

  if (/token_count|usage|turn\.completed/i.test(kind)) return;   // usage.ts owns these
  if (/^(session|thread|turn)[._]/i.test(kind)) return;           // lifecycle noise

  // Unrecognised: show it rather than lose it.
  const dump = scrub(summarise(JSON.stringify(obj), 240));
  if (dump) events.push({ ts, kind: "framing", text: dump });
}
```

Change the signature and dispatch:

```ts
export function filterRunLog(rawLog: string, adapter?: string | null): FilterResult {
```

and in the inner pass, replace the classification body with:

```ts
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    if (adapter === "codex") decodeCodexLine(tsLocal, obj, events);
    else decodeClaudeLine(tsLocal, obj, events);
```

Keep the plain-text framing branch (`[paperclip]`, `[orchestrator]`, …) ahead of the JSON parse for both adapters — the engine writes those regardless of who ran.

- [ ] **Step 4: Pass the adapter from the HTTP layer**

In `packages/orchestrator/src/http/router.ts`, find the `/runs/{id}/transcript` handler and pass the run's recorded adapter:

```ts
const { events, consumed } = filterRunLog(raw, run.adapter);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- transcript router && npm run typecheck`
Expected: PASS. Existing `transcript.test.ts` cases must be untouched and green — the default path is unchanged.

- [ ] **Step 6: Checkpoint**

Stop.

---

### Task 8: Say when cost is unavailable rather than showing zero

With Codex registered, a run can complete having reported no cost. The engine already omits the figure per-run (`spend != null ? …`), but the closing total silently sums nulls as zero, so a whole Codex workflow reads as `1 agent run.` with no hint that money was spent and not measured.

**Files:**
- Modify: `packages/orchestrator/src/core/engine.ts:556-563`
- Test: `packages/orchestrator/test/engine.test.ts`

**Interfaces:**
- Consumes: `runs.adapter`, `runs.cost_usd` (Task 1).
- Produces: no new exports — a comment-text change only.

- [ ] **Step 1: Write the failing test**

Add to `packages/orchestrator/test/engine.test.ts`:

```ts
it("says how many runs reported no cost instead of summing them as zero", async () => {
  // A workflow that completed entirely on an adapter that does not price runs
  // must not close with a bare run count that reads as free.
  const issue = await repo.createIssue({
    companyId, title: "unpriced", workflowKey: "datamodel",
  });
  const run = await repo.startRun({
    issueId: issue.id, agentId: null, stepIndex: 0, phase: "generate",
    logPath: "/tmp/u.jsonl", adapter: "codex",
  });
  await repo.finishRun(run.id, {
    status: "succeeded", exitCode: 0, sessionId: null,
    inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0,
    costUsd: null, durationMs: 1000, numTurns: 3,
  });

  const line = closingNote(await repo.listRuns(issue.id), "Data Model");
  expect(line).toContain("1 agent run");
  expect(line).toContain("cost not reported");
  expect(line).not.toContain("$0.0000");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- engine`
Expected: FAIL — `closingNote is not exported`.

- [ ] **Step 3: Extract and extend the closing line**

In `packages/orchestrator/src/core/engine.ts`, add an exported helper above the engine factory:

```ts
/**
 * The closing line of an issue's timeline.
 *
 * Exported so it can be tested directly, and because the unpriced case is
 * easy to get wrong: `sum(cost_usd)` over rows where some are null yields a
 * number that looks complete and is not. An adapter that reports no cost
 * (Codex does not price its own runs) must produce a line that says so, not a
 * quiet total that understates what was spent.
 */
export function closingNote(runs: Array<{ cost_usd: string | number | null }>, label: string): string {
  const priced = runs.filter(r => r.cost_usd != null);
  const total = priced.reduce((n, r) => n + Number(r.cost_usd), 0);
  const unpriced = runs.length - priced.length;

  return `**${label} complete.** ${runs.length} agent run${runs.length === 1 ? "" : "s"}` +
    (total > 0 ? ` · $${total.toFixed(4)}` : "") +
    (unpriced ? ` · cost not reported for ${unpriced} run${unpriced === 1 ? "" : "s"}` : "") + `.`;
}
```

Replace the inline block at `engine.ts:559-563`:

```ts
          const runs = await repo.listRuns(issueId);
          await note(issueId, closingNote(runs, wf.label));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- engine && npm run typecheck`
Expected: PASS, and existing engine cases green.

- [ ] **Step 5: Checkpoint**

Stop.

---

### Task 9: Register the adapter

**Files:**
- Modify: `orchestrator.config.ts:65-115`
- Modify: `CLAUDE.md` (the adapter table and the troubleshooting table)
- Test: `packages/orchestrator/test/config.test.ts`

**Interfaces:**
- Consumes: `createCodexRunner` (Task 6).
- Produces: adapter key `codex` in the registry; `SCYNE_ADAPTER=codex` switches the org.

- [ ] **Step 1: Write the failing test**

Add to `packages/orchestrator/test/config.test.ts`:

```ts
it("refuses an agent naming an unregistered adapter, and names what is available", () => {
  const problems = validateConfig({
    workspace: "/w",
    db: { driver: "pglite", dir: "/tmp/x" },
    adapters: { claude_local: {} as any },
    org: [{ key: "ba", name: "BA", adapter: "codex" }],
    workflows: [],
  });
  expect(problems.join("\n")).toContain("adapter 'codex', which is not registered");
  expect(problems.join("\n")).toContain("claude_local");
});
```

- [ ] **Step 2: Run it**

Run: `npm test -- config`
Expected: PASS already — `validateConfig` covers this. This test exists to pin the boot-time failure mode before wiring the registry, so a missing binary can never become a twenty-five-minute run that dies on its first request.

- [ ] **Step 3: Register `codex` behind a binary probe**

In `orchestrator.config.ts`, add above `adapters()`:

```ts
import { spawnSync } from "node:child_process";

/**
 * Is a binary on PATH?
 *
 * Codex authenticates through `codex login`, cached in `$CODEX_HOME/auth.json`
 * — there is no environment variable to detect, unlike gemini and
 * azure_foundry below. Presence of the binary is the only honest signal.
 */
const binaryExists = (bin: string): boolean =>
  spawnSync("command", ["-v", bin], { shell: true, stdio: "ignore" }).status === 0;
```

and inside `adapters()`, after the gemini block:

```ts
  // Codex CLI. A whole agent like Claude Code, so it runs the stage itself
  // rather than through the shared loop — see core/codex-runner.ts.
  if (binaryExists("codex")) {
    registry.codex = createCodexRunner({ installRoot, skillsDir: "skills" });
  }
```

Import it from the package index:

```ts
import {
  defineOrchestrator, createClaudeRunner, createCodexRunner, createLoopRunner,
  createGeminiProvider, createAzureProvider, type Runner,
} from "./packages/orchestrator/src/index.js";
```

Extend the boot-time error message so an unregistered `codex` says what to do:

```ts
  throw new Error(
    `SCYNE_ADAPTER='${defaultAdapter}' is not registered — available: ${Object.keys(registry).join(", ")}.\n` +
    `  codex needs the CLI on PATH and a login: npm i -g @openai/codex && codex login\n` +
    `  gemini needs GEMINI_API_KEY; azure_foundry needs AZURE_AI_PROJECT_ENDPOINT plus\n` +
    `  AZURE_AI_TOKEN (az account get-access-token --scope https://ai.azure.com/.default) or AZURE_AI_API_KEY.`);
```

- [ ] **Step 4: Confirm the model/effort defaults stay Claude-only**

The existing `defaults` block already guards this:

```ts
    ...(defaultAdapter === "claude_local" ? { model: "claude-sonnet-4-6", effort: "medium" as const } : {}),
```

Leave it. Add `CODEX_MODEL` support only as an explicit opt-in, immediately after:

```ts
    // Codex's own default model unless an operator names one. Naming a model we
    // have not verified it serves is how an entire org's runs die on their
    // first request.
    ...(defaultAdapter === "codex" && process.env.CODEX_MODEL ? { model: process.env.CODEX_MODEL } : {}),
```

- [ ] **Step 5: Verify the server boots on each adapter**

Run:
```bash
npm run typecheck
SCYNE_ADAPTER=codex npx tsx -e "import('./orchestrator.config.ts').then(m => console.log(Object.keys(m.default.adapters)))"
```
Expected: prints a list containing `codex`. If it throws, the binary is not on PATH — that is the correct behaviour, and the message says so.

- [ ] **Step 6: Update CLAUDE.md**

In the **Configuration** section, add to the adapter discussion:

```markdown
**Adapters.** `claude_local` (Claude Code), `codex` (Codex CLI), `gemini` and
`azure_foundry` (both loop-driven). `SCYNE_ADAPTER` picks the org-wide default;
`scyne adapter set <name> --project <p>` overrides it per project, and an agent
or a step can pin its own.

`codex` is registered when the binary is on PATH — auth is `codex login`, not an
API key, so there is nothing in the environment to detect. Install with
`npm i -g @openai/codex && codex login`.

> **Codex reports no cost.** `core/usage.ts` records `total_cost_usd` verbatim
> from Claude Code's result event; Codex emits token counts and no dollar
> figure, so its runs show `—` rather than `$0.00`, the closing comment says
> `cost not reported for N runs`, and **a cost budget cannot fire on a Codex
> run**. Token and duration ceilings still do.
```

Add to the troubleshooting table:

```markdown
| `SCYNE_ADAPTER='codex' is not registered` at boot | The `codex` binary is not on PATH. | `npm i -g @openai/codex && codex login`, then restart. |
| A Codex run's transcript is empty in the console | The decoder did not recognise the event kinds — a Codex version bump. | `npm run orch -- log <runId> --raw` shows the real events; update `decodeCodexLine` in `core/transcript.ts`. Unrecognised events render as framing lines, so an empty transcript means the log itself is empty. |
```

- [ ] **Step 7: Checkpoint**

Stop.

---

### Task 10: End-to-end acceptance

**Files:** none — this is a verification task. Anything it uncovers is fixed in the task that owns the file.

- [ ] **Step 1: Run a real stage on Codex**

```bash
npm test && npm run typecheck
SCYNE_ADAPTER=codex npm run orch -- run datamodel --project SADA --feature interim-benefit
```

- [ ] **Step 2: Verify each claim, with output**

| Claim | Command | Expected |
|---|---|---|
| The document was written | `ls -la projects/SADA/interim-benefit/solutions/DataModel/outputs/` | `salesforce-data-model.md`, non-empty |
| The adapter was recorded | `npm run orch -- runs <SCY-N>` | the run row exists, cost column `—` |
| The transcript renders | `npm run orch -- log <runId>` | assistant text and `run_command` lines, not empty |
| The issue reached its gate | `npm run orch -- gate list` | one pending gate for the issue |
| Claude still works | `SCYNE_ADAPTER=claude_local npm run orch -- run datamodel --project SADA --feature interim-benefit` | same outcome, cost shown in dollars |

- [ ] **Step 3: Report honestly**

Write down what actually happened, including anything that failed. Do not report completion for a step that was skipped.

- [ ] **Step 4: Checkpoint**

Stop. Hand back for review and commit.
