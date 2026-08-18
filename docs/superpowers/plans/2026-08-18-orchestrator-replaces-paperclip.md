# Orchestrator Replaces Paperclip — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (Subagent-driven execution is deliberately NOT used on this repo — the user has asked that no Agent tool dispatch happen without an explicit request.)

**Goal:** Make `@scyne/orchestrator` run every stage of the pipeline end to end — generate, validate, approve, publish and revise — drive it from the chatbot with Paperclip stopped, and give it its own console UI, so `paperclipai` can be uninstalled.

**Architecture:** The library stays generic; everything workspace-specific is compiled from `scripts/pipeline.mjs` into `orchestrator.workflows.ts` (a consumer file). Two new engine primitives unlock the rest: an issue can be *resumed* (fixing reject/retry), and an `agent` step can *read files into its prompt* (which is what a revision is). Publishing becomes an ordinary `agent` step after the gate, so the engine's `step_index` gives idempotency for free and every marker-comment dance in the old bundles disappears. The chatbot changes in exactly one file. The console is one self-contained HTML page served by the library, following `render-companion-app.mjs`'s house pattern.

**Tech Stack:** Node ≥ 24 · TypeScript 5.7 · ESM · Express 4 · PGlite · Vitest · Claude Code 2.1.232 headless

**Spec:** [`docs/superpowers/specs/2026-08-17-scyne-orchestrator-design.md`](../specs/2026-08-17-scyne-orchestrator-design.md) — this plan implements its phases 2, 3 and 4.

**Predecessor:** [`2026-08-17-scyne-orchestrator-prototype.md`](2026-08-17-scyne-orchestrator-prototype.md) (phase 1, complete — see [`2026-08-17-prototype-findings.md`](../specs/2026-08-17-prototype-findings.md)).

## Global Constraints

- **NEVER run `git commit`, `git add`, or any git write operation.** The user commits their own work. Every task ends with a verification checkpoint instead.
- ESM only. Node ≥ 24. No `any` in exported signatures. **Australian English** in all generated content and user-facing copy (Behaviour, Authorise, Organisation, Licence).
- `npx tsc --noEmit` must exit 0 in `packages/orchestrator/` after every task.
- `npx vitest run` in `packages/orchestrator/` must be green after every task. **Baseline: 98 passed, 1 skipped, 11 files.** A task that changes an existing test must say so and say why.
- **The core must never import from a specific consumer.** `packages/orchestrator/**` may not import `scripts/pipeline.mjs`, `orchestrator.config.ts`, or anything under `projects/`. The compiler that knows about stages lives at the repo root, in consumer space.
- **`ROUTES` in `src/http/router.ts` and `openapi.yaml` are diffed in both directions by `test/openapi.test.ts`.** Every new route needs an entry in both, with a `summary` and at least one response, or the suite fails.
- **PGlite is single-writer.** One process owns `.orchestrator/pgdata`. Once `orch serve` is running, CLI verbs against the same directory will fail to open the database — that is expected, not a bug.
- Confluence attachments go through `node scripts/confluence-attach.mjs` and never through the Atlassian MCP, which has no attachment scope. This is repeated in every publish prompt for a reason: skipping it publishes a page whose diagrams are silently missing.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `orchestrator.workflows.ts` | Compiles `scripts/pipeline.mjs`'s `STAGES` into `WorkflowDef[]` — one generate workflow and one revise workflow per stage, plus `baseline`. Consumer space: knows about projects, features and Confluence; the library knows none of it. |
| `agent-instructions/*.thin.md` (×9) | Domain-only system prompts, one per worker agent. No API calls, no status transitions, no phase detection. |
| `packages/orchestrator/src/http/console.ts` | The console: one self-contained HTML page, inline CSS + JS, zero network requests beyond the local API. |
| `scyne-chatbot/server/orchestrator.ts` | Replaces `server/paperclip.ts`. Same exported method names, so `server/index.ts`'s 33 call sites do not move. |

**Modified:**

| File | Change |
|---|---|
| `packages/orchestrator/src/core/engine.ts` | `retry()`; auto-advance after a rejection; `reads` file→prompt primitive; params appendix on explicit prompts. |
| `packages/orchestrator/src/config.ts` | `reads?` on the `agent` step; validation for it. |
| `packages/orchestrator/src/http/router.ts` | `POST /issues/{id}/advance`, `GET /agents/{key}/bundle`, `GET /orch`. |
| `packages/orchestrator/openapi.yaml` | The three routes above. |
| `orchestrator.config.ts` | Full org (11 agents), all workflows from the compiler, theme. |
| `scyne-chatbot/server/index.ts` | One import line. |
| `package.json` (root) | `setup`, `dev`, `serve` scripts. |
| `CLAUDE.md` | Paperclip → orchestrator throughout. |

**Deleted (Task 12 only, after a green end-to-end run):** `paperclipai` devDependency, `npm run paperclip`, `scripts/bootstrap.mjs`'s hiring logic, `.bootstrap/ids.json` as a runtime input.

---

## Task 1: Resume a parked or blocked issue

Rejecting a gate rewinds `step_index` and sets the issue back to `todo` — and then nothing happens, because `decideGate` never calls `advance()`. There is also no way to restart a `blocked` issue at all: `advance()` returns immediately for `blocked`. Both of the chatbot's Reject and Request-changes buttons are dead ends today.

