# Scyne Orchestrator — design

**Date:** 2026-08-17
**Status:** Design, awaiting review
**Replaces:** Paperclip, as the orchestration substrate for `requirement-generator`

---

## 1. Why

The client will not run third-party software in their environment, and Scyne wants
to own the orchestrator as a sellable asset rather than a dependency. Both point
the same way: build our own.

The job is smaller than it looks, because **Paperclip owns almost none of the
value**. Everything that makes this product work already lives in this repo — the
eight skills, `scripts/pipeline.mjs`, `scripts/stage.mjs`, the renderers,
`scripts/confluence-attach.mjs`. Paperclip contributes four things:

1. A task database — issues, parent/child, comments, work-products, approval gates
2. An agent registry — name, title, `reportsTo`, adapter config, an AGENTS.md bundle
3. A process spawner — runs `claude -p --output-format stream-json`, captures stdout
4. A wake trigger — issue hits `todo`, fire the assignee

The surface actually consumed is finite:

| Consumer | Surface |
|---|---|
| `scyne-chatbot/server/paperclip.ts` | 18 methods, one 224-line file |
| `scripts/bootstrap.mjs` | 9 endpoints |
| The 11 AGENTS.md bundles | 6 endpoints |
| `scripts/attach-work-product.mjs` | 1 endpoint, fixed payload |

~28 distinct endpoints. Not a platform — an API shape.

## 2. Goals

- A **domain-agnostic, reusable library** for orchestrating Claude Code agents,
  usable in projects other than this one.
- Deterministic sequencing. No LLM is load-bearing for routing or state.
- Full operator console: org, runs (nice + raw), issues, gates, budgets, config,
  skills, instructions, health.
- Real budget tracking — tokens, cost, duration — with enforcement.
- Runs everywhere with no external install.
- The client-facing chatbot keeps working with changes confined to one file.

## 3. Non-goals

- **Not tied to one model vendor.** Seven adapters ship: four process adapters
  (Claude Local, Gemini Local, Cursor, Codex) and three API adapters (Claude API,
  Gemini API, Codex API). See §8A. A consuming project can register further
  adapters without forking.
- **Not a general workflow engine for non-agent work.** Steps run agents, shell
  commands, gates and sub-flows. It does not try to be Airflow.
- **Not multi-process concurrent access** on the default driver. One process owns
  the database.
- Not a replacement for the chatbot's client-facing UI, which already exists and
  stays.

## 4. Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Build our own orchestrator, entirely ours | Client procurement + sellable asset |
| 2 | Keep the full org model — 24 agents, org chart, hire flow, companies layer | It is the product's face and the multi-tenancy story |
| 3 | **Dispatch goes direct to the assignee.** No hierarchical routing | Removes the documented "Delivery Lead does the work itself" failure mode |
| 4 | **The orchestrator sequences deterministically** | `pipeline.mjs` already encodes the graph; code executes it, not an agent |
| 5 | **Thin agents.** The orchestrator owns the issue lifecycle | Removes a state machine currently executed by an LLM on every wake |
| 6 | **Library-first, dual-mode packaging** | Mounted in the chatbot for a one-process client install; standalone for selling |
| 7 | **Postgres dialect, PGlite default** | Deployment mode becomes config, not a rewrite |
| 8 | **Files are the source of truth; the console writes back** | Config travels with the repo — the point of a reusable library |

### 4.1 On decision 3

`OLD_IDS` in `scripts/bootstrap.mjs:79-90` — the fake `aaaaaaa1-…` UUIDs, the
prefix replacement, the "placeholder survived the swap" throw — exists *only* so
the Delivery Lead knows which UUID to dispatch to. Direct dispatch deletes the
entire mechanism. Agents are addressed by stable **config key** (`ba`), never by a
generated UUID.

### 4.2 On "keep the hire workflow"

Decision 2 keeps hiring; §14.1 deletes the "`agent-hires` → PATCH convergence
dance". These are not in conflict, and the distinction matters:

- **The concept is kept.** An agent joins the org, gets a record, appears in the
  console with a title, icon and reporting line, and can be added or disabled
  without touching code. That is the sales surface and it stays.
- **The mechanism changes.** Today hiring is `POST /agent-hires` followed by a
  PATCH of all 24 agents back to spec on every bootstrap, because the database is
  authoritative and drifts from the repo. With files as the source of truth
  (decision 8), adding an agent means adding an entry to `orchestrator.config.ts`;
  the seed reconciles the database to it. No convergence loop, no generated UUID
  to swap, no partial-org failure when one icon is rejected two-thirds down the
  list.

So: hiring as a first-class concept, without the drift-correction machinery that
only exists because the database and the repo disagree.

### 4.3 On decision 5

The 11 bundles total **217,683 chars ≈ 54,000 tokens**, re-read on every wake:

| Bundle | chars | ~tokens |
|---|---:|---:|
| `pm.json` | 42,494 | 10,623 |
| `capabilities-process-architect.json` | 24,390 | 6,097 |
| `service-designer.json` | 20,684 | 5,171 |
| `ba.json` | 18,802 | 4,700 |
| `qa-architect.json` | 18,405 | 4,601 |
| `solution-architect.json` | 18,232 | 4,558 |
| `ux-designer.json` | 18,116 | 4,529 |
| `data-modeler.json` | 16,695 | 4,173 |
| `architect-lead.json` | 16,632 | 4,158 |
| `ui.json` | 13,678 | 3,419 |
| `ux-auditor.json` | 9,555 | 2,388 |

A large share is protocol, not domain knowledge: the BA's bundle opens by teaching
the LLM to `curl` its own issue, inspect `status` + `interactions` + the latest
comment, and branch to Phase 1 or Phase 2. That is a state machine executed by a
language model. Decision 4 also makes most of `pm.json` dead weight.

---

## 5. Architecture

```
packages/orchestrator/            ← the independent library. Knows nothing about
  src/core/                          Salesforce, Confluence, or requirements.
    db.ts          driver abstraction + migrations
    registry.ts    agents/skills mirrored from config files
    engine.ts      the workflow executor
    runner.ts      spawns claude -p, captures stream-json, extracts usage
    transcript.ts  stream-json → events  (moved from the chatbot)
    gates.ts       approval gates
    budgets.ts     limits + rollups
  src/http/
    router.ts      mountable Express Router
    console/       the operator console (single self-contained HTML)
  src/cli.ts       scyne-orchestrator serve | seed | run | runs | prune
  migrations/      NNN_*.sql

requirement-generator/            ← now a CONSUMER
  orchestrator.config.ts          ← the 24 agents + STAGES compiled to workflows
  scripts/pipeline.mjs            ← stays here, unchanged
```

`pipeline.mjs` becomes an *input* to the library rather than part of it.

### 5.1 The consumer config

```ts
// requirement-generator/orchestrator.config.ts
import { defineOrchestrator } from "@scyne/orchestrator";
import { STAGES } from "./scripts/pipeline.mjs";

export default defineOrchestrator({
  workspace: process.cwd(),
  db: { driver: "pglite", dir: ".orchestrator/pgdata" },

  // The adapter registry. The library ships `claude_local`; a consuming project
  // can register its own here and reference it by name from any agent.
  runners: { claude_local: createClaudeRunner() },

  defaults: { adapter: "claude_local", model: "claude-sonnet-4-6", effort: "medium" },

  org: [
    { key: "ceo", name: "CEO", title: "Chief Executive", icon: "crown" },
    { key: "pm",  name: "Delivery Lead", reportsTo: "ceo", icon: "rocket" },
    { key: "ba",  name: "BA", reportsTo: "businessLead", icon: "search",
      adapter: "claude_local",
      model: "claude-sonnet-4-6",
      effort: "medium",
      fallbackModel: ["claude-sonnet-4-5-20250929"],
      bundle: "agent-instructions/ba.md",
      skills: ["requirement-generator"],
      mcp: true,
      budget: { maxTokens: 400_000, maxCostUsd: 5 } },
    // …the other 21
  ],

  workflows: Object.entries(STAGES).map(([key, s]) => ({
    key, label: s.label, assignee: s.agentKey,
    steps: [
      { type: "exec",   cmd: `node scripts/stage.mjs {project} {feature} ${key}` },
      // Per-step overrides: a summary is not an architecture document.
      { type: "agent",  phase: "generate", skill: s.skill,
        model: s.model, effort: s.effort },
      s.then      && { type: "exec",   cmd: s.then },
                     { type: "attach", files: s.produces },
                     { type: "gate",   title: `Approve ${s.label}` },
      s.publishes && { type: "agent",  phase: "publish", effort: "low" },
    ].filter(Boolean),
  })),
});
```

### 5.1.1 Adapter and model resolution

Both resolve the same way, most specific wins:

```
step.adapter → agent.adapter → defaults.adapter → "claude_local"
step.model   → agent.model   → defaults.model   → the CLI's own default
step.effort  → agent.effort  → defaults.effort  → the CLI's own default
```

This matters for cost. The `publish` phase re-reads a finished document and calls
Confluence — it does not need the reasoning budget that generated the document,
so it runs at `effort: "low"`. A capability map across every discovery document
may deserve `xhigh`. One model and one effort level for the whole org is the
expensive default, and it is the one Paperclip left you with.

**These are editable at runtime.** `PATCH /agents/:key` accepts `adapter`,
`model`, `effort`, `fallbackModel` and `budget`, and writes back to
`orchestrator.config.ts` per §11 — so a change made in the console lands in git
rather than drifting in a database.

Everything Salesforce-, Atlassian- or Scyne-specific sits on the consumer side of
that boundary. The library sees agents, steps, gates and runs.

### 5.2 Deployment modes

```ts
// Embedded — the client install. One process, one port.
app.use("/api/orch", createOrchestratorRouter({ config }));

// Standalone — the product, and demos.
$ npx scyne-orchestrator serve --port 3100
```

---

