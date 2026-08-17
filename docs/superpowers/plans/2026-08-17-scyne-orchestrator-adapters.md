# Scyne Orchestrator — Multi-Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Grow the orchestrator from one runtime to seven — Claude Local, Gemini Local, Cursor, Codex, Claude API, Gemini API, Codex API — behind a single `Adapter` interface, with a conformance suite that every adapter must pass.

**Architecture:** Two tiers. **Process adapters** wrap a CLI that is already an agentic loop; the shared subprocess machinery (spawn, tee, line-buffering, kill, budgets, idempotent resolution) already exists and is reused verbatim, so each one is only `buildArgs` + `extractUsage` + `parseTranscript` + `materialiseSkills`. **API adapters** get raw model access, so we supply the agentic loop — tools, executor, bounds — shared across all three providers.

**Tech Stack:** Node 24 · TypeScript 5.7 · ESM · Vitest · `claude` 2.1.232 · `gemini` 0.46.0 · `cursor-agent` 2025.09.12 · Anthropic / Google / OpenAI SDKs

**Spec:** [`docs/superpowers/specs/2026-08-17-scyne-orchestrator-design.md`](../specs/2026-08-17-scyne-orchestrator-design.md) §8A

**Predecessor:** [`2026-08-17-scyne-orchestrator-prototype.md`](2026-08-17-scyne-orchestrator-prototype.md). Tasks 1, 2, 4, 5, 6 are complete. **This plan starts only after that plan's remaining tasks (3, 7, 8, 9, 10, 11, 12) land** — the Claude spine is the reference every adapter conforms to, and Task 11's SAPN_DEMO run becomes the conformance benchmark.

## Global Constraints

- **NEVER run `git commit`, `git add`, or any git write operation.** The user commits their own work. Every task ends with a verification checkpoint.
- ESM only. Node ≥ 24. No `any` in exported signatures. Australian English.
- **The core must never import from a specific adapter.** Dependencies point inward: `adapters/* → core/*`, never the reverse. A test enforces this (Task A4).
- `npx tsc --noEmit` must exit 0 after every task.
- **No adapter may be declared working without passing the conformance suite** (Task A4). "It ran once" is not evidence.
- **Real API calls cost money.** Every adapter gets a fake binary or a stubbed transport for its unit tests. Live calls happen once per adapter, deliberately, in its validation step.

## Known blockers — do not silently work around

| Blocker | Effect | Handling |
|---|---|---|
| `codex` CLI not installed | `codex_local` cannot be validated | Build it, mark `verified: false`, skip its live test with a named reason |
| No `OPENAI_API_KEY` | `codex_api` cannot be validated | Same |

An adapter that has never been run against its real runtime **must** report `verified: false` from `capabilities()`. Shipping an unverified adapter as though it were tested is the single most damaging thing this plan could do.

---

## File Structure

```
packages/orchestrator/src/
  core/
    adapter.ts          the Adapter interface, AdapterCapabilities, registry types
    subprocess.ts       EXTRACTED from runner.ts — spawn, tee, line-buffer, kill,
                        budgets, idempotent resolve. Runtime-agnostic.
    skills.ts           materialisation contract + content fingerprinting
    agentic/
      tools.ts          read_file, write_file, edit_file, glob, grep, bash
      executor.ts       executes a tool call against the workspace, bounded
      loop.ts           provider-agnostic agentic loop
  adapters/
    claude-local/       buildArgs · extractUsage · transcript · skills
    gemini-local/
    cursor-agent/
    codex-local/
    claude-api/         provider binding only — loop is shared
    gemini-api/
    codex-api/
  test/
    conformance/        ONE suite, run against every registered adapter
```

**Responsibility boundary:** `core/subprocess.ts` knows how to run a child process and capture it safely. It knows nothing about Claude. Each `adapters/<name>/` knows one runtime's flags, usage shape and log format, and nothing about orchestration.

---

## Task A1: The Adapter interface and capability model

**Files:**
- Create: `src/core/adapter.ts`
- Create: `test/adapter.test.ts`
- Modify: `src/config.ts` — `runners` becomes `adapters: Record<string, Adapter>`

**Interfaces:**
- Produces: `Adapter`, `AdapterCapabilities`, `AdapterKind`, `resolveCapabilities`, `assertCapable`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { assertCapable, type AdapterCapabilities } from "../src/core/adapter.js";