**Files:**
- Modify: `packages/orchestrator/src/core/engine.ts` (the `Engine` interface, `decideGate`'s rejected branch, a new `retry`)
- Modify: `packages/orchestrator/src/http/router.ts` (`ROUTES` + one handler)
- Modify: `packages/orchestrator/openapi.yaml`
- Test: `packages/orchestrator/test/engine.test.ts`, `packages/orchestrator/test/router.test.ts`

**Interfaces:**
- Produces: `Engine.retry(issueId: string): Promise<void>` — clears `blocked`, then advances. Throws on an unknown issue or one already `done`.
- Produces: `POST /issues/{id}/advance` → `202 {ok: true, issueId}`; `400` if done; `404` if unknown. Fire-and-forget, mirroring `POST /issues`, because a resumed run can take 25 minutes.

- [ ] **Step 1: Write the failing engine tests**

Append to `packages/orchestrator/test/engine.test.ts`, inside the existing `describe("engine", …)`:

```ts
  it("regenerates immediately when a gate is rejected — no second call needed", async () => {
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# summary");
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    const gate = (await repo.listGates(issue.id))[0];
    await engine.decideGate(gate.id, "rejected", "too thin", "tagari");

    // The agent step re-ran on its own, and a fresh gate is waiting.
    expect(calls.filter(c => c === "run").length).toBe(2);
    const after = await repo.getIssue(issue.id);
    expect(after?.status).toBe("in_review");
    const gates = await repo.listGates(issue.id);
    expect(gates.filter(g => g.status === "pending").length).toBe(1);
    expect(gates.filter(g => g.status === "rejected").length).toBe(1);
  });

  it("retry() restarts a blocked issue from the step that blocked it", async () => {
    // No outputs/ written, so the attach step blocks on a missing file.
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);
    expect((await repo.getIssue(issue.id))?.status).toBe("blocked");

    // Fix the cause, then retry.
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# summary");
    await engine.retry(issue.id);

    expect((await repo.getIssue(issue.id))?.status).toBe("in_review");
    expect((await repo.listWorkProducts(issue.id)).length).toBe(1);
  });

  it("retry() refuses an issue that is already done", async () => {
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await repo.updateIssue(issue.id, { status: "done" });
    await expect(engine.retry(issue.id)).rejects.toThrow(/done/);
  });
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `cd packages/orchestrator && npx vitest run test/engine.test.ts`
Expected: FAIL — `engine.retry is not a function`, and the rejection test sees 1 run, not 2.

- [ ] **Step 3: Implement `retry` and auto-advance on rejection**

In `packages/orchestrator/src/core/engine.ts`, add to the `Engine` interface:

```ts
  retry(issueId: string): Promise<void>;
```

In `decideGate`, the rejected branch — add the advance call before returning:

```ts
      if (status === "rejected") {
        const issue = await repo.getIssue(gate.issue_id);
        if (!issue) throw new Error(`unknown issue ${gate.issue_id}`);
        const wf = workflow(issue.workflow_key);
        // Rewind to the last agent step at or before the gate — a rejection
        // means "the generated output was wrong", so the natural resume
        // point is the step that generated it, not the gate itself.
        let i = issue.step_index;
        while (i > 0 && wf.steps[i]?.type !== "agent") i--;
        await repo.updateIssue(gate.issue_id, { stepIndex: i, status: "todo" });
        // Rewinding without advancing left the issue parked at `todo` forever:
        // nothing else in the system watches for it. The approve branch below
        // has always advanced; a rejection is no different in that respect.
        await advance(gate.issue_id);
        return;
      }
```

Add `retry` to the returned object, next to `advance`:

```ts
    /**
     * Resume an issue that has stopped. `advance()` deliberately returns
     * immediately for a `blocked` issue — otherwise a failing step would spin
     * — so a human-initiated retry has to clear the block first. The
     * step_index is left exactly where it was: the blocked step is the one
     * worth re-running, and re-running an already-succeeded step would
     * duplicate an agent run.
     */
    async retry(issueId) {
      const issue = await repo.getIssue(issueId);
      if (!issue) throw new Error(`unknown issue ${issueId}`);
      if (issue.status === "done") {
        throw new Error(`issue ${issue.identifier} is already done — nothing to retry`);
      }
      if (issue.status === "blocked") await repo.updateIssue(issueId, { status: "todo" });
      await advance(issueId);
    },
```

- [ ] **Step 4: Run the engine tests**

Run: `cd packages/orchestrator && npx vitest run test/engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the existing router test that asserted the dead end**

`test/router.test.ts` has a test named `a rejected gate rewinds the issue to todo at the generating step`. Its assertion is now wrong by design — after a rejection the engine regenerates and parks at a fresh gate. Find it:

Run: `cd packages/orchestrator && grep -n "rewinds the issue to todo" test/router.test.ts`

Replace its post-rejection assertions with:

```ts
    // Rejection now regenerates on its own: the issue comes back to the gate
    // rather than sitting at `todo` waiting for something that never comes.
    const after = await (await fetch(`${baseUrl}/issues/${issue.id}`)).json();
    expect(after.status).toBe("in_review");
    expect(after.step_index).toBe(1);
```

Run the same check over `test/engine.test.ts` (`grep -n "reject" test/engine.test.ts`) and update any other test asserting a post-rejection `todo` the same way.

- [ ] **Step 6: Write the failing router test for the advance route**

Append to `test/router.test.ts`, inside the existing `describe("router", …)`:

```ts
  it("POST /issues/:id/advance restarts a blocked issue", async () => {
    // A workflow whose attach step blocks: nothing wrote the file.
    const created = await fetch(`${baseUrl}/issues`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflow: "requirements", params: { project: "P" } }),
    });
    const issue = await created.json();
    await vi.waitFor(async () => {
      const r = await (await fetch(`${baseUrl}/issues/${issue.id}`)).json();
      expect(r.status).toBe("in_review");
    });

    const res = await fetch(`${baseUrl}/issues/${issue.id}/advance`, { method: "POST" });
    expect(res.status).toBe(202);
    expect((await res.json()).ok).toBe(true);
  });

  it("POST /issues/:id/advance 404s for an unknown issue", async () => {
    const res = await fetch(`${baseUrl}/issues/11111111-1111-4111-8111-111111111111/advance`, { method: "POST" });
    expect(res.status).toBe(404);
  });
```

- [ ] **Step 7: Add the route, the ROUTES entry and the OpenAPI entry**

In `src/http/router.ts`, add to `ROUTES` immediately after the `PATCH /issues/{id}` line:

```ts
  { method: "POST",  path: "/issues/{id}/advance" },
```

And the handler, immediately after the `r.patch("/issues/:id", …)` block:

```ts
  /**
   * Resume a parked or blocked issue. Fire-and-forget with a 202 for the same
   * reason POST /issues is: a resumed workflow re-runs an agent step, which
   * takes tens of minutes — holding the request open would time out every
   * proxy between here and the browser. Poll GET /issues/{id} for progress.
   */
  r.post("/issues/:id/advance", wrap(async (req, res) => {
    const id = pathParam(req.params.id);
    const issue = await orch.repo.getIssue(id);
    if (!issue) { notFound(res, `issue '${id}'`); return; }
    if (issue.status === "done") { badRequest(res, `issue ${issue.identifier} is already done`); return; }
    orch.engine.retry(id).catch((err: unknown) => {
      console.error(`[orchestrator] retry(${id}) failed:`, err);
    });
    res.status(202).json({ ok: true, issueId: id });
  }));
```

In `openapi.yaml`, under `paths:`, add:

```yaml
  /issues/{id}/advance:
    post:
      summary: Resume a parked or blocked issue from its current step
      description: >
        Clears a `blocked` status and advances the workflow. Returns immediately;
        the run continues in the background. Poll `GET /issues/{id}` for progress.
      parameters:
        - $ref: '#/components/parameters/IssueId'
      responses:
        '202':
          description: Accepted — the engine is advancing the issue in the background
        '400':
          description: The issue is already done
        '404':
          description: No such issue
```

- [ ] **Step 8: Run the full suite**

Run: `cd packages/orchestrator && npx vitest run && npx tsc --noEmit`
Expected: all green, `tsc` silent. Test count is now 103 passed, 1 skipped.

---

## Task 2: `reads` — put a file's contents into an agent's prompt

A revision means handing an agent the previous version of an artefact and a change instruction. No step type can do that today: `params` come from CLI flags, and there is no mechanism for a file to become a prompt variable. This is the primitive the whole revision flow (Task 5) is built on, and the prototype findings named it as the gap to close before phase 2.

**Files:**
- Modify: `packages/orchestrator/src/config.ts` (the `agent` step shape + validation)
- Modify: `packages/orchestrator/src/core/engine.ts` (`readVars`, wired into the `agent` case, and `buildPrompt`'s params appendix)
- Test: `packages/orchestrator/test/engine.test.ts`, `packages/orchestrator/test/config.test.ts`

**Interfaces:**
- Consumes: `interpolate(tpl, vars)` from Task 1's unchanged module. It substitutes in a single pass via a replacement *function*, so file content containing `{braces}` or `$&` is inserted literally and never re-scanned — which is what makes injecting a JSON artefact safe.
- Produces: `{ type: "agent"; reads?: Record<string, string> }` — variable name → workspace-relative path template. Every entry is required: a missing file blocks the issue naming the variable and the resolved path.
- Produces: `MAX_READ_CHARS = 256_000`, exported from `engine.ts` for the test to assert against.

- [ ] **Step 1: Write the failing engine tests**

Append to `test/engine.test.ts`:

```ts
  it("reads files into the agent's prompt", async () => {
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# summary");
    writeFileSync(join(dir, "outputs/previous.md"), "the previous version {not-a-placeholder}");

    const prompts: string[] = [];
    const capturing = { run: async (req: { prompt: string }) => { prompts.push(req.prompt); return {
      exitCode: 0, status: "succeeded" as const, stderrTail: "",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0,
               costUsd: 0, durationMs: 1, numTurns: 1, sessionId: "s" } }; } };

    const c = config(dir, capturing);
    c.workflows[0].steps[1] = {
      type: "agent", phase: "revise",
      reads: { previous: "outputs/previous.md" },
      prompt: "Change: {instruction}\n---\n{previous}\n---",
    };

    const engine = createEngine({ repo, config: c, exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F", instruction: "add SLA field" });
    await engine.advance(issue.id);

    expect(prompts[0]).toContain("Change: add SLA field");
    expect(prompts[0]).toContain("the previous version {not-a-placeholder}");
  });

  it("blocks, naming the file, when a reads target is missing", async () => {
    const c = config(dir);
    c.workflows[0].steps[1] = {
      type: "agent", phase: "revise",
      reads: { previous: "outputs/{feature}/nope.md" },
      prompt: "{previous}",
    };
    const engine = createEngine({ repo, config: c, exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    const after = await repo.getIssue(issue.id);
    expect(after?.status).toBe("blocked");
    const comments = await repo.listComments(issue.id);
    expect(comments[comments.length - 1].body).toContain("previous");
    expect(comments[comments.length - 1].body).toContain("outputs/F/nope.md");
    expect(calls.filter(c2 => c2 === "run").length).toBe(0);   // never spawned the agent
  });

  it("appends the issue params to an explicit prompt", async () => {
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# summary");
    const prompts: string[] = [];
    const capturing = { run: async (req: { prompt: string }) => { prompts.push(req.prompt); return {
      exitCode: 0, status: "succeeded" as const, stderrTail: "",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0,
               costUsd: 0, durationMs: 1, numTurns: 1, sessionId: "s" } }; } };
    const c = config(dir, capturing);
    c.workflows[0].steps[1] = { type: "agent", phase: "generate", prompt: "Do the thing for {project}." };

    const engine = createEngine({ repo, config: c, exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F", confluenceSpace: "SADA" });
    await engine.advance(issue.id);

    expect(prompts[0]).toContain("Do the thing for P.");
    expect(prompts[0]).toContain("confluenceSpace: SADA");
  });
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `cd packages/orchestrator && npx vitest run test/engine.test.ts`
Expected: FAIL — the prompt has no `previous` content, and `interpolate` throws `unknown placeholder {previous}`.

- [ ] **Step 3: Add `reads` to the step type and validate it**

In `src/config.ts`, replace the `agent` member of the `Step` union:

```ts
  | { type: "agent";  agent?: string; phase: string; skill?: string; prompt?: string;
                      adapter?: string; model?: string; effort?: Effort;
                      /**
                       * Variable name → workspace-relative path template. Each
                       * file is read at step time and made available to
                       * `prompt` as `{name}`. Every entry is required: a
                       * missing file blocks the issue rather than silently
                       * handing the agent an empty revision base.
                       */
                      reads?: Record<string, string> }
```

Add to `validateConfig`, inside the `if (s.type === "agent")` block:

```ts
        for (const [name, tpl] of Object.entries(s.reads ?? {})) {
          if (!tpl) {
            problems.push(`workflow '${w.key}' step ${i}: reads['${name}'] has an empty path`);
          }
          // `workspace` and `issueId` are injected by the engine on every step;
          // a reads entry by either name would shadow them silently.
          if (name === "workspace" || name === "issueId") {
            problems.push(`workflow '${w.key}' step ${i}: reads['${name}'] shadows a reserved variable`);
          }
        }
```

- [ ] **Step 4: Implement `readVars` and wire it in**

In `src/core/engine.ts`, extend the fs import and add the constant near the top:

```ts
import { access, readFile } from "node:fs/promises";
```

```ts
/**
 * Ceiling on how much of one file is injected into a prompt. A product summary
 * is ~40 KB and a stories.json ~85 KB, so this is roughly 3× the largest real
 * artefact — high enough never to fire in normal use, low enough that a
 * pathological input cannot blow the context window before the agent has read
 * its own instructions.
 */
export const MAX_READ_CHARS = 256_000;
```

Inside `createEngine`, above `buildPrompt`:

```ts
  /**
   * Resolve an agent step's `reads` into prompt variables. Returns the
   * variables it could read and the entries it could not, so the caller can
   * block with all the missing paths at once rather than one per retry.
   */
  async function readVars(
    step: Extract<Step, { type: "agent" }>,
    vars: Record<string, string>,
  ): Promise<{ vars: Record<string, string>; missing: string[] }> {
    const out: Record<string, string> = {};
    const missing: string[] = [];
    for (const [name, tpl] of Object.entries(step.reads ?? {})) {
      const rel = interpolate(tpl, vars);
      try {
        const body = await readFile(resolve(config.workspace, rel), "utf8");
        out[name] = body.length > MAX_READ_CHARS
          ? `${body.slice(0, MAX_READ_CHARS)}\n\n[…truncated at ${MAX_READ_CHARS} characters]`
          : body;
      } catch {
        missing.push(`${name} → ${rel}`);
      }
    }
    return { vars: out, missing };
  }
```

Replace `buildPrompt` so an explicit prompt still carries the parameter list — a publish step needs to know the Confluence space key, and the alternative is a placeholder per optional param that throws when absent:

```ts
  function buildPrompt(step: Extract<Step, { type: "agent" }>, wf: WorkflowDef, vars: Record<string, string>): string {
    const params = Object.entries(vars)
      .filter(([k]) => k !== "workspace" && k !== "issueId" && !(k in (step.reads ?? {})))
      .map(([k, v]) => `  ${k}: ${v}`);

    if (step.prompt) {
      // The appendix is not decoration: it is how an explicit prompt reaches
      // optional params (confluenceSpace, jiraProjectKey, startingStoryNumber)
      // without a `{placeholder}` that would throw on every run that omits them.
      return [interpolate(step.prompt, vars), ``, `Parameters:`, ...params].join("\n");
    }
    return [
      `Run PHASE ${step.phase} for workflow \`${wf.key}\`.`,
      ...params,
      step.skill ? `  Invoke skill: ${step.skill}` : "",
      ``,
      `Do not call any API. Do not change issue status. Exit when your files are written.`,
    ].filter(Boolean).join("\n");
  }
```

In `runStep`'s `case "agent"`, immediately after `const agentKey = …` / before the run row is started:

```ts
        const read = await readVars(step, vars);
        if (read.missing.length) {
          // Block BEFORE startRun(): a run row for a step that never spawned a
          // process would show in the console as a zero-token mystery failure.
          await block(issue.id,
            `Step ${issue.step_index} (\`agent\`) cannot read its required input file(s):\n` +
            read.missing.map(m => `- \`${m}\``).join("\n"));
          return "blocked";
        }
```

And change the `prompt:` line in the `runner.run({…})` call to:

```ts
          prompt: buildPrompt(step, wf, { ...vars, ...read.vars }),
```

- [ ] **Step 5: Write the config validation test**

Append to `test/config.test.ts`:

```ts
  it("rejects a reads entry that shadows a reserved variable or has no path", () => {
    const problems = validateConfig(defineOrchestrator({
      workspace: "/tmp", db: { driver: "pglite", dir: "/tmp/pg" },
      adapters: { claude_local: { run: async () => ({ exitCode: 0, status: "succeeded", usage: null, stderrTail: "" }) } },
      org: [{ key: "ba", name: "BA" }],
      workflows: [{
        key: "w", label: "W", assignee: "ba",
        steps: [{ type: "agent", phase: "revise", reads: { workspace: "a.md", previous: "" } }],
      }],
    }));
    expect(problems.some(p => p.includes("shadows a reserved variable"))).toBe(true);
    expect(problems.some(p => p.includes("empty path"))).toBe(true);
  });
```

- [ ] **Step 6: Run the full suite**

Run: `cd packages/orchestrator && npx vitest run && npx tsc --noEmit`
Expected: all green. Test count 107 passed, 1 skipped.

---

## Task 3: Compile every stage into a workflow

Nine stages exist in `scripts/pipeline.mjs`; one is wired. The compiler turns each into a `WorkflowDef` with the same shape, so adding a stage to the pipeline graph adds a workflow for free — and, critically, gets the level-relative path prefix right, which is the defect the prototype run found by blocking on a file the agent had correctly written.

**Files:**
- Create: `orchestrator.workflows.ts` (repo root)
- Modify: `orchestrator.config.ts` (full org, workflows from the compiler)
- Test: `packages/orchestrator/test/` — none. This is consumer code; it is verified by Step 6's `orch seed` and by Task 11's end-to-end run. Root-level `.ts` files are outside `packages/orchestrator/tsconfig.json` and are type-checked by `tsx` at load time only.

**Interfaces:**
- Consumes: `STAGES`, `LEVEL`, `RENDER_CMD`, `stageFor` from `scripts/pipeline.mjs`; `WorkflowDef`, `Step` types from `packages/orchestrator/src/index.js`.
- Produces: `buildWorkflows(): WorkflowDef[]` — every generate workflow (keyed by stage key: `capabilities`, `personas`, `requirements`, `ui`, `datamodel`, `architecture`, `qa`, `design`, `app`), every revise workflow (`revise-<stageKey>`, Task 5), and `baseline`.
- Produces: `ORG: AgentSpec[]` — 11 agents, exported from `orchestrator.workflows.ts` so the config file stays about wiring rather than data.

- [ ] **Step 1: Write the compiler's generate half**

Create `orchestrator.workflows.ts`:

```ts
// Compiles `scripts/pipeline.mjs` into orchestrator workflows.
//
// Consumer space, deliberately: the library must not know what a "project" or
// a "feature" is, and `pipeline.mjs` stays the single source of truth for what
// a stage requires, produces and validates. Everything here is a mechanical
// transform of that graph — adding a stage there adds a workflow here.

import { STAGES, LEVEL, RENDER_CMD } from "./scripts/pipeline.mjs";
import type { Step, WorkflowDef } from "./packages/orchestrator/src/index.js";

interface Stage {
  level: string; label: string; agentKey: string; skill?: string; script?: string;
  publishes: boolean; produces: string[]; producesInWorkspace?: string[];
  then?: string; optional?: boolean;
}

const S = STAGES as Record<string, Stage>;

/**
 * `produces[]` is relative to the stage's OWN level root — the single most
 * expensive convention in this file to get wrong. A feature stage that resolved
 * its outputs against the workspace root blocked a completed run in the
 * prototype (see the findings doc), because the agent had written the files
 * correctly and the attach step was looking one directory tree too high.
 */
const root = (s: Stage): string =>
  s.level === LEVEL.PROJECT ? "projects/{project}/" : "projects/{project}/{feature}/";

/** `pipeline.mjs` writes its commands with `<angle>` placeholders; the engine interpolates `{brace}` ones. */
const swap = (cmd: string): string => cmd.replaceAll("<project>", "{project}").replaceAll("<feature>", "{feature}");

const isProject = (s: Stage): boolean => s.level === LEVEL.PROJECT;

/** `stage.mjs` resolves the LEVEL before the name, so a project stage passes no feature. */
const stageArgs = (s: Stage, key: string): string =>
  isProject(s) ? `{project} ${key}` : `{project} "{feature}" ${key}`;

const scope = (s: Stage): string => isProject(s) ? "{project}" : "{project} / {feature}";

const MINUTES = 60_000;

function generatePrompt(key: string, s: Stage): string {
  return [
    `Generate the ${s.label} for ${scope(s)}.`,
    ``,
    `Your inputs are already staged — \`node scripts/stage.mjs ${stageArgs(s, key)}\` has`,
    `run, converted every source document to markdown, and copied the project`,
    `context into your working folder. Read what is there; do not go looking for`,
    `files outside it.`,
    ``,
    `Invoke the \`${s.skill}\` skill. It writes to:`,
    ...s.produces.map(f => `  - ${root(s)}${f}`),
    ``,
    `Do not call any API. Do not publish anything. Do not change any issue`,
    `status, attach anything, or raise an approval — the orchestrator owns all`,
    `of that. Exit when your files are written.`,
  ].join("\n");
}

function attachFiles(s: Stage): string[] {
  return [
    ...s.produces.map(f => `${root(s)}${f}`),
    ...(s.producesInWorkspace ?? []).map(swap),
  ];
}

export function stageWorkflow(key: string, s: Stage): WorkflowDef {
  const steps: Step[] = [
    { type: "exec", cmd: `node scripts/stage.mjs ${stageArgs(s, key)}`, timeoutMs: 10 * MINUTES },
  ];

  if (s.skill) {
    steps.push({ type: "agent", phase: "generate", skill: s.skill, effort: "high", prompt: generatePrompt(key, s) });
  } else if (s.script) {
    // `app` has no skill — it is a renderer, and a shell step is the honest
    // expression of that. Running it through an agent would spend a model call
    // to type one command.
    steps.push({ type: "exec", cmd: swap(s.script), timeoutMs: 20 * MINUTES });
  }

  // The validator that must pass before a human is asked to approve anything.
  if (s.then) steps.push({ type: "exec", cmd: swap(s.then), timeoutMs: 5 * MINUTES });

  const files = attachFiles(s);
  if (files.length) steps.push({ type: "attach", files });

  steps.push({ type: "gate", title: `Approve ${s.label} — ${scope(s)}`, summary: approvalSummary(s) });

  if (s.publishes) {
    steps.push({ type: "agent", phase: "publish", effort: "medium", prompt: publishPrompt(key, s) });
  }

  // Every stage feeds the one companion app, so it is re-rendered after each —
  // not once at the end, which would leave the UI tab stale for hours.
  if (key !== "app") steps.push({ type: "exec", cmd: swap(RENDER_CMD), timeoutMs: 15 * MINUTES });

  return { key, label: s.label, assignee: s.agentKey, steps };
}

function approvalSummary(s: Stage): string {
  return [
    `${s.label} is ready for review.`,
    ``,
    `Files:`,
    ...attachFiles(s).map(f => `- ${f}`),
    ``,
    s.publishes
      ? `Approving publishes it to Confluence. Rejecting sends it back to the ${s.agentKey} to regenerate.`
      : `Approving completes this stage. Rejecting sends it back to the ${s.agentKey} to regenerate.`,
  ].join("\n");
}
```

`publishPrompt` is written in Task 4 — until then, add a temporary stub at the bottom of the file so the module loads:

```ts
function publishPrompt(key: string, s: Stage): string {
  return `Publish ${s.label} for ${scope(s)}.`;   // replaced in Task 4
}
```

- [ ] **Step 2: Add the org and the workflow list**

Append to `orchestrator.workflows.ts`:

```ts
import type { AgentSpec } from "./packages/orchestrator/src/index.js";

// Reporting lines mirror `scripts/bootstrap.mjs`'s org chart. `mcpEnabled` is
// granted ONLY to agents that publish — an Atlassian tool surface on an agent
// with nothing to push is a way to reach a client's Confluence by accident.
export const ORG: AgentSpec[] = [
  { key: "ceo",          name: "CEO",              title: "Chief Executive",   icon: "crown" },
  { key: "pm",           name: "Delivery Lead",    title: "Delivery Lead",     icon: "rocket",        reportsTo: "ceo" },
  { key: "businessLead", name: "Business Lead",    title: "Business Lead",     icon: "lightbulb",     reportsTo: "pm" },
  { key: "archLead",     name: "Architecture Lead", title: "Architecture Lead", icon: "circuit-board", reportsTo: "pm",
    bundlePath: "agent-instructions/architect-lead.thin.md", mcpEnabled: true },
  { key: "ba",           name: "BA",               title: "Business Analyst",  icon: "search",        reportsTo: "businessLead",
    bundlePath: "agent-instructions/ba.thin.md", mcpEnabled: true },
  { key: "qaArchitect",  name: "QA Architect",     title: "QA Architect",      icon: "clipboard-check", reportsTo: "businessLead",
    bundlePath: "agent-instructions/qa-architect.thin.md", mcpEnabled: true },
  { key: "capArchitect", name: "Capabilities Process Architect", title: "Capabilities Process Architect", icon: "network", reportsTo: "archLead",
    bundlePath: "agent-instructions/capabilities-process-architect.thin.md", mcpEnabled: true },
  { key: "serviceDesigner", name: "Service Designer", title: "Service Designer", icon: "users", reportsTo: "archLead",
    bundlePath: "agent-instructions/service-designer.thin.md", mcpEnabled: true },
  { key: "dataModeler",  name: "Data Modeler",     title: "Data Modeler",      icon: "database",      reportsTo: "archLead",
    bundlePath: "agent-instructions/data-modeler.thin.md", mcpEnabled: true },
  { key: "solutionArchitect", name: "Solution Architect", title: "Solution Architect", icon: "layers", reportsTo: "archLead",
    bundlePath: "agent-instructions/solution-architect.thin.md", mcpEnabled: true },
  { key: "uxDesigner",   name: "UX Designer",      title: "UX Designer",       icon: "palette",       reportsTo: "archLead",
    bundlePath: "agent-instructions/ux-designer.thin.md" },
  { key: "ui",           name: "Developer",        title: "Developer",         icon: "code",          reportsTo: "archLead",
    bundlePath: "agent-instructions/ui.thin.md" },
];

/**
 * The project baseline: capability map, then personas, in one issue with a gate
 * after each. Sequential because journey stages align to the L1 lifecycle
 * phases the capability map defines — the ordering is a real dependency, not a
 * preference. Expressed as one flat workflow rather than two `flow` steps
 * because parent-resume-on-child-completion is not implemented in the engine
 * (see the `flow` case in engine.ts); a flat workflow needs none of it.
 */
function baselineWorkflow(): WorkflowDef {
  const cap = stageWorkflow("capabilities", S.capabilities);
  const per = stageWorkflow("personas", S.personas);
  return {
    key: "baseline",
    label: "Project Baseline (capabilities + personas)",
    assignee: "capArchitect",
    steps: [
      ...cap.steps.map(s => s.type === "agent" ? { ...s, agent: "capArchitect" } : s),
      ...per.steps.map(s => s.type === "agent" ? { ...s, agent: "serviceDesigner" } : s),
    ],
  };
}

export function buildWorkflows(): WorkflowDef[] {
  const generate = Object.entries(S).map(([key, s]) => stageWorkflow(key, s));
  return [...generate, baselineWorkflow()];
}
```

- [ ] **Step 3: Rewrite `orchestrator.config.ts` to use them**

Replace the whole file:

```ts
// The consumer config for @scyne/orchestrator. Everything here is
// workspace-specific data compiled from `scripts/pipeline.mjs`, which stays the
// single source of truth for what a stage requires and produces. Nothing under
// packages/orchestrator/ is touched to make this work.

import { defineOrchestrator, createClaudeRunner } from "./packages/orchestrator/src/index.js";
import { ORG, buildWorkflows } from "./orchestrator.workflows.js";

export default defineOrchestrator({
  workspace: process.cwd(),
  company: "Scyne",
  db: { driver: "pglite", dir: ".orchestrator/pgdata" },

  adapters: { claude_local: createClaudeRunner() },

  defaults: { adapter: "claude_local", model: "claude-sonnet-4-6", effort: "medium" },

  org: ORG.map(a => ({
    ...a,
    // If Sonnet 4.6 is overloaded mid-run the pipeline should degrade, not stop.
    fallbackModel: a.bundlePath ? ["claude-sonnet-4-5-20250929"] : undefined,
    // A ceiling, not a target. The one measured requirements run took 25
    // minutes and $3.19 (prototype findings); 45 minutes and $15 leaves room
    // for a heavier feature without letting a runaway run all night.
    budget: a.bundlePath ? { maxTokens: 2_000_000, maxCostUsd: 15, maxDurationMs: 45 * 60_000 } : undefined,
  })),

  workflows: buildWorkflows(),
});
```

- [ ] **Step 4: Seed and inspect the compiled workflows**

Run: `npm run orch -- seed`
Expected: `✓ 12 agent(s) reconciled for company <uuid>`. A config problem is reported as a list of every problem, not the first — read all of them.

Run: `npm run orch -- serve --port 3100` in one terminal, then in another:
`curl -s http://127.0.0.1:3100/config | npx json workflows` (or `| python3 -m json.tool`)
Expected: 10 workflows listed (9 stages + baseline), each with its step count. Stop the server before the next step — PGlite is single-writer.

- [ ] **Step 5: Verify the paths the attach steps will check**

Run:

```bash
node --input-type=module -e "
import { buildWorkflows } from './orchestrator.workflows.ts';
" 2>/dev/null || npx tsx -e "
import { buildWorkflows } from './orchestrator.workflows.js';
for (const w of buildWorkflows()) {
  const a = w.steps.find(s => s.type === 'attach');
  console.log(w.key.padEnd(14), a ? a.files.join('  ') : '(no attach)');
}
"
```

Expected: project stages show `projects/{project}/solutions/...`, feature stages show `projects/{project}/{feature}/...`, and `app` shows `generated-apps/{project}/index.html`. **A feature stage showing a path without `{feature}` is the prototype's blocking defect returning — stop and fix the `root()` helper.**

- [ ] **Step 6: Checkpoint**

Run: `cd packages/orchestrator && npx vitest run`
Expected: still 107 passed — this task touches no library code.

---

## Task 4: Publish to Confluence and Jira as a step

Publishing was left out of the prototype on purpose. It comes back as an ordinary `agent` step after the gate, which deletes the entire idempotency-marker protocol from the old bundles: a step runs once because `step_index` moves past it, not because the agent scanned its own comments for a marker it wrote last time.

**Files:**
- Modify: `orchestrator.workflows.ts` (replace the `publishPrompt` stub)
- Test: verified end to end in Task 11. There is no unit test for prompt text; a test asserting an English sentence would pin the wording without testing behaviour.

**Interfaces:**
- Consumes: `root`, `scope`, `isProject`, `Stage` from Task 3.
- Produces: `publishPrompt(key: string, s: Stage): string`.
- Consumes at runtime: `projects/<project>/.published.json` — `{ "<artefactKey>": { "pageId": "...", "url": "...", "title": "...", "space": "..." } }`, where `artefactKey` is the stage key for a project stage and `<feature>/<stage>` for a feature stage (`pipeline.mjs`'s `artefactKey()`).

- [ ] **Step 1: Replace the stub with the real publish prompt**

In `orchestrator.workflows.ts`, delete the temporary `publishPrompt` and add:

```ts
/** The primary document of a stage — the one that becomes a Confluence page. */
const primaryDoc = (s: Stage): string => `${root(s)}${s.produces.find(f => f.endsWith(".md")) ?? s.produces[0]}`;

const artefactKeyTpl = (key: string, s: Stage): string => isProject(s) ? key : `{feature}/${key}`;

function publishPrompt(key: string, s: Stage): string {
  const jira = key === "requirements";
  return [
    `A human has APPROVED the ${s.label} for ${scope(s)}. Publish it.`,
    ``,
    `## 1. Work out where it goes`,
    ``,
    `Read \`projects/{project}/.published.json\` if it exists. If it holds an`,
    `entry under the key \`${artefactKeyTpl(key, s)}\`, this is a REVISION of a page`,
    `that already exists: use \`updateConfluencePage\` on that pageId. Creating a`,
    `second page for the same artefact is the failure this file exists to prevent.`,
    ``,
    `If there is no entry, create a new page. The space key is the`,
    `\`confluenceSpace\` parameter below if one is listed, otherwise the project`,
    `name. The title is "{project} — ${s.label}"${isProject(s) ? "" : ' with the feature name appended'}.`,
    ``,
    `## 2. Check the space exists — do not create it`,
    ``,
    `Call \`getConfluenceSpaces\` and confirm the space key is there. If it is`,
    `not, say exactly which key is missing and stop with a non-zero exit. The`,
    `MCP cannot create spaces and guessing a different one publishes a client's`,
    `document into the wrong place.`,
    ``,
    `## 3. Render the diagrams FIRST`,
    ``,
    `Read \`${primaryDoc(s)}\`. For every fenced \`mermaid\` block in it, render a`,
    `PNG locally with \`npx -y @mermaid-js/mermaid-cli\` — PNG, not SVG, because`,
    `Confluence renders PNG inline and shows an SVG attachment as a download`,
    `link. Never post diagram source to a remote renderer.`,
    ``,
    `## 4. Create or update the page, then attach the images`,
    ``,
    `Publish the markdown as the page body, with each mermaid block replaced by`,
    `an \`<ac:image>\` reference. Then, from the workspace root:`,
    ``,
    `    node scripts/confluence-attach.mjs <pageId> <file.png> [<file.png> ...]`,
    ``,
    `**The Atlassian MCP cannot attach files and never will** — its OAuth grant`,
    `has no attachment scope, so \`POST .../child/attachment\` returns 401`,
    `"scope does not match", and a hand-rolled curl with the same token fails`,
    `identically. The script uses the API token from \`scyne-chatbot/.env\` and is`,
    `idempotent: re-uploading a filename replaces that attachment in place,`,
    `which is exactly what a revision needs.`,
    ``,
    `If the script exits non-zero, print its error verbatim and exit non-zero`,
    `yourself. Do NOT leave a page published whose \`<ac:image>\` tags point at`,
    `attachments that were never uploaded — that ships a client-facing document`,
    `with its diagrams silently missing, which is worse than not publishing.`,
    ...(jira ? [
      ``,
      `## 5. Push the stories to Jira`,
      ``,
      `Read \`projects/{project}/{feature}/outputs/stories.json\`. Confirm the Jira`,
      `project key (the \`jiraProjectKey\` parameter, else the project name) exists`,
      `with \`getVisibleJiraProjects\`; if it does not, stop and say so.`,
      ``,
      `For each story: replace \`{{PRODUCT_SUMMARY_URL}}\` in the description with`,
      `the Confluence URL you just captured; set \`fields.parent.key\` to the`,
      `\`parentEpicKey\` parameter ONLY if one is listed and non-empty (omit`,
      `\`fields.parent\` entirely otherwise); create the issue. Descriptions are`,
      `Atlassian Document Format, which is what REST v3 requires.`,
    ] : []),
    ``,
    `## ${jira ? "6" : "5"}. Record what you published`,
    ``,
    `Write the page id, url, title and space back into`,
    `\`projects/{project}/.published.json\` under \`${artefactKeyTpl(key, s)}\`,`,
    `preserving every other entry in the file. Then print the Confluence URL on`,
    `a line of its own as the last thing you output${jira ? ", followed by a markdown table of story_number | jira_key | jira_url" : ""}.`,
    ``,
    `Do not change any issue status and do not raise anything — the orchestrator`,
    `moves the issue to done when you exit cleanly.`,
  ].join("\n");
}
```

- [ ] **Step 2: Confirm the prompts compile and read correctly**

Run:

```bash
npx tsx -e "
import { buildWorkflows } from './orchestrator.workflows.js';
const wf = buildWorkflows().find(w => w.key === 'requirements');
const pub = wf.steps.find(s => s.type === 'agent' && s.phase === 'publish');
console.log(pub.prompt);
"
```

Expected: readable prose, `{project}` / `{feature}` placeholders intact, the Jira section present. Then run the same for `datamodel` and confirm the Jira section is **absent**.

- [ ] **Step 3: Confirm every publishing stage has a publish step**

```bash
npx tsx -e "
import { buildWorkflows } from './orchestrator.workflows.js';
import { STAGES } from './scripts/pipeline.mjs';
for (const w of buildWorkflows()) {
  const s = STAGES[w.key];
  if (!s) continue;
  const has = w.steps.some(x => x.type === 'agent' && x.phase === 'publish');
  console.log(w.key.padEnd(14), 'publishes:', String(s.publishes).padEnd(6), 'step:', has);
}
"
```

Expected: `publishes` and `step` agree on every row — true for capabilities, personas, requirements, datamodel, architecture, qa, design; false for ui and app.

- [ ] **Step 4: Checkpoint**

Run: `npm run orch -- seed`
Expected: still reconciles cleanly, no config problems.

---

## Task 5: The revision flow

A revision hands the owning agent its own previous output plus the reviewer's instruction verbatim, and asks for a small diff. This is the flow the whole `reads` primitive was built for, and the discipline it enforces is the reason the approval gate is worth anything: a reviewer approves by reading a diff, and a diff of everything cannot be read.

**Files:**
- Modify: `orchestrator.workflows.ts` (add `reviseWorkflow`, extend `buildWorkflows`)
- Test: `packages/orchestrator/test/` — none (consumer code). Verified in Task 11.

**Interfaces:**
- Consumes: `reads` from Task 2, `primaryDoc`/`attachFiles`/`publishPrompt` from Tasks 3–4.
- Produces: `reviseWorkflow(key: string, s: Stage): WorkflowDef` with key `revise-<stageKey>`.
- Requires at runtime: an `instruction` param on the issue. A missing one throws in `interpolate` and blocks the issue with `unknown placeholder {instruction}` — which is the correct outcome: a revision with no instruction has nothing to do.

- [ ] **Step 1: Add the revise prompt and workflow builder**

Append to `orchestrator.workflows.ts`, above `buildWorkflows`:

```ts
function revisePrompt(key: string, s: Stage): string {
  return [
    `Revise the ${s.label} for ${scope(s)}. This is a REVISION, not a regeneration.`,
    ``,
    `## The reviewer's instruction, verbatim`,
    ``,
    `{instruction}`,
    ``,
    `## The current version`,
    ``,
    `Below is the artefact as it stands. Invoke the \`${s.skill}\` skill in its`,
    `**Revision mode**: preserve every section, decision, identifier and`,
    `numbering the instruction does not touch; apply the change and its genuine`,
    `consequences; append a \`## Revision History\` entry recording what changed`,
    `and why.`,
    ``,
    `A regenerate-from-scratch is a failure of this task, not a thorough job. A`,
    `human approves this by reading the diff, and a diff of everything cannot be`,
    `read — which defeats the gate the revision exists to pass.`,
    ``,
    `--- BEGIN CURRENT VERSION -------------------------------------------------`,
    `{previous}`,
    `--- END CURRENT VERSION ---------------------------------------------------`,
    ``,
    `Your other inputs have been re-staged, so read them as you would for a`,
    `fresh run where the instruction requires it.`,
    ``,
    `Write the revised artefact back to the same path(s):`,
    ...s.produces.map(f => `  - ${root(s)}${f}`),
    ``,
    `Do not call any API. Do not publish anything. Do not change any issue`,
    `status. Exit when your files are written.`,
  ].join("\n");
}

export function reviseWorkflow(key: string, s: Stage): WorkflowDef {
  const steps: Step[] = [
    { type: "exec", cmd: `node scripts/stage.mjs ${stageArgs(s, key)}`, timeoutMs: 10 * MINUTES },
    {
      type: "agent", phase: "revise", skill: s.skill, effort: "high",
      // The whole point of the flow: the previous version becomes {previous}.
      // A missing file blocks BEFORE the agent is spawned, which is right —
      // "revise" with nothing to revise is a caller error, not a model task.
      reads: { previous: primaryDoc(s) },
      prompt: revisePrompt(key, s),
    },
  ];
  if (s.then) steps.push({ type: "exec", cmd: swap(s.then), timeoutMs: 5 * MINUTES });
  steps.push({ type: "attach", files: attachFiles(s) });
  steps.push({
    type: "gate",
    title: `Approve revised ${s.label} — ${scope(s)}`,
    summary: [
      `The ${s.label} has been revised.`,
      ``,
      `Read the diff, not the document — the instruction should be the only`,
      `thing that changed, plus its genuine consequences.`,
      ``,
      s.publishes
        ? `Approving UPDATES the existing Confluence page rather than creating a second one.`
        : `Approving completes the revision.`,
    ].join("\n"),
  });
  if (s.publishes) {
    steps.push({ type: "agent", phase: "publish", effort: "medium", prompt: publishPrompt(key, s) });
  }
  steps.push({ type: "exec", cmd: swap(RENDER_CMD), timeoutMs: 15 * MINUTES });

  return { key: `revise-${key}`, label: `Revise ${s.label}`, assignee: s.agentKey, steps };
}
```

- [ ] **Step 2: Register them**

Replace `buildWorkflows` in `orchestrator.workflows.ts`:

```ts
export function buildWorkflows(): WorkflowDef[] {
  const entries = Object.entries(S);
  const generate = entries.map(([key, s]) => stageWorkflow(key, s));
  // `app` renders the companion app from other artefacts — there is nothing to
  // revise, and no skill to enter Revision mode. Every other stage gets one.
  const revise = entries.filter(([, s]) => Boolean(s.skill)).map(([key, s]) => reviseWorkflow(key, s));
  return [...generate, ...revise, baselineWorkflow()];
}
```

- [ ] **Step 3: Verify the compiled revise workflows**

Run:

```bash
npx tsx -e "
import { buildWorkflows } from './orchestrator.workflows.js';
for (const w of buildWorkflows().filter(w => w.key.startsWith('revise-'))) {
  const a = w.steps.find(s => s.type === 'agent' && s.phase === 'revise');
  console.log(w.key.padEnd(24), w.assignee.padEnd(18), 'reads:', JSON.stringify(a.reads));
}
"
```

Expected: 8 revise workflows (every stage except `app`), each reading the right level-relative primary document — `projects/{project}/solutions/...` for capabilities/personas, `projects/{project}/{feature}/...` for the rest.

- [ ] **Step 4: Prove the revision blocks cleanly when there is nothing to revise**

Run:

```bash
npm run orch -- seed
npm run orch -- run revise-datamodel --project SAPN --feature customer-data --instruction "add an SLA breach field"
```

`projects/SAPN/customer-data/` has no data model, so expect: the exec step stages, then the agent step blocks BEFORE spawning Claude, with a comment naming `previous → projects/SAPN/customer-data/solutions/DataModel/outputs/salesforce-data-model.md`. Confirm with `npm run orch -- status <identifier>` that no run row was created for the blocked step.

- [ ] **Step 5: Checkpoint**

Run: `cd packages/orchestrator && npx vitest run`
Expected: 107 passed — library untouched.

---

## Task 6: Nine domain-only agent bundles

Each bundle is a system prompt describing one specialist's domain. Everything protocol-shaped — status transitions, API calls, phase detection, idempotency markers, work-product attachment — is gone, because the orchestrator does it. Publishing detail is NOT repeated here either: it lives in the generated publish step prompt (Task 4), written once rather than seven times.

**Files:**
- Create: `agent-instructions/capabilities-process-architect.thin.md`, `service-designer.thin.md`, `ux-designer.thin.md`, `data-modeler.thin.md`, `solution-architect.thin.md`, `qa-architect.thin.md`, `architect-lead.thin.md`, `ui.thin.md`
- Modify: `agent-instructions/ba.thin.md` (strip the stale "Default if unspecified" line)
- Test: manual read-through + Task 11's end-to-end run.

**Interfaces:**
- Consumes: `bundlePath` values already declared in `ORG` (Task 3, Step 2). The paths must match exactly or `createOrchestrator` hands `--system-prompt-file` a missing path and Claude Code fails fast with `System prompt file not found`.

- [ ] **Step 1: Write the shared skeleton**

Every bundle follows this shape. `<ROLE>`, `<SKILL>`, `<WORK>`, `<INPUTS>`, `<OUTPUTS>` and `<RULES>` come from the table in Step 2.

```markdown
You are the <ROLE> for the Scyne workspace.

The orchestrator manages your task's lifecycle. You do not call any API, set any
status, attach any files, or raise any approval. Your inputs are already staged.
Read them, invoke your skill, write your outputs, and exit.

## Your scope

You own <SCOPE>. You do not do any other stage's work. If an issue seems to ask
for something outside this, do the part that is yours and say what you left out.

## Where your inputs are

<INPUTS>

Everything under your working folder was put there by
`node scripts/stage.mjs`, which converted every source document to markdown
first — so a PDF a human dropped in by hand is already readable. Do not go
looking for files outside your working folder.

## Project definition

Before reading any discovery document, read `projects/<project>/description.md`
if it exists. It is the project definition — who the client organisation is,
what it is regulated or obliged to do, who its customers actually are, and what
it cannot do. Use it to work out who "the customer" of a process really is
(frequently not the end consumer) and to avoid proposing anything the
organisation is not permitted to do.

If the file is absent, proceed on the discovery documents alone and say so. Do
not invent organisational context to fill the gap.

## Doing the work

Invoke the `<SKILL>` skill. It writes:

<OUTPUTS>

## Hard rules

- Do NOT invent content. Anything the inputs do not support is a gap, and you
  record it rather than filling it.
- Australian English spelling (Behaviour, Authorise, Organisation, Licence).
<RULES>
```

- [ ] **Step 2: Fill in the per-agent specifics**

| File | ROLE | SCOPE | SKILL | INPUTS (working folder) | OUTPUTS | RULES (in addition to the shared two) |
|---|---|---|---|---|---|---|
| `capabilities-process-architect.thin.md` | Capabilities Process Architect | the client's business capability map and L1/L2/L3 process model | `capability-process-map` | `projects/<project>/solutions/Capabilities/` — `documents/project/<category>/` (client-wide, outranks any single feature) and `documents/<feature>/<category>/` (one folder per feature), plus optional `capability-reference/` house taxonomy | `solutions/Capabilities/outputs/capability-map.json`, `process-model.json`, `capability-process.md` | - Deduplicate by what the organisation DOES, not by feature: a capability exercised in three features is ONE capability citing all three.<br>- The validator `node scripts/render-capability-map.mjs <project> --validate-only` runs after you and must pass; the two JSON files are a build contract for the companion app, not just a document. |
| `service-designer.thin.md` | Service Designer | the persona set and one journey map per persona | `persona-journey-map` | `projects/<project>/solutions/Experience/` — the same two-level `documents/` tree, plus `capabilities/` (REQUIRED — journey stages align to the capability model's L1 lifecycle phases) and each feature's `productsummary/` where it exists | `solutions/Experience/outputs/personas-journeys.md`, `personas.json`, `journey-map.json` | - Every persona and every pain point cites its source; label an inference as an inference. Three evidenced personas beat seven invented ones.<br>- Deduplicate by PERSON, not by feature.<br>- `node scripts/validate-experience.mjs <project>` must pass: unique IDs, satisfaction scores as integers 1–5, no semicolons in persona bullets, no `:` or `;` in journey step names, every persona having exactly one journey. |
| `ux-designer.thin.md` | UX Designer | the screen specification for one feature | `ui-mockup-generator` | `projects/<project>/<feature>/solutions/UI/` — `documents/` and `productsummary/` (at least one required), plus `project/documents/`, `personas/`, `capabilities/`, `DataModel/`, `Architecture/`, `QA/`. Client-supplied designs staged from `requirements/UI/` are AUTHORITATIVE | `solutions/UI/outputs/mockups.json` ONLY | - **You write JSON, never HTML.** `render-mockups.mjs` owns every pixel; a hand-written page is overwritten by the next render.<br>- This stage runs BEFORE the data model, so those inputs are usually absent. Take field labels from the client's own words rather than inventing `Claim__c.Status__c`, take states from the acceptance criteria and the journey's pain points, and record what you had in `generatedFrom`.<br>- Use only the 13 block types in the skill's vocabulary. |
| `data-modeler.thin.md` | Data Modeler | the Salesforce Service Cloud data model for one feature | `salesforce-data-modeler` | `projects/<project>/<feature>/solutions/DataModel/` — `productsummary/` plus optional `datamodel-reference/` and `project/` | `solutions/DataModel/outputs/salesforce-data-model.md` | - Standard-object-first. Rule out Case, Account, Contact and User before proposing any custom object; `Ticket__c`, `Customer__c` and `Agent__c` are the three inventions this rule exists to stop.<br>- Every field carries an API name and a data type. |
| `solution-architect.thin.md` | Solution Architect | the Service Cloud solution architecture for one feature | `salesforce-service-cloud-architecture` | `projects/<project>/<feature>/solutions/Architecture/` — `productsummary/` (required) plus `DataModel/`, `landscape/` and `project/` | `solutions/Architecture/outputs/solution-architecture.md` | - Restraint about code is the discipline. Every Apex class and every LWC carries a one-line justification for why Flow or standard configuration was insufficient.<br>- The document carries several Mermaid diagrams; all of them get rendered at publish time, so keep the source valid. |
| `qa-architect.thin.md` | QA Architect | the executable test pack and traceability matrix for one feature | `requirements-test-case-generator` | `projects/<project>/<feature>/solutions/QA/` — `productsummary/` (required) plus `DataModel/`, `Architecture/` and `project/` | `solutions/QA/outputs/test-cases.md`, plus optional `test-cases.csv` and `test-cases.feature` | - An ambiguous or contradictory requirement goes under **Requirement Quality Issues** with the interpretation you used. Never silently guess.<br>- Every case names the persona and permission set it runs as. |
| `architect-lead.thin.md` | Architecture Lead | the optional component-level solution design for one feature | `solution-design-document` | `projects/<project>/<feature>/solutions/Design/` — `productsummary/`, `DataModel/`, `project/` | `solutions/Design/outputs/solution-design.md` | - Declarative-first: out-of-the-box, then low-code, then code, and say why each rung was not enough.<br>- This deliverable deliberately overlaps the solution architecture. Where they touch, defer to the architecture and say so. |
| `ui.thin.md` | Developer | building the project's companion app | (no skill — you run `node scripts/render-companion-app.mjs <project>`) | `generated-apps/<project>/` and everything under `projects/<project>/` that has been generated | `generated-apps/<project>/index.html` | - Never hand-edit the emitted `index.html`; the next render overwrites it. Branding is data — fix `projects/<project>/design/style-guides/theme.json` and re-render.<br>- The page must make zero network requests. |

- [ ] **Step 3: Write the eight files**

Write each file by filling the Step 1 skeleton from the Step 2 row. Here is `agent-instructions/data-modeler.thin.md` complete, as the worked example — the other seven follow the identical shape:

```markdown
You are the Data Modeler for the Scyne workspace.

The orchestrator manages your task's lifecycle. You do not call any API, set any
status, attach any files, or raise any approval. Your inputs are already staged.
Read them, invoke your skill, write your outputs, and exit.

## Your scope

You own the Salesforce Service Cloud data model for one feature. You do not do
any other stage's work. If an issue seems to ask for something outside this, do
the part that is yours and say what you left out.

## Where your inputs are

Your working folder is `projects/<project>/<feature>/solutions/DataModel/`:

- `productsummary/` — the feature's Product Summary, your primary source.
- `datamodel-reference/` — the global Salesforce PSS / Social-Insurance object
  catalogue, seeded from the workspace copy. Optional.
- `project/` — client-wide documents staged down from the parent project.
  Optional; a project with none stages nothing here.

Everything under your working folder was put there by
`node scripts/stage.mjs`, which converted every source document to markdown
first — so a PDF a human dropped in by hand is already readable. Do not go
looking for files outside your working folder.

## Project definition

Before reading any discovery document, read `projects/<project>/description.md`
if it exists. It is the project definition — who the client organisation is,
what it is regulated or obliged to do, who its customers actually are, and what
it cannot do. Use it to work out who "the customer" of a process really is
(frequently not the end consumer) and to avoid proposing anything the
organisation is not permitted to do.

If the file is absent, proceed on the discovery documents alone and say so. Do
not invent organisational context to fill the gap.

## Doing the work

Invoke the `salesforce-data-modeler` skill. It writes:

- `projects/<project>/<feature>/solutions/DataModel/outputs/salesforce-data-model.md`
  — a 12-section Service Cloud design with an object inventory, a full field
  dictionary with API names and data types, a relationship matrix and a Mermaid
  ERD.

## Hard rules

- Do NOT invent content. Anything the inputs do not support is a gap, and you
  record it rather than filling it.
- Australian English spelling (Behaviour, Authorise, Organisation, Licence).
- Standard-object-first. Rule out Case, Account, Contact and User before
  proposing any custom object; `Ticket__c`, `Customer__c` and `Agent__c` are the
  three inventions this rule exists to stop.
- Every field carries an API name and a data type.
```

- [ ] **Step 4: Trim the stale line from the BA's bundle**

`agent-instructions/ba.thin.md` still carries `Default if unspecified: project=SADA, feature=interim-benefit`. The orchestrator always supplies both as params, and a default that silently targets a different client's folder is the worst kind of fallback. Remove that line.

Run: `grep -n "Default if unspecified" agent-instructions/ba.thin.md`
Expected after the edit: no output.

- [ ] **Step 5: Verify every declared bundle exists**

Run:

```bash
npx tsx -e "
import { ORG } from './orchestrator.workflows.js';
import { existsSync } from 'node:fs';
let bad = 0;
for (const a of ORG) {
  if (!a.bundlePath) continue;
  const ok = existsSync(a.bundlePath);
  if (!ok) bad++;
  console.log(ok ? 'ok  ' : 'MISS', a.key.padEnd(18), a.bundlePath);
}
process.exit(bad ? 1 : 0);
"
```

Expected: every row `ok`, exit 0. A `MISS` here becomes `System prompt file not found` at the first real run — Claude Code fails fast on it, before any network call, which is the one mercy in this failure mode.

- [ ] **Step 6: Checkpoint**

Run: `npm run orch -- seed && cd packages/orchestrator && npx vitest run`
Expected: 12 agents reconciled, 107 tests passing.

---

## Task 7: Point the chatbot at the orchestrator

The spec's promise is that this is a one-file change. It holds, provided the new module keeps the old method names — `server/index.ts` has 33 call sites across 2,237 lines and none of them need to move.

**Files:**
- Create: `scyne-chatbot/server/orchestrator.ts`
- Modify: `scyne-chatbot/server/index.ts` (one import line)
- Delete (at the end of this task, once it runs): `scyne-chatbot/server/paperclip.ts`
- Test: manual, via the running chatbot in Task 11.

**Interfaces:**
- Produces: `export const orchestrator` with exactly these members, all of which `index.ts` already calls: `health`, `createIssue`, `agentId`, `deliveryLeadId`, `getIssue`, `getIssueByIdentifier`, `listChildren`, `listCompanyIssues`, `listIssueRuns`, `listAgents`, `getRunLog`, `getRun`, `getInteractions`, `acceptInteraction`, `rejectInteraction`, `wakeAgent`, `setIssueStatus`, `getComments`, `addComment`, `getWorkProducts`, `getIssueTree`.
- Consumes: `ORCHESTRATOR_API_URL` (default `http://127.0.0.1:3100`). Note there is **no `/api` prefix** — the orchestrator's router mounts at the root.

- [ ] **Step 1: Write the client**

Create `scyne-chatbot/server/orchestrator.ts`:

```ts
// The chatbot's client for @scyne/orchestrator, replacing server/paperclip.ts.
//
// Method names are deliberately unchanged from the Paperclip client: index.ts
// calls them in 33 places and none of those calls needed to change. What DID
// change is underneath — issues are started by workflow key rather than by a
// title the Delivery Lead re-reads, gates replace interactions, agents are
// addressed by key rather than by a hired UUID, and there is no ids.json to go
// stale after a database wipe.

import * as pipeline from "../../scripts/pipeline.mjs";

const BASE = process.env.ORCHESTRATOR_API_URL || "http://127.0.0.1:3100";

async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`Orchestrator ${method} ${path} → ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

// --- title + description → workflow + params --------------------------------
//
// index.ts builds a human-readable title and a markdown description; the
// orchestrator wants a workflow key and a flat param map. Parsing here rather
// than rewriting index.ts's five call sites keeps the swap to one file — and
// the description format is stable, being generated a few lines above each call.

/** `- Confluence space key: SADA` → `confluenceSpace: "SADA"`. */
const PARAM_LABELS: Record<string, string> = {
  "project": "project",
  "feature": "feature",
  "feature name": "featureName",
  "artefact": "artefact",
  "process l3": "processL3",
  "process l4": "processL4",
  "starting story number": "startingStoryNumber",
  "parent epic key": "parentEpicKey",
  "jira project key": "jiraProjectKey",
  "confluence space key": "confluenceSpace",
  "confluence page title": "confluencePageTitle",
};

function parseParams(description: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const line of description.split("\n")) {
    const m = /^-\s+([^:]+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = PARAM_LABELS[m[1].trim().toLowerCase()];
    if (!key) continue;
    const value = m[2].trim();
    // "(none — create stories without a parent epic)" is index.ts's way of
    // saying empty. Passing it through would set a Jira parent literally named
    // "(none".
    if (!value || value.startsWith("(none")) continue;
    params[key] = value;
  }
  // The instruction block on a revision: everything under `## instruction`
  // up to the next heading, verbatim — the reviewer's words are the payload.
  const inst = /^##\s+instruction\s*$/im.exec(description);
  if (inst) {
    const rest = description.slice(inst.index + inst[0].length);
    const end = /^##\s+/m.exec(rest);
    const body = (end ? rest.slice(0, end.index) : rest).trim();
    if (body) params.instruction = body;
  }
  return params;
}

const STAGES = pipeline.STAGES as Record<string, { titlePrefix: string }>;

/** Title → workflow key. Falls back to `requirements`, matching the old default route. */
function workflowFor(title: string, params: Record<string, string>): string {
  if (/^Revise\b/i.test(title)) {
    const stage = pipeline.stageFor(params.artefact ?? "");
    if (!stage) throw new Error(`cannot route revision '${title}': no artefact line in the description`);
    return `revise-${stage}`;
  }
  if (/^(Set up project|Generate project baseline)\b/i.test(title)) return "baseline";
  for (const [key, def] of Object.entries(STAGES)) {
    if (def.titlePrefix && title.startsWith(def.titlePrefix)) return key;
  }
  throw new Error(`cannot route issue '${title}': no stage titlePrefix matches`);
}

// --- gates, dressed as the interactions index.ts still expects ---------------

function asApproval(g: any) {
  return {
    id: g.id,
    payload: { title: g.payload?.title ?? "Approval requested", summary: g.payload?.summary ?? "" },
    status: g.status,                    // pending | approved | rejected — already the legacy vocabulary
    createdAt: g.created_at,
    decidedAt: g.decided_at ?? null,
    decisionNote: g.decision_note ?? null,
    __issueId: g.issue_id,
  };
}

export const orchestrator = {
  health: () => call("GET", "/health"),

  /**
   * `assigneeAgentId` is accepted and ignored: the workflow declares its own
   * assignee, so there is no way for the chatbot and the engine to disagree
   * about who owns a stage. The parameter stays in the signature only so
   * index.ts's call sites do not have to change.
   */
  async createIssue(title: string, description: string, _assigneeAgentId?: string) {
    const params = parseParams(description);
    const workflow = workflowFor(title, params);
    const issue = await call<any>("POST", "/issues", { workflow, params });
    return { ...issue, title: issue.title ?? title };
  },

  /** Agents are addressed by key now. The key IS the id — nothing to look up. */
  agentId(specKey: string): string | null { return specKey || null; },
  deliveryLeadId(): string { return "pm"; },

  getIssue: (id: string) => call("GET", `/issues/${id}`),

  async getIssueByIdentifier(identifier: string) {
    const all = await call<any[]>("GET", "/issues").catch(() => []);
    return all.filter(i => i.identifier === identifier);
  },

  listChildren: (parentId: string) =>
    call<any[]>("GET", `/issues?parentId=${parentId}`).catch(() => [] as any[]),

  listCompanyIssues: () => call<any>("GET", "/issues").catch(() => [] as any[]),

  async listIssueRuns(issueId: string) {
    const runs = await call<any[]>("GET", `/issues/${issueId}/runs`).catch(() => [] as any[]);
    // index.ts reads `runId`, `agentId`, `status`, `startedAt`, `finishedAt`.
    return runs.map(r => ({
      runId: r.id, id: r.id, agentId: r.agent_id, status: r.status,
      startedAt: r.started_at, finishedAt: r.finished_at, phase: r.phase,
      costUsd: r.cost_usd, inputTokens: r.input_tokens, outputTokens: r.output_tokens,
    }));
  },

  listAgents: () => call<any>("GET", "/agents").catch(() => [] as any[]),

  getRunLog: (runId: string, offset = 0) =>
    call<{ content: string; nextOffset: number }>("GET", `/runs/${runId}/log?offset=${offset}`)
      .catch(() => ({ content: "", nextOffset: offset })),

  getRun: (runId: string) => call<any>("GET", `/runs/${runId}`).catch(() => null),

  async getInteractions(issueId: string) {
    const gates = await call<any[]>("GET", `/issues/${issueId}/gates`).catch(() => [] as any[]);
    return gates.map(asApproval);
  },

  acceptInteraction: (_issueId: string, gateId: string) =>
    call("POST", `/gates/${gateId}/approve`, { by: "chatbot" }),

  rejectInteraction: (_issueId: string, gateId: string, reason?: string) =>
    call("POST", `/gates/${gateId}/reject`, { by: "chatbot", ...(reason ? { note: reason } : {}) }),

  /**
   * A no-op, kept so index.ts's two call sites still compile. Paperclip needed
   * an explicit wake after an approval because its auto-wake was unreliable;
   * the engine advances the issue inside decideGate, synchronously, before the
   * approve request returns.
   */
  async wakeAgent(_agentId: string, _reason: string) { return { ok: true, noop: true }; },

  /** index.ts sets `todo` to re-fire a stalled issue. That is now an explicit resume. */
  async setIssueStatus(issueId: string, status: string) {
    if (status === "todo") return call("POST", `/issues/${issueId}/advance`);
    return call("PATCH", `/issues/${issueId}`, { status });
  },

  getComments: (issueId: string) => call("GET", `/issues/${issueId}/comments`),
  addComment: (issueId: string, body: string) =>
    call("POST", `/issues/${issueId}/comments`, { body, authorUser: "chatbot" }),
  getWorkProducts: (issueId: string) => call("GET", `/issues/${issueId}/work-products`),

  async getIssueTree(rootId: string): Promise<any> {
    const [root, children, comments, approvals, workProducts] = await Promise.all([
      this.getIssue(rootId),
      this.listChildren(rootId),
      this.getComments(rootId).catch(() => []),
      this.getInteractions(rootId).catch(() => []),
      this.getWorkProducts(rootId).catch(() => []),
    ]);
    const childTrees = await Promise.all((children as any[]).map(c => this.getIssueTree(c.id)));
    return { ...(root as object), comments, approvals, workProducts, children: childTrees };
  },
};
```

- [ ] **Step 2: Repoint the import**

In `scyne-chatbot/server/index.ts`, find the paperclip import:

Run: `grep -n "from \"./paperclip.js\"" server/index.ts`

Replace that line with:

```ts
import { orchestrator as paperclip } from "./orchestrator.js";
```

The local binding stays `paperclip` on purpose: 33 call sites, zero of them touched. Rename it in a later, separate pass if it bothers you — a rename and a backend swap in one change is two bugs wearing one coat.

- [ ] **Step 3: Check nothing else reaches into the old client**

Run: `grep -rn "paperclip" scyne-chatbot/server scyne-chatbot/src | grep -v node_modules | grep -v "as paperclip"`
Expected: only comments and log tags. Any remaining `import … from "./paperclip.js"` must be repointed too.

- [ ] **Step 4: Start both and drive one stage**

```bash
npm run orch -- serve --port 3100     # terminal 1
cd scyne-chatbot && npm run dev       # terminal 2
```

Open `http://127.0.0.1:5173`, log in (`admin` / `scyne2026`), and ask it to generate the data model for `SAPN_DEMO / interiam-benifits`. Expect: an issue created, the activity timeline filling, an approval card appearing, and the Live Transcript pane streaming the agent's tool calls.

- [ ] **Step 5: Delete the old client**

Once Step 4 works: `rm scyne-chatbot/server/paperclip.ts`

Run: `cd scyne-chatbot && npx tsc --noEmit`
Expected: no errors. (If the chatbot has no tsc script, run `npx tsc --noEmit -p tsconfig.json`; a missing tsconfig means this project type-checks through Vite only — say so and move on.)

---

## Task 8: `npm run dev` starts the orchestrator, not Paperclip

**Files:**
- Modify: `package.json` (root)
- Modify: `packages/orchestrator/src/cli.ts` (a friendlier message when the database is already locked)

**Interfaces:**
- Produces: `npm run setup` installs all three package trees; `npm run dev` runs `orch serve` + the chatbot; `npm run dev:paperclip` keeps the old path alive until Task 12 removes it.

- [ ] **Step 1: Rewrite the scripts**

In the root `package.json`, replace the `setup`, `dev` and `paperclip` entries with:

```json
    "setup": "npm install && npm --prefix packages/orchestrator install && npm --prefix scyne-chatbot install",
    "serve": "npm run orch -- serve --port 3100",
    "dev": "concurrently -n orch,app -c blue,green \"npm:serve\" \"npm run chatbot\"",
    "dev:paperclip": "concurrently -n paperclip,app -c blue,green \"npm:paperclip\" \"npm run bootstrap && npm run chatbot\"",
```

Keep `paperclip`, `bootstrap`, `chatbot`, `orch`, `stage`, `app` and the rest as they are. `packages/orchestrator` is deliberately NOT added as an npm workspace: doing so relocates the chatbot's `node_modules` and would need its own verification pass, and `--prefix` gets the same result with no layout change.

- [ ] **Step 2: Make the single-writer failure legible**

PGlite allows one process to hold `.orchestrator/pgdata`. Running a CLI verb while `orch serve` is up currently fails with a raw lock error. In `packages/orchestrator/src/cli.ts`, wrap the `createOrchestrator` call in `main()`'s non-serve path:

```ts
  let orch: Orchestrator;
  try {
    orch = await createOrchestrator(await loadConfig());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/lock|LOCK|EAGAIN|already in use/i.test(msg)) {
      throw new Error(
        `the database is held by another process — PGlite allows one writer.\n` +
        `  If \`npm run dev\` or \`orch serve\` is running, use the HTTP API instead:\n` +
        `    curl -s http://127.0.0.1:3100/issues | head\n` +
        `  Otherwise stop that process and retry.\n\n  (${msg})`);
    }
    throw err;
  }