## 6. Storage

One dialect (PostgreSQL), three drivers:

| Driver | Implementation | For |
|---|---|---|
| `pglite` **(default)** | `@electric-sql/pglite` — Postgres as WASM, in-process | Runs everywhere; no binary download |
| `native` | `embedded-postgres` spawns a real server | Local dev wanting a poke-able server |
| `external` | `DATABASE_URL` via `pg` | A client with managed Postgres |

Migrations are numbered `.sql` files applied in order and tracked in
`_migrations`. Identical across all three, because all three are Postgres.

**PGlite constraints, accepted:** single-connection and single-process — both
deployment modes are single-process, so this does not bind; `native`/`external`
are the escape hatch. It pins a Postgres major version, so the schema stays within
it and uses no extensions. Backup is a copy of the data directory.

### 6.1 Schema

```sql
create table companies (
  id          uuid primary key,
  name        text not null unique,
  created_at  timestamptz not null default now()
);

-- Mirrored from the config file. The file is the source of truth.
create table agents (
  id           uuid primary key,
  company_id   uuid not null references companies(id) on delete cascade,
  key          text not null,            -- stable config key ('ba') — dispatch address
  name         text not null,
  title        text,
  icon         text,
  reports_to   uuid references agents(id),
  adapter      text not null default 'claude_local',  -- key into the runner registry
  model        text,
  effort       text,                                  -- low|medium|high|xhigh|max
  fallback_model jsonb not null default '[]',         -- tried in order when overloaded
  cwd          text,
  mcp_enabled  boolean not null default false,
  extra_args   jsonb not null default '[]',
  bundle_path  text,
  status       text not null default 'idle',   -- idle | running | disabled
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (company_id, key)
);

create table skills (
  id             uuid primary key,
  company_id     uuid not null references companies(id) on delete cascade,
  slug           text not null,
  path           text not null,          -- skills/<slug>/SKILL.md
  content_hash   text not null,
  token_estimate int,
  updated_at     timestamptz not null,
  unique (company_id, slug)
);

create table agent_skills (
  agent_id uuid references agents(id) on delete cascade,
  skill_id uuid references skills(id) on delete cascade,
  primary key (agent_id, skill_id)
);

create table issues (
  id                uuid primary key,
  company_id        uuid not null references companies(id) on delete cascade,
  identifier        text not null,       -- SCY-1
  parent_id         uuid references issues(id) on delete cascade,
  title             text not null,
  description       text,
  status            text not null,       -- todo|in_progress|in_review|blocked|done|cancelled
  assignee_agent_id uuid references agents(id),
  workflow_key      text,                -- 'requirements'
  step_index        int  not null default 0,
  params            jsonb not null default '{}',   -- project, feature, keys, instruction
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (company_id, identifier)
);

create table comments (
  id              uuid primary key,
  issue_id        uuid not null references issues(id) on delete cascade,
  author_agent_id uuid references agents(id),
  author_user     text,
  body            text not null,
  created_at      timestamptz not null default now()
);

create table work_products (
  id         uuid primary key,
  issue_id   uuid not null references issues(id) on delete cascade,
  type       text not null,              -- document | preview_url | …
  provider   text not null,              -- local | confluence | jira
  title      text not null,
  url        text not null,
  created_at timestamptz not null default now(),
  unique (issue_id, url)                 -- idempotent re-attach
);

create table gates (
  id            uuid primary key,
  issue_id      uuid not null references issues(id) on delete cascade,
  kind          text not null default 'approval',
  status        text not null default 'pending',  -- pending|approved|rejected|cancelled
  payload       jsonb not null default '{}',      -- {title, summary}
  decision_note text,
  decided_by    text,
  decided_at    timestamptz,
  created_at    timestamptz not null default now()
);

create table runs (
  id                    uuid primary key,
  issue_id              uuid not null references issues(id) on delete cascade,
  agent_id              uuid references agents(id),
  step_index            int,
  phase                 text,            -- generate | publish | <custom>
  status                text not null,   -- running|succeeded|failed|over_budget|orphaned
  started_at            timestamptz not null default now(),
  finished_at           timestamptz,
  exit_code             int,
  log_path              text not null,   -- .orchestrator/runs/<id>.jsonl
  session_id            text,
  input_tokens          bigint,
  output_tokens         bigint,
  cache_read_tokens     bigint,
  cache_creation_tokens bigint,
  cost_usd              numeric(12,6),
  duration_ms           bigint,
  num_turns             int
);

create table budgets (
  id             uuid primary key,
  company_id     uuid not null references companies(id) on delete cascade,
  scope          text not null,          -- agent | workflow | project | company
  scope_key      text not null,          -- 'ba' | 'requirements' | 'RTWSA' | '*'
  max_tokens     bigint,
  max_cost_usd   numeric(12,6),
  max_duration_ms bigint,
  unique (company_id, scope, scope_key)
);
```

Run logs live on disk, not in the database, in the same `{ts, stream, chunk}`
envelope Paperclip emits — so `transcript.ts` works against both during migration.

