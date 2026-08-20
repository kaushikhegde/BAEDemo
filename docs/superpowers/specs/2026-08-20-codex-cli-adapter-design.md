# Codex CLI adapter — design

**Date:** 2026-08-20
**Status:** Design, awaiting review
**Sibling specs:** `2026-08-20-azure-devops-publishing-design.md`, `2026-08-20-super-admin-tracking-design.md`

---

## 1. Why

Every agent step currently spawns Claude Code. We want Codex CLI to run the
same stages, addressed as an ordinary adapter so a project, an agent or a
single step can be pointed at either one without a code change.

Codex is a *whole agent*, like Claude Code and unlike Gemini/Azure: it reads,
writes and runs commands for itself. So it belongs beside `createClaudeRunner`,
NOT behind `createLoopRunner` — the loop runner exists to supply the agency a
bare chat API lacks, and wrapping Codex in it would be re-implementing what the
binary already does.

**Auth is `codex login`** (ChatGPT account, cached in `$CODEX_HOME/auth.json`),
not an API key. `CODEX_CLI` in `.env` is an 84-char base64url token — the same
shape as `MCP_TOKEN_FOR_AZURE` and not an OpenAI key — so nothing reads it.

## 2. What Codex gives us, mapped to what the runner needs

Verified against `@openai/codex@0.148.0`:

| Need | Claude Code | Codex |
|---|---|---|
| non-interactive | `-p` | `exec` |
| machine-readable stream | `--output-format stream-json --verbose` | `--json` (JSONL) |
| prompt off argv | stdin | stdin (omit the `[PROMPT]` arg) |
| working root | process cwd | `-C, --cd <DIR>` |
| let it write | `--permission-mode bypassPermissions` | `-s workspace-write` |
| no session litter | `--no-session-persistence` | `--ephemeral` |
| ignore the developer's own config | `--strict-mcp-config` | `--ignore-user-config` |
| model | `--model` | `-m, --model` |
| reasoning effort | `--effort` | `-c model_reasoning_effort="high"` |
| MCP servers | `--mcp-config <file>` | `-c mcp_servers.<n>.command=…` (repeatable) |
| system prompt | `--system-prompt-file` | **no equivalent** — see §4 |
| final message | last `result` event | `-o, --output-last-message <FILE>` |

Two consequences fall out of that table and drive the rest of this design: there
is no system-prompt file, and MCP is per-invocation config rather than a file
path.

## 3. Shape

```
core/spawn.ts        NEW   the child-process machinery both runners share
core/runner.ts       EDIT  createClaudeRunner keeps buildArgs, loses the plumbing
core/codex-runner.ts NEW   createCodexRunner + buildCodexArgs
core/prompt.ts       NEW   buildSystemPrompt, moved out of agent-loop.ts
core/usage.ts        EDIT  extractCodexUsage beside extractUsage
core/transcript.ts   EDIT  decoder chosen by the run's adapter
```

### 3.1 Extract the spawn machinery first

`createClaudeRunner` is ~200 lines, of which only `buildArgs`, the usage
extraction and the stdin write are Claude-specific. The rest — separate
stdout/stderr line buffering (whose absence corrupted transcripts once already),
the JSONL envelope log, the SIGTERM-then-SIGKILL duration ceiling, `resolveOnce`
— is adapter-neutral and must not be copy-pasted. `core/spawn.ts` exports it;
both runners become a `buildArgs` + a usage extractor over the top.

This is a prerequisite, not a nice-to-have: two divergent copies of the line
buffering is how the transcript-corruption bug comes back on one adapter only.

### 3.2 The system prompt goes into the prompt

Codex has no `--system-prompt-file`, so the agent's `agent-instructions/<agent>.thin.md`
and the step's `SKILL.md` are prepended to the text written on stdin.

`buildSystemPrompt` already exists, private, in `agent-loop.ts:108`, and already
frames a skill for a non-Claude agent. It moves to `core/prompt.ts` and is shared
by the loop runner and the Codex runner, so all three non-Claude paths frame a
skill identically. `skills.ts:skillFilePath` resolves the `SKILL.md`; a missing
one throws `Unknown skill: <slug>` — the same words Claude Code uses, because
every runbook in this repo greps for that string.

`.claude/skills/` is irrelevant to Codex. `npm run link-skills` stays for
interactive Claude Code sessions only.

### 3.3 MCP without a config file

`agent.mcpEnabled` keeps its meaning. The runner reads the SAME `.mcp.json` the
Claude runner passes as a path and expands each server into `-c` overrides:

```
-c mcp_servers.ado.command="npx"
-c 'mcp_servers.ado.args=["-y","@azure-devops/mcp","<org>"]'
```