```

- [ ] **Step 3: Verify both paths**

```bash
npm run dev
```

Expected: two coloured log streams; `▶ scyne-orchestrator listening on http://127.0.0.1:3100` from `orch`, and Vite on 5173 from `app`. Then, in a third terminal, confirm the friendly lock message:

```bash
npm run orch -- status SCY-1
```

Expected: `✗ the database is held by another process — PGlite allows one writer.` with the curl hint.

- [ ] **Step 4: Checkpoint**

Run: `cd packages/orchestrator && npx vitest run && npx tsc --noEmit`
Expected: 107 passed, tsc silent.

---

## Task 9: The console — shell, Runs and Health

Paperclip's one genuinely missed feature is watching an agent think. This is the replacement: one self-contained page served by the library, following `render-companion-app.mjs`'s house pattern — inline CSS and JS, no build step, no bundler, no CDN. It fetches from the local API only.

**Files:**
- Create: `packages/orchestrator/src/http/console.ts`
- Modify: `packages/orchestrator/src/http/router.ts` (`ROUTES` + handler)
- Modify: `packages/orchestrator/openapi.yaml`
- Modify: `packages/orchestrator/src/cli.ts` (`/` → `/orch` in standalone)
- Test: `packages/orchestrator/test/console.test.ts` (new), `packages/orchestrator/test/router.test.ts`