---

## 7. The workflow engine

### 7.1 Step contract

Five composable primitives. Anything domain-specific is expressed in them.

```ts
type Step =
  | { type: "exec";   cmd: string; cwd?: string; timeoutMs?: number }
  | { type: "agent";  agent?: string; phase: string; skill?: string; prompt?: string }
  | { type: "attach"; files: string[]; cwd?: string }
  | { type: "gate";   title: string; summary?: string }
  | { type: "flow";   workflow: string; params?: Record<string, unknown> };
```

`{project}`, `{feature}`, `{workspace}`, `{issueId}` interpolate from `issue.params`.

> **`attach.cwd` was added after the Task 11 validation run — the step types were
> not sufficient as first specified.** `exec` carried a `cwd` and `attach` did not,
> so there was no first-class way to say "these paths are relative to the feature
> root". The config author had to hand-derive it, and getting it wrong blocked the
> workflow *after* the expensive agent step had already run and been paid for.
> `pipeline.mjs`'s `produces` paths are relative to the stage's own level root by
> documented convention, so all eight remaining stages would have hit the same
> trap. `cwd` interpolates like any other path:
> `cwd: "projects/{project}/{feature}"`.
>
> **A second gap is known and deliberately unaddressed:** no step type can read a
> prior artefact's content into a prompt variable. The revision flow needs exactly
> that — it must hand the previous version of a document to the skill. It is not
> being solved speculatively; the revision flow's own spec should drive its shape.

### 7.2 The loop

```
advance(issueId):
  lock(issueId)
  step = workflow.steps[issue.step_index]
  if !step            -> status = done; return
  switch step.type:
    exec    -> spawn shell; non-zero => block(step, stderr)
    agent   -> create run, spawn; RETURN (re-entered on run exit)
    attach  -> every file must exist (missing => block, naming it); insert work_products
    gate    -> create gate; status = in_review; RETURN (re-entered on decision)
    flow    -> create child issue; RETURN (re-entered on child done)
  issue.step_index++ ; advance(issueId)
```

`advance()` is re-entrant and idempotent, guarded by a per-issue lock. It is
called on: flow start, run exit, gate decision, child completion, and a revision
comment. **There is no heartbeat and no polling.**

### 7.3 What this changes at the `exec` validator step

Today the agent decides whether its own validator passed. In the new model a
non-zero exit from `render-capability-map.mjs --validate-only` or
`validate-experience.mjs` **blocks before the gate is raised** — a human can no
longer be asked to approve output that failed its own contract check.

---

## 8. Agent invocation

The orchestrator builds the prompt; the agent does domain work and exits.

Confirmed against Claude Code **2.1.232**:

```
claude -p
  --output-format stream-json
  --model <resolved model>                         ← step → agent → defaults
  --effort <resolved effort>                       ← low|medium|high|xhigh|max
  --fallback-model <a,b>                           ← when declared
  --system-prompt-file <agent.bundle>
  --permission-mode bypassPermissions
  --strict-mcp-config [--mcp-config .mcp.json]     ← only when the step publishes
  --no-session-persistence
  --exclude-dynamic-system-prompt-sections
  [--include-partial-messages]                     ← for live streaming
```

`--model`, `--effort` and the adapter all resolve per §5.1.1 — most specific
wins. `--fallback-model` takes a comma-separated list, tries each in order and
retries the primary, which is the cheapest available answer to a model being
overloaded mid-pipeline.

The task prompt goes on stdin. **There is no `--cwd` flag** — the working
directory is set through the spawn options, which is what Paperclip's
`adapterConfig.cwd` was doing. `--add-dir` extends access beyond it if needed.

Three flags matter more than they look:

- **`--no-session-persistence`** makes session freshness structural. Two rows in
  this repo's troubleshooting table blame stale sessions, and `forceFreshSession:
  true` is scattered through `server/paperclip.ts` as the workaround. With no
  session written to disk there is nothing to go stale.
- **`--exclude-dynamic-system-prompt-sections`** moves cwd, env, memory paths and
  git status out of the system prompt and into the first user message,
  explicitly to improve cross-user prompt-cache hits. A direct saving on every
  wake, and it compounds with the smaller bundles.
- **`--include-partial-messages`** lets the transcript stream rather than be
  polled every three seconds.

```
Run PHASE generate for workflow `requirements`.
  project: RTWSA   feature: Appeals & Reviews
  Inputs are staged at projects/RTWSA/Appeals & Reviews/requirements/
  Invoke skill: requirement-generator
  Write outputs to outputs/
  Do not call any API. Exit when the files are written.