const caps = (o: Partial<AdapterCapabilities> = {}): AdapterCapabilities => ({
  skills: true, bash: true, fileWrite: true, mcp: true,
  streaming: true, usage: true, verified: true, ...o,
});

describe("assertCapable", () => {
  it("passes when the adapter meets every requirement", () => {
    expect(() => assertCapable("gemini_local", caps(), { bash: true, fileWrite: true })).not.toThrow();
  });

  it("names the missing capability, the adapter, and the requirement", () => {
    expect(() => assertCapable("one_shot", caps({ bash: false }), { bash: true }))
      .toThrow(/adapter 'one_shot'.*cannot 'bash'/i);
  });

  it("reports every missing capability at once, not just the first", () => {
    try {
      assertCapable("one_shot", caps({ bash: false, fileWrite: false }), { bash: true, fileWrite: true });
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e.message).toMatch(/bash/);
      expect(e.message).toMatch(/fileWrite/);
    }
  });

  it("ignores requirements the step did not ask for", () => {
    expect(() => assertCapable("a", caps({ mcp: false }), { bash: true })).not.toThrow();
  });

  it("treats an unverified adapter as usable but flags it", () => {
    // `verified` describes evidence, not capability — it must never block dispatch.
    expect(() => assertCapable("codex_local", caps({ verified: false }), { bash: true })).not.toThrow();
  });
});
```

> The last test encodes a real decision: `verified: false` is a **reporting** flag, not a gate. Blocking on it would make an unbuilt adapter indistinguishable from a broken one.

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd packages/orchestrator && npx vitest run test/adapter.test.ts` — FAIL, module not found.

- [ ] **Step 3: Implement `adapter.ts`**

```ts
import type { RunRequest, RunResult } from "./subprocess.js";
import type { TranscriptEvent } from "./transcript-types.js";

export type AdapterKind = "process" | "api";

export interface AdapterCapabilities {
  skills: boolean;      // can load a skill in its own runtime
  bash: boolean;        // can run shell commands
  fileWrite: boolean;   // can write files in the workspace
  mcp: boolean;         // can load MCP servers
  streaming: boolean;   // emits incremental events
  usage: boolean;       // reports token counts and cost
  /** False when this adapter has never been exercised against its real runtime. */
  verified: boolean;
}

export type CapabilityRequirement = Partial<Omit<AdapterCapabilities, "verified">>;

export interface Adapter {
  readonly key: string;
  readonly kind: AdapterKind;
  capabilities(): AdapterCapabilities;
  run(req: RunRequest): Promise<RunResult>;
  materialiseSkills(slugs: string[], workspace: string): Promise<void>;
  parseTranscript(raw: string): TranscriptEvent[];
}

export function assertCapable(
  key: string, caps: AdapterCapabilities, need: CapabilityRequirement,
): void {
  const missing = (Object.keys(need) as Array<keyof CapabilityRequirement>)
    .filter((k) => need[k] && !caps[k]);
  if (missing.length) {
    throw new Error(
      `adapter '${key}' cannot '${missing.join("', '")}' — this step requires it. ` +
      `Choose an adapter that does, or remove the requirement from the step.`,
    );
  }
}
```

- [ ] **Step 4: Update `config.ts`** — rename `runners` to `adapters`, typed `Record<string, Adapter>`. Update `validateConfig` to check adapter keys as before, and additionally reject a workflow step whose `requires` names a capability its resolved adapter lacks.

- [ ] **Step 5: Run the full suite** — all green, `tsc --noEmit` exit 0.

- [ ] **Step 6: Checkpoint.** Report the suite result and confirm nothing outside `adapter.ts`, `config.ts` and their tests changed.

---

## Task A2: Extract the shared subprocess machinery

**Files:**
- Create: `src/core/subprocess.ts` — extracted from `src/core/runner.ts`
- Create: `src/adapters/claude-local/index.ts`, `build-args.ts`, `extract-usage.ts`, `transcript.ts`
- Move: `src/core/transcript.ts` → `src/adapters/claude-local/transcript.ts`
- Move: `src/core/usage.ts` → `src/adapters/claude-local/extract-usage.ts`
- Create: `src/core/transcript-types.ts` — the shared `TranscriptEvent` union
- Delete: `src/core/runner.ts` (its contents split between the two above)
- Modify: the existing runner/usage/transcript tests to follow their modules