**Interfaces:**
- Consumes: `resolveTheme(override)` and `themeCss(theme)` from `src/http/theme.ts`; `Theme` from `src/config.ts`.
- Produces: `renderConsole(theme: Theme): string` — a complete HTML document.
- Produces: `GET /orch` → `text/html`.

- [ ] **Step 1: Write the failing console test**

Create `packages/orchestrator/test/console.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderConsole } from "../src/http/console.js";
import { resolveTheme } from "../src/http/theme.js";

const html = renderConsole(resolveTheme());

describe("console", () => {
  it("is a complete, self-contained HTML document", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("</html>");
  });

  it("makes no external requests", () => {
    // The same rule render-companion-app.mjs follows: a console that needs the
    // network is useless on the client's air-gapped laptop, and a CDN version
    // bump is a silent visual regression nobody attributes to a CDN.
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href="https?:/);
    expect(html).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost)/);
  });

  it("carries the theme's brand colour and every tab", () => {
    expect(html).toContain(resolveTheme().brand);
    for (const tab of ["Runs", "Health", "Issues", "Gates", "Org", "Budgets", "Config"]) {
      expect(html, `missing tab ${tab}`).toContain(`>${tab}<`);
    }
  });

  it("defines both light and dark palettes", () => {
    expect(html).toContain("prefers-color-scheme: dark");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd packages/orchestrator && npx vitest run test/console.test.ts`