```

`.claude/skills/` symlinks stay exactly as they are — that mechanism is already
ours and already works.

**Bundles become domain guidance only.** Phase detection, status transitions,
work-product attachment and gate raising all move to the engine.

---

## 8A. Adapters

Seven adapters ship. They fall into two tiers that cost very different amounts to
build, and the distinction is the most important thing in this section.

| Adapter | Tier | Runtime | Status |
|---|---|---|---|
| `claude_local` | process | `claude` 2.1.232 | **Built — reference implementation** |
| `gemini_local` | process | `gemini` 0.46.0 | installed, not built |
| `cursor_agent` | process | `cursor-agent` 2025.09.12 | installed, not built |
| `codex_local` | process | `codex` | **not installed on this machine** |
| `claude_api` | api | Anthropic SDK | key present |
| `gemini_api` | api | `@google/generative-ai` | key present, SDK already a dependency |
| `codex_api` | api | OpenAI SDK | **no `OPENAI_API_KEY` present** |

### 8A.1 Why the tiers differ

A **process adapter** spawns a CLI that is *already* an agentic loop — it reads
files, runs shell commands, calls tools, and stops when done. Our job is to build
the right command line, capture its output, and read its usage. That is what
`claude_local` does today, and the other three CLIs expose the same surface:

| | headless | output format | auto-approve | model |
|---|---|---|---|---|
| `claude` | `-p` | `stream-json` | `--permission-mode bypassPermissions` | `--model` |
| `gemini` | `-p` | `stream-json` | `--approval-mode yolo` | `--model` |
| `cursor-agent` | `-p` | `--output-format` | `-f` / `--force` | `--model` |

An **API adapter** has none of that. A raw model call is prompt in, text out. Our
stages read roughly twenty staged files and write five, so an API adapter can only
run a stage if **we supply the agentic loop ourselves** — the tool set, the
execution, the permission decisions, and the stop condition. That is the bulk of
the work in this section, and it is described in §8A.5.

### 8A.2 The adapter interface

The `Runner` interface built in the prototype grows into `Adapter`:

```ts
export interface Adapter {
  readonly key: string;                    // 'claude_local', 'gemini_api', …
  readonly kind: "process" | "api";

  /** Execute one agent turn. Same contract for both tiers. */
  run(req: RunRequest): Promise<RunResult>;

  /** Make the named skills loadable by this runtime. See §8A.4. */
  materialiseSkills(slugs: string[], workspace: string): Promise<void>;

  /** Normalise this runtime's raw log into the common event shape. See §8A.3. */
  parseTranscript(raw: string): TranscriptEvent[];

  /** What this adapter can and cannot do. See §8A.6. */
  capabilities(): AdapterCapabilities;
}
```

`RunRequest` and `RunResult` are unchanged — they were already vendor-neutral, and
`model` / `effort` / `fallbackModel` already sit at the top level because the
engine resolves them before dispatch.

### 8A.3 Transcript normalisation

Every runtime emits a different log format. `claude` and `gemini` both emit
`stream-json`, but not the same `stream-json`; `cursor-agent` differs again; the
API tier has no stdout at all and must synthesise events from its own loop.

**Each adapter parses its own output into the same `TranscriptEvent[]`.** The
console, the `/runs/:id/transcript` endpoint and the chatbot's Live Transcript
pane stay entirely adapter-agnostic — they consume the normalised shape and never
learn which runtime produced it.

This relocates the Claude parser rather than changing it: `core/transcript.ts`
becomes `adapters/claude-local/transcript.ts`, unchanged. It is a verified
verbatim port of a production module and must stay that way.

### 8A.4 Skills — one source, per-runtime materialisation

This follows what Paperclip does, generalised. Its bundle carries `skillsHome`,
`materializePaperclipSkillCopy` and `materializedSkillFingerprintMatches`: skill
markdown is held centrally, **copied** into each agent's skills home, and a
content fingerprint decides whether a rewrite is needed.

`skills/<slug>/SKILL.md` stays the single source of truth. Each adapter renders it
into its own runtime's convention:

| Adapter | Destination |
|---|---|
| `claude_local` | `.claude/skills/<slug>/` (symlink — as `bootstrap.mjs` already does) |
| `gemini_local` | Gemini's context/extension mechanism |
| `cursor_agent` | `.cursor/rules/<slug>.mdc` |
| `codex_local` | `AGENTS.md` |
| any `*_api` | injected into the system prompt — we own the loop |

A content hash skips unchanged skills, so materialisation is cheap enough to run
before every agent step.

**Why not port each skill to each runtime's native format?** Because eight skills
across seven runtimes is fifty-six artefacts to keep in step, and
`skills/<slug>/SKILL.md` stops being the source of truth. This repo's own
CLAUDE.md records that exact failure already happening once — a stale 157-line
copy of a 199-line skill.

The cost of materialisation is honest and worth stating: outside Claude Code there
is no progressive disclosure, so the whole skill loads every time. For the larger
skills that is 6k+ tokens per run.

### 8A.5 The agentic loop (API tier)

The API adapters share one loop. It is a distinct subsystem and gets its own spec
and its own plan — it is, in effect, a small coding agent.

- **Tools:** `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `bash`.
- **Loop:** call the model → execute any tool calls → feed results back → repeat
  until the model stops or a bound trips.
- **Bounds, all mandatory:** max iterations, max tokens, max cost, max wall-clock.
  An unbounded loop against a paid API is the most expensive bug available here.