**This is a refactor with zero behaviour change.** The test suite is the proof: every existing test must still pass, unmodified except for import paths.

- [ ] **Step 1: Create `transcript-types.ts`**

Move the `TranscriptEvent` union out of the Claude transcript module into `core/`, unchanged. This is the shared shape every adapter normalises into. Nothing else moves.

- [ ] **Step 2: Extract `subprocess.ts`**

Take from `runner.ts`, unchanged: `RunRequest`, `RunResult`, the spawn, the per-stream line buffering, the `{ts,stream,chunk}` envelope, residue flushing, the SIGTERM→5s→SIGKILL kill path, `BACKSTOP_DURATION_MS`, budget evaluation, and the `settled`/`resolveOnce` idempotency guard.

Its one new parameter is what makes it generic:

```ts
export interface SubprocessSpec {
  bin: string;
  args: string[];
  cwd: string;
  logPath: string;
  /** Adapter-supplied. Receives the captured stdout, returns normalised usage. */
  extractUsage: (stdout: string) => RunUsage | null;
  /** How the prompt reaches the process. Claude and Gemini use stdin; others may not. */
  promptDelivery: { via: "stdin" } | { via: "arg"; flag: string };
  budget?: RunBudget;
}

export function runSubprocess(spec: SubprocessSpec, prompt: string): Promise<RunResult>;
```

> Two Critical bugs were fixed in this code — stdout/stderr interleaving that silently erased transcript content, and an unguarded async path that hung the runner and crashed the process. **Do not rewrite it. Move it.** Every adapter inherits those fixes for free, and re-deriving them per adapter is how they come back.

- [ ] **Step 3: Build `adapters/claude-local/`**

`build-args.ts` gets the existing `buildArgs` verbatim (including `--verbose`). `extract-usage.ts` gets the existing `usage.ts` verbatim. `transcript.ts` gets the existing transcript module verbatim. `index.ts` assembles them into an `Adapter`:

```ts
export const claudeLocal: Adapter = {
  key: "claude_local",
  kind: "process",
  capabilities: () => ({
    skills: true, bash: true, fileWrite: true, mcp: true,
    streaming: true, usage: true, verified: true,
  }),
  run: (req) => runSubprocess({
    bin: "claude",
    args: buildArgs(req),
    cwd: req.cwd,
    logPath: req.logPath,
    extractUsage,
    promptDelivery: { via: "stdin" },
    budget: req.budget,
  }, req.prompt),
  materialiseSkills: materialiseClaudeSkills,   // Task A3
  parseTranscript: (raw) => filterRunLog(raw).events,
};
```

- [ ] **Step 4: Update every existing test's import paths.** Change nothing else in them. If a test needs its *assertions* changed, the refactor altered behaviour — stop and report.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run` — must be **38 passed / 1 skipped**, exactly as before. Any change in that number means behaviour moved.

- [ ] **Step 6: Checkpoint.** Report the before/after test counts and confirm they match.

---

## Task A3: Skills materialisation

**Files:**
- Create: `src/core/skills.ts`, `src/adapters/claude-local/skills.ts`
- Create: `test/skills.test.ts`

**Interfaces:**
- Produces: `readSkill(slug, workspace)`, `skillFingerprint(content)`, `materialiseToDir()`, `materialiseToFile()`

- [ ] **Step 1: Write the failing tests**

Cover: a skill materialises to the expected location; a second call with unchanged content performs **no write** (fingerprint hit); changed content **does** rewrite; a missing skill throws naming the slug and the path searched.

The no-rewrite assertion needs real evidence, not a mock — compare the destination's `mtimeMs` before and after, having slept past filesystem granularity.

- [ ] **Step 2: Implement `core/skills.ts`**

Source of truth is `skills/<slug>/SKILL.md` relative to the workspace. `skillFingerprint` is a SHA-256 of the content. Provide two materialisation primitives, since adapters need different shapes:

- `materialiseToDir(slug, content, destDir)` — one directory per skill (Claude)
- `materialiseToFile(slugs, contents, destFile, header)` — many skills concatenated into one file (Codex `AGENTS.md`, Cursor rules)

Both write a `.fingerprint` sidecar and skip when it matches.