One source of truth for MCP configuration, two argument shapes. `--ignore-user-config`
is always passed alongside, so a developer's personal `~/.codex/config.toml`
can never leak into a run — the same guarantee `--strict-mcp-config` gives today.

### 3.4 Cost is not reported, and must not read as zero

`usage.ts` reads `total_cost_usd` off Claude Code's final `result` event and
records it verbatim; CLAUDE.md is explicit that this repo holds no price table.
Codex reports token counts and no dollar figure. Therefore:

- `runs.cost_usd` is **null** for a Codex run, and the console renders `—`,
  exactly as it does for a model the Claude CLI cannot price.
- The engine's closing comment says `cost: not reported by adapter 'codex'`
  rather than `$0.00`. A run that silently reads as free is worse than one that
  admits it does not know.
- **The cost ceiling cannot fire on Codex.** Token and duration ceilings still
  do. This is a real reduction in protection and is called out in the Budgets
  tab beside any workflow whose resolved adapter reports no cost.

Adding a price table is explicitly out of scope; it is a separate decision about
whether this repo wants to own pricing data that goes stale.

### 3.5 The event decoder, and a column that has to exist

`transcript.ts:filterRunLog` parses Claude stream-json event kinds. Codex emits
its own JSONL vocabulary, so the decoder must be selected per run — and there is
nothing on `runs` to select it by. `runs.agent_id → agents.adapter` cannot
answer: migration 003 deliberately nulled that column so the configured default
would apply.

**`alter table runs add column adapter text;`** — written by the engine from
`resolveRuntime`, which is the only place that knows the answer. It lands in
migration `004` (shared with the super-admin spec).

It also repairs something already broken: `platform.spend(companyId, "adapter")`
groups by `a.adapter`, which 003 set to null for every agent, so the by-adapter
spend view currently returns a single null row. It should group by `r.adapter`.

The decoder itself is written against a **captured first run**, not from
documentation: the first Codex run is made with the raw log kept, the event
kinds read off it, and the decoder written to match. Unknown kinds pass through
as raw text rather than being dropped, so a Codex version bump degrades the
transcript instead of emptying it.

### 3.6 Registration

```ts
// orchestrator.config.ts
if (binaryExists("codex")) registry.codex = createCodexRunner({ installRoot });
```

`binaryExists` is a `spawnSync` PATH probe in the consumer config, not in the
library — presence of the binary, not an env var, because auth lives in
`auth.json` and there is nothing in the environment to detect. When `SCYNE_ADAPTER=codex` and
the binary is absent, the existing boot-time throw names the fix:
`npm i -g @openai/codex && codex login`.

`claude_local` stays registered. The `defaults` block's `model`/`effort` are
Claude's vocabulary and keep being passed only when the resolved adapter is
`claude_local`; Codex takes `CODEX_MODEL` if set and otherwise its own default —
naming a model we have not verified it serves is how a whole org's runs die on
their first request.

That is about the *defaults*, not about the mapping in §2: an explicit `model`
or `effort` on a step or an agent is an operator's deliberate pin and is still
translated to `-m` / `-c model_reasoning_effort`.

## 4. Testing

`test/codex-runner.test.ts`, mirroring `runner.test.ts`:

- `buildCodexArgs` — every row of the §2 table, including MCP expansion and the
  absence of `-m` when no model is configured.
- Interleaved stderr does not splice bytes into an open stdout line (the pinned
  regression from `runner.test.ts`).
- The duration ceiling SIGTERMs then SIGKILLs, and the run records `over_budget`.
- `extractCodexUsage` against a **real captured** JSONL fixture, not a
  hand-written one.
- A run whose usage carries no cost records `cost_usd = null`, and the closing
  comment says so rather than `$0.00`.

`config.test.ts`: an agent naming `codex` with the adapter unregistered still
fails `validateConfig` at boot with the available list.

**End-to-end acceptance:** `SCYNE_ADAPTER=codex npm run orch -- run datamodel
--project <p> --feature <f>` produces `salesforce-data-model.md`, the transcript
renders in the console, and the issue reaches its gate.

## 5. Risks

| Risk | Handling |
|---|---|
| Codex JSONL vocabulary differs by version | Decoder written from a captured run; unknown kinds pass through as raw text |
| `workspace-write` sandbox blocks a legitimate write | `--add-dir` for anything outside the work root; the alternative (`--dangerously-bypass-approvals-and-sandbox`) is not used |
| `codex login` expires on the host | The run fails fast with the CLI's own auth error; no retry, because `retry.ts` only retries runs that demonstrably spent nothing — an auth failure qualifies and will retry once, then block |
| Reasoning-effort key name unverified | `-c model_reasoning_effort` is asserted by a test that runs `codex exec --help`; if it moves, effort is dropped rather than passed blind |

## 6. Out of scope

A price table for Codex. Removing `claude_local`. Changing any `SKILL.md`.