- **Provider bindings:** Anthropic tool use, Gemini function calling, OpenAI
  Responses. The tool *definitions* and the executor are shared; only the wire
  format differs per provider.
- **Events:** the loop synthesises `TranscriptEvent`s directly, so §8A.3 holds
  without a parser.

### 8A.6 Capabilities, and refusing work honestly

Adapters are not interchangeable. Declaring that plainly is better than
discovering it mid-run:

```ts
export interface AdapterCapabilities {
  skills: boolean;        // can load a skill natively
  bash: boolean;          // can run shell commands
  fileWrite: boolean;     // can write files in the workspace
  mcp: boolean;           // can load MCP servers
  streaming: boolean;     // emits incremental events
  usage: boolean;         // reports token counts and cost
}
```

A workflow step declares what it needs. **The engine refuses to start a step whose
requirements exceed its adapter's capabilities, and says which capability is
missing** — rather than running it and producing an empty output folder.

This is what makes a heterogeneous registry safe: a stage needing `bash` and
`fileWrite` simply will not dispatch to a one-shot adapter, and the operator is
told why before any tokens are spent.

## 9. Budgets

`scyne-chatbot/server/services/runTranscript.ts:150` currently reads:

```ts
if (type === "result") continue; // final aggregate, redundant with status
```

That `result` event is where Claude Code's `stream-json` reports token usage,
cost, duration and turn count. **The data already flows through the pipe and is
discarded on that line.** Budget tracking is largely a matter of reading it.

- **Capture** per run: input / output / cache-read / cache-creation tokens, cost,
  duration, turns, session id.
- **Roll up** along any axis: run → issue → workflow → project → agent → company.
- **Enforce**: `maxTokens` / `maxCostUsd` / `maxDurationMs` at agent and workflow
  scope. On breach the runner kills the process, marks the run `over_budget`, and
  blocks the issue with a comment naming the limit hit.
- `paperclip.config.json` already declares a `budget` block that nothing enforces.
  This makes it real.

Cost-per-project is a billing input. Today there is no visibility at all, while
~54k tokens of bundle overhead is paid per wake.

---

## 10. Run logs — nice and raw

Two views over one file.

- **Raw** — `.orchestrator/runs/<runId>.jsonl` verbatim, byte-offset paged (keeping
  the existing `{content, nextOffset}` contract), monospace, downloadable.
- **Nice** — parsed events: assistant text, tool calls, skill invocations, tool
  results, thinking. `runTranscript.ts` moves into the library as
  `core/transcript.ts` and stops being chatbot-private.

Toggle per run; filter by event kind; jump to first error. Retention via
`scyne-orchestrator prune`.

Secret redaction (`SENSITIVE_PATTERNS`) moves with the transcript module and
applies to **both** views.

---

## 11. Config, skills, instructions

**Files are the source of truth. The database mirrors them. The console writes
back to disk.**

The alternative — database-authoritative, files as exports — is how Paperclip does
it, and it is the direct cause of the `OLD_IDS` swap and a bootstrap that PATCHes
24 agents back to spec on every run. For a library meant to drop into other
projects, config that lives in git and travels with the repo is the entire point.

| Surface | File | Console shows |
|---|---|---|
| Orchestrator + agent config | `orchestrator.config.ts` | The **effective, resolved** config per agent — model, cwd, MCP, extra args, skills, budget |
| Skills | `skills/<slug>/SKILL.md` | Content, token estimate, grants, last modified, `.claude/skills` symlink health |
| Instructions | `agent-instructions/<agent>.md` | Content, **token cost**, last modified, diff vs git |

The symlink health check matters: `Unknown skill: <slug>` has two rows in this
repo's troubleshooting table.

The instructions view directly serves the migration — the bundles are about to be
cut to domain-only, and a token count per bundle is how we will know it worked.

---

## 12. The console

One self-contained HTML page served by the library, following the house pattern
already established by `scripts/render-companion-app.mjs`: inline CSS and JS, no
build step, no bundler, no version skew. It fetches from the local API.

Served at `/orch` when embedded, and at `/` in standalone mode — so the product
has a face when demoed on its own.

**Tabs:** Org · Runs · Issues · Gates · Budgets · Config · Skills · Instructions · Health

| Tab | Content |
|---|---|
| Org | The chart. Click an agent → config, bundle, skills, run history, spend |
| Runs | Every run, filterable by agent / project / status → nice + raw transcript |
| Issues | Board across all projects |
| Gates | Pending approvals with approve / reject |
| Budgets | Spend by project / agent / workflow, limits, trend |
| Config | Effective resolved config; edit → writes the file |
| Skills | Registry, content, grants, symlink health |
| Instructions | Per-agent bundle, token cost, diff vs git |
| Health | DB, queue depth, orphaned runs, `claude` CLI check |

### 12.1 Theme

The console and the `/docs` page ship with the **Scyne** theme by default, and it
is overridable by the consuming project — the library must not force one client's
branding on another's install.