- [ ] **Step 3: Implement `adapters/claude-local/skills.ts`**

Symlink `skills/<slug>` into `<workspace>/.claude/skills/<slug>`, matching what `scripts/bootstrap.mjs` already does. Symlink rather than copy: this repo's CLAUDE.md records a copy silently drifting into a stale 157-line version of a 199-line skill.

- [ ] **Step 4: Run the tests. Step 5: Checkpoint.**

---

## Task A4: The conformance suite

**Files:**
- Create: `test/conformance/adapter-contract.ts` — the reusable suite
- Create: `test/conformance/claude-local.test.ts`
- Create: `test/boundaries.test.ts` — extend with the adapter direction rule

**This is the most important task in the plan.** It is the only thing that keeps seven adapters honest as they diverge.

- [ ] **Step 1: Write the contract suite**

```ts
export function describeAdapterContract(
  name: string,
  makeAdapter: () => Adapter,
  opts: { live: boolean; fakeBin?: string },
) {
  describe(`adapter contract: ${name}`, () => {
    it("declares a key and kind matching its registration", ...);
    it("declares capabilities including `verified`", ...);
    it("parseTranscript returns [] for empty input and never throws on malformed input", ...);
    it("parseTranscript normalises to the shared TranscriptEvent shape", ...);
    it("materialiseSkills is idempotent — a second call writes nothing", ...);
    it("run() resolves rather than hanging when the runtime is missing", ...);
    it("run() writes a log file parseable by its own parseTranscript", ...);
    it("run() reports usage when capabilities().usage is true", ...);
    it("run() honours a duration budget and reports over_budget", ...);
    describe.skipIf(!opts.live)("live", () => {
      it("completes a trivial real task and reports non-zero output tokens", ...);
    });
  });
}
```

Every adapter file is then three lines: import the contract, supply a factory, declare whether live tests may run.

- [ ] **Step 2: Apply it to `claude_local`** with `live: !!process.env.ORCH_E2E`. It must pass — it is the reference.

- [ ] **Step 3: Extend the boundary test**

Assert no file under `src/core/` imports from `src/adapters/`. Dependencies point inward only. This is the rule that stops the core quietly re-acquiring Claude assumptions.

- [ ] **Step 4: Run everything. Step 5: Checkpoint** — report which contract tests `claude_local` passes, and confirm the boundary test fails if you temporarily add a core→adapter import.

---

## Task B1: `gemini_local`

**Files:** `src/adapters/gemini-local/{index,build-args,extract-usage,transcript,skills}.ts`, `test/conformance/gemini-local.test.ts`, `fixtures/fake-gemini.mjs`

**Confirmed CLI surface** (`gemini` 0.46.0, verified on this machine):

```
-p, --prompt              headless
-o, --output-format       text | json | stream-json
-y, --yolo                auto-approve all actions
    --approval-mode       default | auto_edit | yolo | plan
-m, --model
    --include-directories
-e, --extensions
```

- [ ] **Step 1: Capture a real `result`-equivalent event.** Run `gemini -p "Reply with exactly: ok" -o stream-json --approval-mode yolo` and save the raw output to `fixtures/gemini-stream.jsonl`. **Inspect it before writing any parser.** Gemini's `stream-json` is not Claude's — do not assume field names. Report the actual shape.
- [ ] **Step 2:** Write `extract-usage.ts` against the captured fixture, mapping into the shared `RunUsage` shape.
- [ ] **Step 3:** Write `transcript.ts` normalising Gemini's events into the shared `TranscriptEvent` union.
- [ ] **Step 4:** Write `build-args.ts` and a `fake-gemini.mjs` mirroring `fake-claude.mjs`'s modes.
- [ ] **Step 5:** Skills — materialise into Gemini's context mechanism. Determine empirically which it reads (`GEMINI.md`, `.gemini/`, or an extension) and record the evidence.
- [ ] **Step 6:** Wire the conformance suite with `live: true`. **All contract tests must pass.**
- [ ] **Step 7: Checkpoint** — report the captured usage shape, the skills mechanism found, and the contract results.

---

## Task B2: `cursor_agent`

Same shape as B1. Confirmed surface: `-p/--print`, `--output-format`, `--model`, `-f/--force`.