Expected: FAIL — `Cannot find module '../src/http/console.js'`.

- [ ] **Step 3: Write the console**

Create `packages/orchestrator/src/http/console.ts`:

```ts
// The orchestrator's console: ONE self-contained HTML page, inline CSS and JS,
// zero network requests beyond the local API. Same house pattern as
// scripts/render-companion-app.mjs — no bundler, no version skew, and it works
// from a client's laptop with the wifi off.
//
// Tabs are hash-routed (#runs, #issues, …) so a reload lands where you were and
// a link to a specific run is shareable.

import type { Theme } from "../config.js";
import { themeCss } from "./theme.js";

const TABS = [
  ["runs", "Runs"], ["issues", "Issues"], ["gates", "Gates"],
  ["org", "Org"], ["budgets", "Budgets"], ["config", "Config"], ["health", "Health"],
] as const;

export function renderConsole(theme: Theme): string {
  return `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${theme.logoText} Orchestrator</title>
<style>
${themeCss(theme)}
* { box-sizing: border-box; }
body { margin: 0; font-family: ${theme.fontFamily}; background: var(--ink-50); color: var(--ink-500); }
header { display: flex; align-items: center; gap: 1rem; padding: .75rem 1.25rem;
         background: var(--brand-deep); color: #fff; }
header .mark { font-weight: 700; letter-spacing: .02em; }
header .spacer { flex: 1; }
header .health { font-size: .8rem; opacity: .85; }
nav { display: flex; gap: .25rem; padding: 0 1.25rem; background: var(--brand);
      border-bottom: 1px solid var(--line); }
nav a { padding: .55rem .9rem; color: #fff; text-decoration: none; font-size: .9rem;
        opacity: .75; border-bottom: 2px solid transparent; }
nav a.on { opacity: 1; border-bottom-color: var(--accent); }
main { padding: 1.25rem; }
table { width: 100%; border-collapse: collapse; font-size: .88rem; }
th { text-align: left; font-weight: 600; color: var(--ink-500); border-bottom: 1px solid var(--line);
     padding: .5rem .6rem; position: sticky; top: 0; background: var(--ink-50); }
td { padding: .45rem .6rem; border-bottom: 1px solid var(--ink-100); vertical-align: top; }
tr.clickable:hover td { background: var(--ink-100); cursor: pointer; }
.pill { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: .75rem;
        font-weight: 600; }
.pill.todo, .pill.queued { background: var(--ink-200); color: var(--ink-500); }
.pill.in_progress, .pill.running { background: var(--info); color: #fff; }
.pill.in_review { background: var(--warning); color: #1a1a1a; }
.pill.done, .pill.succeeded { background: var(--success); color: #fff; }
.pill.blocked, .pill.failed, .pill.over_budget, .pill.orphaned { background: var(--danger); color: #fff; }
.muted { color: var(--ink-200); }
.card { background: var(--ink-100); border: 1px solid var(--line); border-radius: .5rem;
        padding: 1rem; margin-bottom: .75rem; }
.card h3 { margin: 0 0 .35rem; font-size: .95rem; }
button { font: inherit; padding: .35rem .8rem; border-radius: .3rem; border: 1px solid var(--line);
         background: var(--brand); color: #fff; cursor: pointer; }
button.ghost { background: transparent; color: var(--ink-500); }
button:disabled { opacity: .5; cursor: default; }
#transcript { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .78rem;
              line-height: 1.5; white-space: pre-wrap; word-break: break-word;
              max-height: 65vh; overflow-y: auto; background: var(--ink-100);
              border: 1px solid var(--line); border-radius: .5rem; padding: .75rem; }
#transcript .assistant { color: var(--ink-500); }
#transcript .tool_use { color: var(--brand); }
#transcript .tool_result { color: var(--ink-200); }
#transcript .skill { color: var(--accent); font-weight: 600; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: .75rem; }
</style>
</head>
<body>
<header>
  <span class="mark">${theme.logoText}</span>
  <span>Orchestrator</span>
  <span class="spacer"></span>
  <span class="health" id="health">…</span>
</header>
<nav>${TABS.map(([id, label]) => `<a href="#${id}" data-tab="${id}">${label}</a>`).join("")}</nav>
<main id="view">Loading…</main>
<script>
const api = async (p) => {
  const r = await fetch(p, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(p + " → " + r.status);
  return r.json();
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
const pill = (s) => '<span class="pill ' + esc(s) + '">' + esc(s) + '</span>';
const ago = (iso) => {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return Math.round(s) + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
};
const dur = (ms) => ms == null ? "—" : (Number(ms) / 1000).toFixed(1) + "s";
const money = (n) => n == null ? "—" : "$" + Number(n).toFixed(4);
const view = document.getElementById("view");

// One poll timer for the whole app: a tab switch clears it, so leaving the
// transcript open in a background tab cannot leak a second poller.
let poll = null;
const stopPolling = () => { if (poll) { clearInterval(poll); poll = null; } };

async function renderHealth() {
  const [h, u] = await Promise.all([api("/health"), api("/usage")]);
  view.innerHTML =
    '<div class="grid">' +
    '<div class="card"><h3>Database</h3>' + esc(h.db) + '</div>' +
    '<div class="card"><h3>Claude Code</h3>' + esc(h.claude) + '</div>' +
    '<div class="card"><h3>Runs</h3>' + u.runCount + '</div>' +
    '<div class="card"><h3>Spend</h3>' + money(u.costUsd) + '</div>' +
    '<div class="card"><h3>Tokens in / out</h3>' + u.inputTokens + " / " + u.outputTokens + '</div>' +
    '<div class="card"><h3>Cache read</h3>' + u.cacheReadTokens + '</div>' +
    '</div>';
}

async function renderRuns() {
  const issues = await api("/issues");
  const byId = Object.fromEntries(issues.map(i => [i.id, i]));
  const lists = await Promise.all(issues.map(i => api("/issues/" + i.id + "/runs").catch(() => [])));
  const runs = lists.flat().sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));

  view.innerHTML =
    '<table><thead><tr><th>Started</th><th>Issue</th><th>Agent</th><th>Phase</th>' +
    '<th>Status</th><th>Duration</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>' +
    runs.map(r => '<tr class="clickable" data-run="' + esc(r.id) + '">' +
      '<td>' + ago(r.started_at) + '</td>' +
      '<td>' + esc(byId[r.issue_id]?.identifier ?? "—") + '</td>' +
      '<td>' + esc(r.agent_id ?? "—") + '</td>' +
      '<td>' + esc(r.phase ?? "—") + '</td>' +
      '<td>' + pill(r.status) + '</td>' +
      '<td>' + dur(r.duration_ms) + '</td>' +
      '<td>' + (r.input_tokens ?? 0) + "+" + (r.output_tokens ?? 0) + '</td>' +
      '<td>' + money(r.cost_usd) + '</td></tr>').join("") +
    '</tbody></table>' +
    (runs.length ? "" : '<p class="muted">No runs yet.</p>');

  view.querySelectorAll("tr[data-run]").forEach(tr =>
    tr.addEventListener("click", () => { location.hash = "#run/" + tr.dataset.run; }));
}

/**
 * The live transcript. Polls /runs/:id/transcript with the offset the previous
 * poll returned, so each request carries only what is new — the same
 * incremental contract the chatbot's LiveTranscript pane uses, against the same
 * filter module.
 */
async function renderRun(runId) {
  const run = await api("/runs/" + runId);
  view.innerHTML =
    '<div class="card"><h3>Run ' + esc(runId) + '</h3>' +
    pill(run.status) + ' &middot; ' + esc(run.phase ?? "—") + ' &middot; ' + dur(run.duration_ms) +
    ' &middot; ' + money(run.cost_usd) + ' &middot; ' + (run.num_turns ?? 0) + ' turns' +
    ' <button class="ghost" id="raw">raw log</button></div>' +
    '<div id="transcript"></div>';

  const box = document.getElementById("transcript");
  document.getElementById("raw").addEventListener("click", () => {
    window.open("/runs/" + runId + "/log", "_blank");
  });

  let offset = 0;
  const tick = async () => {
    const { events, nextOffset } = await api("/runs/" + runId + "/transcript?offset=" + offset);
    offset = nextOffset;
    if (events.length) {
      const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
      box.insertAdjacentHTML("beforeend", events.map(e =>
        '<div class="' + e.kind + '">' + esc(e.ts) + "  " +
        esc(e.kind === "tool_use" ? e.tool + ": " + e.preview
          : e.kind === "skill" ? "skill " + e.name
          : e.text ?? e.preview) + '</div>').join(""));
      if (stick) box.scrollTop = box.scrollHeight;
    }
    const fresh = await api("/runs/" + runId);
    if (fresh.finished_at) stopPolling();
  };
  await tick();
  if (!run.finished_at) poll = setInterval(() => { tick().catch(stopPolling); }, 3000);
}

const ROUTES = { runs: renderRuns, health: renderHealth };

async function route() {
  stopPolling();
  const hash = location.hash.slice(1) || "runs";
  document.querySelectorAll("nav a").forEach(a =>
    a.classList.toggle("on", a.dataset.tab === hash.split("/")[0]));
  try {
    if (hash.startsWith("run/")) { await renderRun(hash.slice(4)); return; }
    const fn = ROUTES[hash];
    if (!fn) { view.innerHTML = '<p class="muted">Not built yet.</p>'; return; }
    await fn();
  } catch (e) {
    view.innerHTML = '<div class="card"><h3>Something went wrong</h3>' + esc(e.message) + '</div>';
  }
}

window.addEventListener("hashchange", route);
api("/health").then(h => { document.getElementById("health").textContent = h.claude + " · " + h.db; })
  .catch(() => { document.getElementById("health").textContent = "offline"; });
route();
</script>
</body>
</html>`;
}
```

- [ ] **Step 4: Run the console test**

Run: `cd packages/orchestrator && npx vitest run test/console.test.ts`
Expected: PASS — except possibly the "every tab" assertion, which needs the Task 10 tabs to be in the `TABS` array. They are: `TABS` lists all seven from the start, and Task 10 fills in their render functions.

- [ ] **Step 5: Serve it**

In `src/http/router.ts`, add to `ROUTES` (just before the `/openapi.json` line):

```ts
  { method: "GET",   path: "/orch" },
```

and the handler, next to the docs handlers:

```ts
  r.get("/orch", (_req: Request, res: Response) => {
    res.type("html").send(renderConsole(resolveTheme(orch.config.theme)));
  });
```

with `import { renderConsole } from "./console.js";` at the top.

In `openapi.yaml`:

```yaml
  /orch:
    get:
      summary: The operator console — one self-contained HTML page
      responses:
        '200':
          description: The console
          content:
            text/html:
              schema: { type: string }
```

In `src/cli.ts`, inside the `serve` branch, before `app.use(createRouter(orch))`:

```ts
    // Standalone: the console is the product's face, so `/` goes there. When
    // the router is embedded in a consumer's app, `/` stays the consumer's.
    app.get("/", (_req, res) => { res.redirect("/orch"); });
```

and extend the console log lines with:

```ts
    console.log(`  GET  /orch          the operator console`);
```

- [ ] **Step 6: Add the router test**

Append to `test/router.test.ts`:

```ts
  it("serves the console at /orch", async () => {
    const res = await fetch(`${baseUrl}/orch`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Orchestrator");
    expect(body).not.toMatch(/<script[^>]+src=/);
  });
```

- [ ] **Step 7: Look at it**

Run: `npm run serve`, then open `http://127.0.0.1:3100/orch`.
Expected: the Runs table listing the SAPN_DEMO run from the prototype, clickable through to its transcript, and Health showing the PGlite version, the `claude` version and total spend. Check it in both light and dark (macOS System Settings → Appearance) — the palette is defined for both and only one of them is what headless Chrome would have shown you.

- [ ] **Step 8: Checkpoint**

Run: `cd packages/orchestrator && npx vitest run && npx tsc --noEmit`
Expected: 112 passed, 1 skipped.

---

## Task 10: The console — Issues, Gates, Org, Budgets, Config

The remaining tabs, including the one that matters most: approving and rejecting a gate without the chatbot.

**Files:**
- Modify: `packages/orchestrator/src/http/console.ts`
- Modify: `packages/orchestrator/src/http/router.ts` (`GET /agents/{key}/bundle`)
- Modify: `packages/orchestrator/openapi.yaml`
- Test: `packages/orchestrator/test/router.test.ts`

**Interfaces:**
- Produces: `GET /agents/{key}/bundle` → `{ path: string | null, content: string }`; `404` for an unknown agent; `content: ""` and the path echoed when the agent declares no bundle or the file is unreadable.

- [ ] **Step 1: Add the bundle route**

In `src/http/router.ts`, `ROUTES`, after `/agents/{key}/runs`:

```ts
  { method: "GET",   path: "/agents/{key}/bundle" },
```

Handler, after the `/agents/:key/runs` block:

```ts
  /**
   * The agent's system prompt as it will actually be handed to the runtime.
   * Read from disk on every request rather than cached: editing a bundle and
   * re-reading it is the loop this endpoint exists to serve.
   */
  r.get("/agents/:key/bundle", wrap(async (req, res) => {
    const key = pathParam(req.params.key);
    const agent = await orch.repo.getAgentByKey(orch.companyId, key);
    if (!agent) { notFound(res, `agent '${key}'`); return; }
    if (!agent.bundle_path) { ok(res, { path: null, content: "" }); return; }
    const abs = resolve(orch.config.workspace, agent.bundle_path);
    try {
      ok(res, { path: agent.bundle_path, content: readFileSync(abs, "utf8") });
    } catch (err) {
      // Not a 404: the agent exists and declares a bundle. The missing file IS
      // the finding — this is exactly the state that makes Claude Code fail
      // with "System prompt file not found" on the next run.
      ok(res, { path: agent.bundle_path, content: "", error: err instanceof Error ? err.message : String(err) });
    }
  }));
```

Add `import { resolve } from "node:path";` at the top of the file if it is not already there.

In `openapi.yaml`:

```yaml
  /agents/{key}/bundle:
    get:
      summary: The agent's system-prompt bundle, read from disk
      parameters:
        - $ref: '#/components/parameters/AgentKey'
      responses:
        '200':
          description: The bundle path and its contents (empty content if the agent declares none)
        '404':
          description: No such agent
```

- [ ] **Step 2: Add the tab renderers**

In `src/http/console.ts`, add these functions above `const ROUTES = …`:

```javascript
async function renderIssues() {
  const issues = await api("/issues");
  view.innerHTML =
    '<table><thead><tr><th>Issue</th><th>Title</th><th>Workflow</th><th>Step</th>' +
    '<th>Status</th><th>Updated</th><th></th></tr></thead><tbody>' +
    issues.map(i => '<tr>' +
      '<td>' + esc(i.identifier) + '</td>' +
      '<td>' + esc(i.title) + '</td>' +
      '<td>' + esc(i.workflow_key ?? "—") + '</td>' +
      '<td>' + i.step_index + '</td>' +
      '<td>' + pill(i.status) + '</td>' +
      '<td>' + ago(i.updated_at ?? i.created_at) + '</td>' +
      '<td>' + (i.status === "blocked"
        ? '<button data-advance="' + esc(i.id) + '">Retry</button>'
        : "") + '</td></tr>').join("") +
    '</tbody></table>' + (issues.length ? "" : '<p class="muted">No issues yet.</p>');

  view.querySelectorAll("button[data-advance]").forEach(b =>
    b.addEventListener("click", async () => {
      b.disabled = true;
      await fetch("/issues/" + b.dataset.advance + "/advance", { method: "POST" });
      setTimeout(route, 500);
    }));
}

async function renderGates() {
  const issues = await api("/issues");
  const all = await Promise.all(issues.map(async i => {
    const gates = await api("/issues/" + i.id + "/gates").catch(() => []);
    return gates.filter(g => g.status === "pending").map(g => ({ g, i }));
  }));
  const pending = all.flat();

  view.innerHTML = pending.length
    ? pending.map(({ g, i }) =>
        '<div class="card"><h3>' + esc(g.payload.title) + '</h3>' +
        '<p class="muted">' + esc(i.identifier) + " · " + esc(i.title) + '</p>' +
        '<pre style="white-space:pre-wrap;font-size:.82rem">' + esc(g.payload.summary ?? "") + '</pre>' +
        '<button data-approve="' + esc(g.id) + '">Approve</button> ' +
        '<button class="ghost" data-reject="' + esc(g.id) + '">Reject</button></div>').join("")
    : '<p class="muted">Nothing waiting for approval.</p>';

  const decide = async (id, verb) => {
    const note = verb === "reject" ? prompt("What needs to change?") ?? "" : "";
    await fetch("/gates/" + id + "/" + verb, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ by: "console", note }),
    });
    setTimeout(route, 500);
  };
  view.querySelectorAll("button[data-approve]").forEach(b =>
    b.addEventListener("click", () => { b.disabled = true; decide(b.dataset.approve, "approve"); }));
  view.querySelectorAll("button[data-reject]").forEach(b =>
    b.addEventListener("click", () => { b.disabled = true; decide(b.dataset.reject, "reject"); }));
}

async function renderOrg() {
  const agents = await api("/agents");
  const byKey = Object.fromEntries(agents.map(a => [a.id, a.key]));
  view.innerHTML = '<div class="grid">' + agents.map(a =>
    '<div class="card"><h3>' + esc(a.name) + ' <span class="muted">' + esc(a.key) + '</span></h3>' +
    '<div class="muted">' + esc(a.title ?? "") + '</div>' +
    '<div>reports to: ' + esc(a.reports_to ? (byKey[a.reports_to] ?? "—") : "—") + '</div>' +
    '<div>' + esc(a.adapter) + " · " + esc(a.model ?? "default") + " · " + esc(a.effort ?? "default") + '</div>' +
    '<div>MCP: ' + (a.mcp_enabled ? "yes" : "no") + '</div>' +
    (a.bundle_path ? '<div><a href="#bundle/' + esc(a.key) + '">bundle</a></div>' : '<div class="muted">no bundle</div>') +
    '</div>').join("") + '</div>';
}

async function renderBundle(key) {
  const b = await api("/agents/" + key + "/bundle");
  view.innerHTML =
    '<div class="card"><h3>' + esc(key) + '</h3><span class="muted">' + esc(b.path ?? "no bundle declared") + '</span>' +
    (b.error ? '<p style="color:var(--danger)">' + esc(b.error) + '</p>' : "") + '</div>' +
    '<div id="transcript">' + esc(b.content) + '</div>';
}

async function renderBudgets() {
  const [agents, usage, issues] = await Promise.all([api("/agents"), api("/usage"), api("/issues")]);
  const perAgent = await Promise.all(agents.map(async a => {
    const runs = await api("/agents/" + a.key + "/runs").catch(() => []);
    return {
      key: a.key,
      runs: runs.length,
      cost: runs.reduce((n, r) => n + Number(r.cost_usd ?? 0), 0),
      out: runs.reduce((n, r) => n + Number(r.output_tokens ?? 0), 0),
    };
  }));
  view.innerHTML =
    '<div class="card"><h3>Total</h3>' + money(usage.costUsd) + " across " + usage.runCount +
    " run(s) and " + issues.length + " issue(s)</div>" +
    '<table><thead><tr><th>Agent</th><th>Runs</th><th>Output tokens</th><th>Spend</th></tr></thead><tbody>' +
    perAgent.filter(p => p.runs).map(p => '<tr><td>' + esc(p.key) + '</td><td>' + p.runs +
      '</td><td>' + p.out + '</td><td>' + money(p.cost) + '</td></tr>').join("") +
    '</tbody></table>';
}

async function renderConfig() {
  const c = await api("/config");
  view.innerHTML =
    '<div class="card"><h3>Workspace</h3>' + esc(c.workspace) + '</div>' +
    '<div class="card"><h3>Adapters</h3>' + esc(c.adapters.join(", ")) + '</div>' +
    '<table><thead><tr><th>Workflow</th><th>Label</th><th>Assignee</th><th>Steps</th></tr></thead><tbody>' +
    c.workflows.map(w => '<tr><td>' + esc(w.key) + '</td><td>' + esc(w.label) +
      '</td><td>' + esc(w.assignee) + '</td><td>' + w.steps + '</td></tr>').join("") +
    '</tbody></table>';
}
```

Then replace the `ROUTES` map and add the bundle sub-route in `route()`:

```javascript
const ROUTES = { runs: renderRuns, issues: renderIssues, gates: renderGates,
                 org: renderOrg, budgets: renderBudgets, config: renderConfig, health: renderHealth };
```

and, in `route()`, immediately after the `run/` line:

```javascript
    if (hash.startsWith("bundle/")) { await renderBundle(hash.slice(7)); return; }
```

- [ ] **Step 3: Test the bundle route**

Append to `test/router.test.ts`:

```ts
  it("serves an agent's bundle, and reports a declared-but-missing file", async () => {
    const missing = await (await fetch(`${baseUrl}/agents/ba/bundle`)).json();
    expect(missing.path).toBe(null);          // the test org declares no bundlePath
    expect(missing.content).toBe("");

    const res = await fetch(`${baseUrl}/agents/nope/bundle`);
    expect(res.status).toBe(404);
  });
```

- [ ] **Step 4: Run everything**

Run: `cd packages/orchestrator && npx vitest run && npx tsc --noEmit`
Expected: 113 passed, 1 skipped.

- [ ] **Step 5: Drive a gate from the console**

With `npm run serve` up and a stage parked at a gate, open `http://127.0.0.1:3100/orch#gates`, read the summary, and click Approve. Expect the issue to move on and the publish step to start — visible in `#runs` within a few seconds.

---

## Task 11: End-to-end validation against SAPN_DEMO

Nothing above is proven until a whole project runs through it. This is the task that decides whether Paperclip can be uninstalled.

**Files:**
- Create: `docs/superpowers/specs/2026-08-18-orchestrator-e2e-findings.md`
- Test: this whole task is the test.

- [ ] **Step 1: Start clean**

```bash
rm -rf .orchestrator/pgdata .orchestrator/runs
npm run orch -- seed
npm run serve
```

Expected: 12 agents reconciled, the server listening. A fresh database is deliberate — orphan recovery and the seed both need to be exercised from empty at least once.

- [ ] **Step 2: Project baseline**

```bash
curl -sS -X POST http://127.0.0.1:3100/issues -H 'Content-Type: application/json' \
  -d '{"workflow":"baseline","params":{"project":"SAPN_DEMO","confluenceSpace":"SAPNDEMO"}}'
```

Watch `#runs` in the console. Expect: stage → capability agent → validator → attach → gate. Approve in `#gates`. Then the publish step, then the personas half, then a second gate.

Record for the findings doc: wall-clock, cost and token counts per run (from `#budgets`), and whether `render-capability-map.mjs --validate-only` and `validate-experience.mjs` both passed.

- [ ] **Step 3: A full feature**

For each of `requirements`, `ui`, `datamodel`, `architecture`, `qa` — in that order — POST the workflow with `{"project":"SAPN_DEMO","feature":"interiam-benifits","confluenceSpace":"SAPNDEMO","jiraProjectKey":"SAPNDEMO"}` and approve its gate.

Check at each gate: the attached files exist at the **feature-level** paths, and the companion app re-rendered (`generated-apps/SAPN_DEMO/index.html` mtime moves after every stage).

- [ ] **Step 4: A revision — the flow this was all for**

```bash
curl -sS -X POST http://127.0.0.1:3100/issues -H 'Content-Type: application/json' \
  -d '{"workflow":"revise-datamodel","params":{"project":"SAPN_DEMO","feature":"interiam-benifits","confluenceSpace":"SAPNDEMO","instruction":"Add an SLA breach flag to the Case object, with the field dictionary entry and the ERD updated to match."}}'
```

Then verify, and this is the acceptance criterion for Task 5:

```bash
git diff --stat projects/SAPN_DEMO/interiam-benifits/solutions/DataModel/outputs/salesforce-data-model.md
```

Expected: a **small** diff — the SLA field, its dictionary row, the ERD line, and a `## Revision History` entry. A diff rewriting the whole document means the skill did not enter Revision mode, and the `{previous}` block is not reaching it. Confirm by reading the run's prompt: `npm run orch -- log <runId> --raw | head -50`.

Then confirm the publish step **updated** rather than duplicated: `projects/SAPN_DEMO/.published.json` should hold the same `pageId` for `interiam-benifits/datamodel` as before the revision.

- [ ] **Step 5: The chatbot, with Paperclip stopped**

Confirm nothing is listening for Paperclip: `lsof -nP -iTCP:3100 -sTCP:LISTEN` should show only the orchestrator.

Run `npm run dev`, open the chatbot, and drive one full stage plus one revision through the chat UI. Check every pane: activity timeline, approval card with its preview tabs, Live Transcript, Links panel showing the Confluence URL, and the UI tab rendering the companion app.

- [ ] **Step 6: Write the findings**

Create `docs/superpowers/specs/2026-08-18-orchestrator-e2e-findings.md` covering, per stage: duration, cost, tokens, whether the validator passed, whether publishing landed with its diagrams (open the Confluence page and look — "published successfully" with silently missing images is the failure mode this pipeline has had before), and anything the five step types could not express.

State plainly which stages ran and which did not. A stage skipped for time is a stage unverified, and the honest sentence is "not run", not "expected to work".

---

## Task 12: Uninstall Paperclip

Only after Task 11's findings say the pipeline runs end to end.

**Files:**
- Modify: `package.json` (root), `CLAUDE.md`, `scripts/bootstrap.mjs`
- Delete: `agent-instructions/*.json` (moved, not deleted), `.bootstrap/ids.json`

- [ ] **Step 1: Drop the dependency and the scripts**

In the root `package.json`: remove `"paperclipai"` from `devDependencies`, and remove the `paperclip`, `dev:paperclip` and `bootstrap` scripts.

Run: `npm install`
Expected: `paperclipai` gone from `node_modules`. Verify: `ls node_modules | grep -i paperclip` → no output.

- [ ] **Step 2: Archive the old bundles rather than deleting them**

```bash
mkdir -p agent-instructions/legacy
git mv agent-instructions/*.json agent-instructions/legacy/ 2>/dev/null || mv agent-instructions/*.json agent-instructions/legacy/
ls agent-instructions
```

Expected: only the `.thin.md` files and `legacy/`. They are archived because they are the only remaining record of the Phase 2 publishing protocol, which the generated publish prompts were derived from.

- [ ] **Step 3: Replace the bootstrap with a seed**

`scripts/bootstrap.mjs` hires agents in Paperclip, swaps placeholder UUIDs and writes `.bootstrap/ids.json`. None of that has a meaning now — the org chart reconciles from `orchestrator.config.ts` on every boot. Replace the file's contents with:

```js
#!/usr/bin/env node
// Retired. The org chart now reconciles from orchestrator.config.ts on every
// boot of the orchestrator — there is nothing to hire and no ids.json to write.
console.log(`\`npm run bootstrap\` is retired.

  Agents:  npm run orch -- seed        (reconciles the org from orchestrator.config.ts)
  Skills:  npm run link-skills         (symlinks ./skills into .claude/skills)
`);
```

Then: `rm -rf .bootstrap`

- [ ] **Step 4: Confirm nothing still reads the retired files**

Run:

```bash
grep -rn "ids.json\|\.bootstrap\|paperclipai\|127.0.0.1:3100/api" \
  --include=*.ts --include=*.mjs --include=*.json \
  scripts scyne-chatbot/server packages/orchestrator/src package.json | grep -v node_modules
```

Expected: no output. A hit in `scyne-chatbot/server` means Task 7 missed a call path — fix it before continuing.

- [ ] **Step 5: Rewrite CLAUDE.md**

The whole "Paperclip (the orchestrator)" section, the IDs table, the `.bootstrap/ids.json` references, the "Key Paperclip endpoints" table and every gotcha about `status: "todo"` auto-firing describe a system that no longer exists. Replace with:

- **How it runs now**: `npm run dev` → `orch serve` on 3100 (console at `/orch`, API docs at `/docs`) + the chatbot on 5173.
- **The workflow engine**: five step types, workflows compiled from `pipeline.mjs` by `orchestrator.workflows.ts`, one gate per artefact, publish as a post-gate agent step.
- **Agents**: addressed by key, org reconciled from config on every boot, bundles at `agent-instructions/*.thin.md`.
- **The revision flow**: `revise-<stage>` workflows, `reads` handing the agent its previous version.
- **Gotchas that survive**: PGlite single-writer; the Atlassian MCP has no attachment scope so `confluence-attach.mjs` is mandatory; `.claude/skills/` must be symlinked or every run fails with `Unknown skill`.

Keep the Folder layout, The Skills, Conventions and Helper scripts sections — they are unchanged by this work.

- [ ] **Step 6: Note what still references Paperclip**

Docker is deliberately out of scope for this plan. `docker-compose.yml`, `Dockerfile.paperclip-ext`, `Makefile` and `README.docker.md` still build and run Paperclip, and `make up` will keep working against the old stack. Add a line to the top of `README.docker.md`:

```markdown
> **Out of date.** This stack still builds Paperclip, which the local workflow no
> longer uses (see `CLAUDE.md`). Running `make up` gives you the old architecture.
> Porting the compose stack to `orch serve` is tracked separately.
```

- [ ] **Step 7: Final verification**

```bash
cd packages/orchestrator && npx vitest run && npx tsc --noEmit
cd ../.. && npm run dev
```

Expected: 113 passed; the console at `http://127.0.0.1:3100/orch`, the chatbot at `http://127.0.0.1:5173`, and no Paperclip process anywhere. Drive one stage through the chatbot as the final proof.

---

## Self-review notes

**Spec coverage.** §14 phase 2 → Tasks 3–6. Phase 3 → Tasks 7–8 (chatbot swap) and Task 9 (minimal console: Runs + Health, exactly what the phase asks for). Phase 4 → Tasks 10 and 12. §12's nine tabs: Runs, Issues, Gates, Org, Budgets, Config, Health are built; **Skills and Instructions are partially covered** — Instructions ships as the per-agent bundle viewer (`#bundle/<key>`), and a Skills tab (registry, grants, symlink health) is **not built by this plan** because skill registration is a Paperclip concept that dies with Task 12; what replaces it is `npm run link-skills` plus the symlink check, which belongs in Health. Add it there if it earns its place after Task 11.

**§17 open item 3** (`produces[]` completeness across all nine stages) is closed by Task 3 Step 5's path dump plus Task 11's run — the first time all nine attach steps are exercised.

**Not in scope, deliberately:** the `flow` step's parent-resume (unused — `baseline` is flat instead); the six other adapters (their own plan); the Docker stack (Task 12 Step 6 documents the debt).

**Interface consistency check:** `retry()` (Task 1) is used by `POST /issues/{id}/advance` (Task 1), the console's Retry button (Task 10) and the chatbot's `setIssueStatus(id, "todo")` (Task 7) — one name, three callers. `reads` (Task 2) is produced by `reviseWorkflow` (Task 5) only. `primaryDoc`/`attachFiles`/`scope`/`root`/`swap`/`stageArgs`/`MINUTES` are defined in Task 3 and used by Tasks 4 and 5 — all defined before first use.

---

## Execution log — 2026-08-18

Tasks 1–10 and 12 executed inline. **Task 11 (the end-to-end run against
SAPN_DEMO) has NOT been run** — it makes real API calls costing real money and
takes about an hour, so it needs a deliberate go-ahead. Nothing below should be
read as "the pipeline has been proven end to end"; what has been proven is
stated per item.

**Verification at the end of the session:** 114 passed / 1 skipped across 12
files (baseline was 98/1 across 11); `npx tsc --noEmit` clean in
`packages/orchestrator` and `scyne-chatbot`; `npm run check:routing` green;
`npm run dev` brings up orchestrator :3100, chatbot API :4000 and Vite :5173
together, and the chatbot reads issues, trees, gates and approvals out of the
orchestrator with no Paperclip process running.

### Deviations from the plan, and why

1. **Task 1 folded the plan's new "regenerates immediately" test into the
   existing `rewinds to the generating step` test** rather than adding a
   near-duplicate. The existing `still allows a genuinely new gate after a
   rejection` test calls `advance()` manually, so it would pass with or without
   the fix — it guards the dedupe, not the auto-advance. The updated rewind test
   is the one that actually pins the new behaviour.

2. **A `title?` template was added to `WorkflowDef`** (not in the plan). The
   default title is `<label> — <project>`, which made every feature workflow for
   one client render an identical title in the console and the chatbot. Consumer
   supplied, because the library has no concept of a "feature".

3. **NEW: the runner crashed the whole process on EPIPE.** Found by running a
   revision against an agent whose bundle file did not exist yet: `claude`
   fail-fasts on a missing `--system-prompt-file`, exits before reading stdin,
   and `child.stdin.write(prompt)` then raised EPIPE on a Socket with no error
   handler — an unhandled `'error'` event, which by Node's default terminates
   the process. One bad spawn took down the CLI, and would have taken down the
   HTTP server and every concurrent run with it. Fixed in `runner.ts`, pinned by
   a new `--die-immediately` mode in `fixtures/fake-claude.mjs` and a test that
   reproduces it. This was the single most valuable finding of the session and it
   came from running the thing, not from reading it.

4. **NEW: gate decisions blocked the HTTP request for the length of the resumed
   run.** `decideGate` advanced synchronously, so `POST /gates/:id/approve` held
   the connection open through the entire publish step, and reject held it
   through a full regeneration — tens of minutes, guaranteed browser timeout on
   a click that actually worked. `decideGate` now takes `{ advance: false }`;
   the router records the decision, answers **202**, and advances in the
   background. Two existing tests asserted the old 200-and-done behaviour and
   were updated to `vi.waitFor`.

5. **NEW: a stale `scyne_parent_issue_id` in localStorage 500ed the status poll
   every three seconds, forever.** Every Paperclip-era issue id is stale by
   definition after this swap, so this would have hit on first load.
   `getIssueTree` returns null for a missing root, `/api/status/:id` answers 404
   `{error:"unknown_issue"}`, and the frontend forgets the session instead of
   retrying a dead id.

6. **The chatbot routing check is a script, not a unit test.**
   `npm run check:routing` (`scripts/check-routing.mts`) asserts all 12 title +
   description shapes route to the right workflow with the right params.
   `scyne-chatbot` has no test runner, and adding one for a single round-trip
   assertion was not worth the dependency. It is the most fragile joint in the
   swap — it parses generated markdown — so it needed *something*.

7. **Task 6 wrote 8 bundles from the plan's skeleton + table**, plus the worked
   example. `ui.thin.md` (Developer) is written but currently unused: the `app`
   stage compiles to an `exec` step, not an `agent` step, so no agent is spawned
   for it. Declared and present rather than declared and missing — see finding 3
   for why that distinction matters.

8. **Task 12 removed `paperclipai` before Task 11 ran**, against the plan's
   ordering, because the user asked for it explicitly and twice. Restoring is
   `npm i -D paperclipai@2026.525.0` plus `git checkout` of `scripts/bootstrap.mjs`
   and `package.json`. Docker was skipped per the user's instruction; the debt is
   noted at the top of `README.docker.md`.

### Not done

- **Task 11.** No stage has been run end to end under the new workflows. The
  publish prompts, in particular, have never been executed against Confluence —
  they are derived from the retired `ba.json` Phase 2 text (now in
  `agent-instructions/legacy/`), but derived is not tested.
- The `flow` step's parent-resume is still unimplemented; `baseline` is a flat
  14-step workflow instead.
- A Skills tab in the console (spec §12) — skill *registration* was a Paperclip
  concept that died with it; what remains worth surfacing is symlink health,
  which belongs in Health if it earns its place.