The palette is the one already curated in `scyne-chatbot/tailwind.config.js`, not
a fresh extraction. Running `scripts/extract-brand.mjs` against
`https://www.scyne.com.au/` on 2026-08-17 confirmed the brand hue independently —
`#464e7e`, from CSS frequency, matching `scyne.ink` exactly. Its other picks were
weaker and are deliberately overridden: `accent #220054` is a gradient stop rather
than a brand accent, `brandDeep` was derived rather than chosen, and `logoText`
fell back to the hostname.

```ts
export const SCYNE_THEME = {
  brand:      "#464E7E",   // confirmed against the live site
  brandDeep:  "#363C63",
  line:       "#E7E9F0",
  accent:     "#C8A878",   // sand
  ink50:      "#EEF0F7",
  ink100:     "#D9DDEB",
  ink200:     "#B6BDD6",
  ink500:     "#5C6593",
  glow:       "#7C82C8",
  success:    "#10B981",
  warning:    "#F59E0B",
  danger:     "#F43F5E",
  info:       "#3B82F6",
  fontFamily: 'Arial, "Helvetica Neue", Helvetica, sans-serif',
  logoText:   "Scyne Orchestrator",
};
```

**Overriding it.** A consuming project passes `theme` in its config, merged over
the defaults, so a partial override only replaces what it names:

```ts
export default defineOrchestrator({
  theme: { brand: "#1f4c71", accent: "#f96c0e", logoText: "Acme Delivery" },
  // …
});
```

Rendered as CSS custom properties on `:root`, so a single token change repaints
the whole console. Three constraints carry over from the rest of this repo:

- **No web fonts.** The stack is Arial / Helvetica Neue / Helvetica, which is what
  the chatbot uses and needs no network request.
- **Light and dark.** Tokens are defined on bare `:root` and redefined under
  `@media (prefers-color-scheme: dark)`. `scripts/audit-a11y.mjs` documents that
  headless Chrome defaults to dark and that a palette can pass one state while
  failing another — so both are defined explicitly rather than inherited.
- **Zero network requests.** Same rule as `render-companion-app.mjs`. The logo is
  inlined as a data URI or rendered as a wordmark.

The **client-facing** UI is unchanged. `LiveTranscript`, `RunsPanel`,
`HistoryView`, `ActivityTimeline`, `ApprovalCard`, `ProgressPanel` and
`ArtifactsPreview` all read through `server/paperclip.ts`; swapping that one file
keeps every screen working.

---

## 13. HTTP API and documentation

Everything is reachable over HTTP. The library must drop into another project
without anyone explaining it, which makes the documentation a deliverable rather
than an afterthought.

Named honestly, since we own it now. `getInteractions()`'s normalisation layer
(`paperclip.ts:141-159`) disappears.

```
GET    /health

GET    /agents                       GET /agents/:key
PATCH  /agents/:key                  adapter · model · effort · fallbackModel · budget
GET    /agents/:key/runs
GET    /runners                      registered adapters
GET    /agents/:key/instructions     PUT /agents/:key/instructions
GET    /skills                       GET /skills/:slug     PUT /skills/:slug

POST   /issues                       GET /issues           GET /issues/:id
PATCH  /issues/:id
GET    /issues/:id/comments          POST /issues/:id/comments
GET    /issues/:id/work-products     POST /issues/:id/work-products
GET    /issues/:id/gates
POST   /gates/:id/approve            POST /gates/:id/reject

GET    /issues/:id/runs
GET    /runs/:id
GET    /runs/:id/log?offset=         (raw)
GET    /runs/:id/transcript?offset=  (nice)

GET    /budgets                      PUT /budgets/:scope/:key
GET    /usage?groupBy=project|agent|workflow&from=&to=
GET    /config                       (effective, resolved)
GET    /openapi.json                 (the contract)
GET    /docs                         (rendered reference)
```

### 13.1 OpenAPI is the contract

`openapi.yaml` ships in the package as OpenAPI 3.1 — every route, every request
and response schema, every error shape, with examples.

**A contract test asserts the router and the specification agree.** Documentation
drifting from implementation is the normal way API docs die; a test that fails
when a route changes without its schema is what prevents it. The TypeScript client
types are generated from the same file, so a drift breaks compilation too.

### 13.2 Docs ship with the running service

`GET /docs` serves a rendered API reference — inlined, no CDN, consistent with the
zero-network-request rule the rest of this repo follows. A new project points a
browser at `http://localhost:3100/docs` and has the whole surface, live, against
its own data.

### 13.3 A generated, typed client

`@scyne/orchestrator/client`, generated from the OpenAPI file. The chatbot's
rewritten `server/paperclip.ts` becomes a thin wrapper over it — or disappears
into it entirely.

### 13.4 The integration guide

Written documentation shipped in the package:

| Document | Answers |
|---|---|
| Quickstart | Install, define one agent, define one workflow, run it |
| Config reference | Every option accepted by `defineOrchestrator` |
| Step reference | The five step types, interpolation, failure semantics, re-entrancy |
| Agent authoring | What belongs in a bundle now the engine owns the lifecycle |
| Deployment | The three database drivers; embedded versus standalone |
| Adoption guide | Adding the orchestrator to an existing project |

**Acceptance criterion, and it is checkable:** the quickstart must work from a
clean directory, on a machine that has never seen this repository, with no
reference to `requirement-generator` anywhere in it. If following it requires
asking us a question, the documentation is not finished.

---

## 14. Migration

Risk is front-loaded: the single largest unknown (the Claude Code flag surface) is
resolved on day one, and every phase ships something usable.

**Each phase gets its own implementation plan.** This spec is deliberately larger
than one plan's worth of work — the four phases are independently shippable and
should be planned one at a time, so that what is learned in phase 1 (especially
the open items in §17) informs the plan for phase 2 rather than invalidating it.

| Phase | Work | Exit criterion |
|---|---|---|
| **1** | Library core, engine, runner, PGlite, migrations, CLI. Rewrite **one** bundle (BA) to domain-only. | `scyne-orchestrator run requirements --project RTWSA --feature X` produces the same outputs Paperclip does, with usage captured |
| **2** | Rewrite the remaining 10 bundles. All stages runnable from the CLI. | Every stage in `pipeline.mjs` runs end to end |
| **3** | Mount the router; rewrite `server/paperclip.ts`; switch the chatbot behind an env flag. Minimal console (Runs, Health) for debugging. | The chatbot drives a full project with Paperclip stopped |
| **4** | Full console. Delete the Paperclip dependency; `bootstrap.mjs` becomes a seed script. | Paperclip uninstalled; `docker-compose` no longer references it |

`scyne-chatbot/server/index.ts` (2,237 lines) is not rewritten. Changes are
confined to `server/paperclip.ts` (224 lines) plus shape adjustments where the new
API is named differently.

`scripts/sync-bundles.mjs` already round-trips the bundles between JSON and
markdown, which makes the phase 1–2 rewrites ordinary markdown editing.

### 14.1 Deleted outright

- The `OLD_IDS` placeholder swap and the "placeholder survived" throw
- Icon-enum validation against a remote server
- The `agent-hires` → PATCH convergence dance
- Heartbeat configuration
- The phase-detection state machine in all 11 bundles
- `getInteractions()` normalisation in the chatbot

---

## 15. Error handling

| Failure | Behaviour |
|---|---|
| `exec` step non-zero | Issue `blocked`; step name + stderr tail as a comment |
| `then` validator non-zero | `blocked`, **no gate raised** |
| Agent process non-zero | Run `failed`; issue `blocked`; stderr tail as a comment |
| A file in `attach.files` missing | `blocked`, naming the missing file |
| Budget breached | Process killed; run `over_budget`; issue `blocked` naming the limit |
| Orchestrator restarts mid-run | Runs with `started_at` and no `finished_at` marked `orphaned`; issue returned to `todo` |
| Gate rejected with feedback | Comment recorded; `step_index` rewound to the generating step; re-run |

Every block writes a comment. The chatbot's activity timeline surfaces it with no
change.

---

## 16. Testing

- **Engine tests against a fake runner** — no `claude` spawn. Every step type,
  every transition, every failure path, budget enforcement, orphan recovery. Runs
  in milliseconds.
- **Contract test** — every workflow in `orchestrator.config.ts` compiles to valid
  steps and references a real agent key.
- **Migration test** — migrations apply from empty on all three drivers.
- **Runner integration test** — one real `claude -p` invocation; asserts the
  transcript parses and usage is captured.
- **Golden test** — run `requirements` against a fixture project; assert every
  `produces[]` path exists and is non-empty.

---

## 17. Open items

Each is resolved inside phase 1, before anything is built on top of it.

1. ~~**The Claude Code headless flag surface.**~~ **RESOLVED 2026-08-17** against
   Claude Code 2.1.232 — see §8. Every flag the design needs exists, and there is
   no `--cwd` (the working directory is a spawn option). This was the only
   material unknown; the design has no remaining blocking question.
2. **The `result` event field names** for usage and cost. The aggregate is
   unambiguously present; the exact keys need confirming against a real log.
3. **`produces[]` completeness** across all nine stages. The stages inspected
   declare outputs precisely; the remainder were not checked.
4. **PGlite's Postgres major version** versus anything in the schema. Nothing in
   §6.1 looks exotic, but it should be confirmed rather than assumed.
5. **Skill resolution under our runner** — `.claude/skills/` should resolve
   identically since the mechanism is Claude Code's, not Paperclip's. Verify in
   phase 1.

---

## 18. Risk

The failure mode of a reusable library is abstracting for imagined consumers and
getting the joints wrong.

The discipline that prevents it: **build the library generic in shape, but prove
it against exactly one consumer before claiming it is reusable.** If
`requirement-generator` cannot express itself cleanly in the five step types, the
step types are wrong and we fix them then — not after a second project has bent
itself around them.