Skills materialise to `.cursor/rules/<slug>.mdc` — verify empirically that `cursor-agent` reads them in print mode, and record the evidence. If it does not, report `skills: false` in capabilities rather than pretending.

---

## Task B3: `codex_local` — UNVERIFIABLE

`codex` is **not installed on this machine.**

- [ ] Build the adapter from documented behaviour.
- [ ] Report `verified: false` from `capabilities()`.
- [ ] Wire the conformance suite with `live: false` and a **named skip reason**: `"codex CLI not installed"`.
- [ ] All non-live contract tests must still pass against a fake binary.
- [ ] **Checkpoint: state plainly in the report that this adapter has never run against its real runtime.**

---

## Task C1: Agentic tool set and executor

**Files:** `src/core/agentic/{tools,executor}.ts`, `test/agentic/executor.test.ts`

The API tier has no tools of its own. This is where they come from.

- [ ] **Step 1:** Define the tool schemas — `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `bash`. Provider-neutral JSON Schema; each provider binding translates to its own wire format.
- [ ] **Step 2:** Implement the executor: takes a tool name and arguments, runs it against the workspace, returns a result string. **Every path is confined to the workspace root** — a `..` traversal must be refused, not sanitised. Test it.
- [ ] **Step 3:** Bound `bash`: a timeout, a captured-output cap, and an explicit non-interactive environment.
- [ ] **Step 4:** Tests must cover refusal paths as thoroughly as success paths — traversal outside the workspace, a missing file, a timing-out command, output exceeding the cap.
- [ ] **Step 5: Checkpoint.**

---

## Task C2: The agentic loop

**Files:** `src/core/agentic/loop.ts`, `test/agentic/loop.test.ts`

- [ ] **Step 1:** Define a provider-neutral transport interface — `send(messages, tools) → {text, toolCalls, usage, stopReason}`. The loop knows nothing about any SDK.
- [ ] **Step 2:** Implement the loop: send → execute tool calls → append results → repeat until the model stops or a bound trips.
- [ ] **Step 3: Bounds are mandatory, all four** — max iterations, max tokens, max cost, max wall-clock. Exceeding any one ends the loop with `over_budget`. **An unbounded loop against a paid API is the most expensive bug available in this project**; a test must prove each bound fires.
- [ ] **Step 4:** Synthesise `TranscriptEvent`s directly, so `parseTranscript` is trivial for API adapters.
- [ ] **Step 5:** Test the whole loop against a **stub transport** — no network, no cost. Cover: a clean finish, a tool-call round trip, each of the four bounds, and a transport error mid-loop.
- [ ] **Step 6: Checkpoint.**

---

## Task C3: `claude_api` · Task C4: `gemini_api` · Task C5: `codex_api`

Each is a **transport binding only** — the loop, tools and executor are shared.

- [ ] Translate the neutral tool schemas into the provider's format (Anthropic tool use / Gemini function calling / OpenAI Responses).
- [ ] Map the provider's usage response into the shared `RunUsage` shape.
- [ ] Materialise skills by injecting SKILL.md into the system prompt — we own the loop, so no filesystem convention applies.
- [ ] Wire the conformance suite. `live: true` for C3 and C4 (keys present). **C5 is `live: false` with the named reason `"no OPENAI_API_KEY"` and `verified: false`.**
- [ ] Each live validation makes **exactly one** real API call. Report its cost.

---

## Task D1: Register all adapters and re-validate the pipeline

- [ ] Register all seven in `orchestrator.config.ts`.
- [ ] Run the full conformance suite across every adapter. Produce a **capability matrix** — adapter × capability × verified — and write it to `docs/superpowers/specs/adapter-matrix.md`.
- [ ] Re-run the SAPN_DEMO `requirements` stage (predecessor plan Task 11) on `claude_local` to confirm no regression from the refactor.
- [ ] Attempt the same stage on `gemini_local`. **Report honestly whether the output is usable** — this is the real test of whether multi-runtime support delivers anything, and a negative result is a finding, not a failure.
- [ ] **Checkpoint:** present the matrix and the cross-runtime comparison.

---

## Post-plan

Seven adapters, one conformance contract, and an honest matrix of what each can actually do. Two adapters will be unverified until `codex` and an `OPENAI_API_KEY` exist on the machine — that must be stated wherever the matrix is shown, not buried.
