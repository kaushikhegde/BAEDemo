# Workstream C — Pause, Force-Pause and Cancel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stop a running issue — gracefully, forcibly, or for good — from the API, the CLI and the chatbot. (The console's buttons land in workstream B, which builds the console once.)

**Architecture:** A control *request* is written to the issue; the engine honours it at the next step boundary, which is the only place it can. A force-pause or cancel additionally kills the live child through a registry `spawn.ts` keeps of `runId → ChildProcess`, reusing the bounded SIGTERM→SIGKILL escalation the budget kill already has.

**Tech Stack:** TypeScript (Node 24, ESM, type-stripping), Express 4, PGlite, vitest.

**Spec:** `docs/superpowers/specs/2026-08-20-multitenant-platform-design.md` §3

## Global Constraints

- **Australian English** in user-facing copy.
- **No new runtime dependencies** in `packages/orchestrator`.
- **This repository's owner commits their own work** — tasks end in a *verification*, never `git commit`.
- The engine owns every status transition. A route sets a request; it does not set a status.
- A killed run is **not** a failed run. `core/retry.ts` must never spend money re-running one.

---

## The three verbs

| Verb | In-flight agent | Issue ends at | Resumable |
|---|---|---|---|
| **Pause** | runs to completion | `paused`, before the NEXT step | yes |
| **Pause now** | SIGTERM → SIGKILL | `paused`, at THIS step | yes, re-runs the step |
| **Cancel** | SIGTERM → SIGKILL | `cancelled` | no |

A *request* rather than a status, because the two are genuinely different: the request is made by a human at an arbitrary moment, and the status changes when the engine next reaches a point where it can honour it. Collapsing them means either lying about the status for twenty minutes or losing the request.

---

## Task 1: Migration 006

**Files:** Create `packages/orchestrator/migrations/006_issue_control.sql`; test in `platform-schema.test.ts`.

**Produces:** `issues.control_request` (`pause` | `pause_now` | `cancel` | null), `issues.control_requested_by`, `issues.control_requested_at`.

- [ ] **Step 1: Failing test** — assert the three columns exist, that `control_request` rejects a value outside the vocabulary, and that `control_requested_by` is `on delete set null`.
- [ ] **Step 2:** `npm test -- platform-schema` → FAIL.
- [ ] **Step 3:** Write the migration with a `check` constraint on the vocabulary.
- [ ] **Step 4:** `npm test -- platform-schema` → PASS.
- [ ] **Step 5: Verify** `npm test && npm run typecheck`.

## Task 2: A registry of live children, and a way to kill one

**Files:** Modify `packages/orchestrator/src/core/spawn.ts`, `core/runner.ts` (`RunRequest.runId`); test `packages/orchestrator/test/spawn-kill.test.ts` (**create**).

**Produces:**
```ts
export function killRun(runId: string, grace?: number): boolean
export function liveRuns(): string[]
```
plus `RunRequest.runId?: string` and a new `RunResult["status"]` member `"cancelled"`.

The registry is in-process, which is correct rather than a limitation: PGlite is single-writer, so exactly one process owns the engine, and the CLI already reaches it over HTTP.

- [ ] **Step 1: Failing test** — spawn a long-lived child (`node -e "setInterval(()=>{},1e3)"`), assert `liveRuns()` contains its id, `killRun(id)` returns true, the promise resolves with `status: "cancelled"`, and `liveRuns()` no longer contains it. Assert `killRun("nope")` returns false.
- [ ] **Step 2:** `npm test -- spawn-kill` → FAIL.
- [ ] **Step 3:** Implement — a module-level `Map`, registered after `spawn()` and deleted in `resolveOnce`; a `killedByOperator` flag mirroring `killedForBudget`; `status = "cancelled"` at close when it is set. Reuse `BUDGET_KILL_GRACE_MS`.
- [ ] **Step 4:** `npm test -- spawn-kill` → PASS.
- [ ] **Step 5: Verify** `npm test && npm run typecheck`.

## Task 3: A cancelled run is never retried

**Files:** Modify `core/retry.ts`; test `test/retry.test.ts`.

- [ ] **Step 1: Failing test** — `classifyFailure({status: "cancelled", usage: null, ...}, 1_000)` returns `{retry: false}` with a reason naming the operator. The dangerous case is precisely a cancel *inside* the transient window with no usage, which today's rules would retry.
- [ ] **Step 2:** run → FAIL (it retries).
- [ ] **Step 3:** Add the branch **above** the transient-window check.
- [ ] **Step 4/5:** run → PASS; `npm test`.

## Task 4: The engine honours a control request

**Files:** Modify `core/engine.ts`, `core/repo.ts`; test `test/control.test.ts` (**create**).

**Produces:** `repo.requestControl(issueId, verb, byUserId)`, `repo.clearControl(issueId)`; `engine.pause(issueId, {force})`, `engine.cancel(issueId)`, `engine.resume(issueId)`.

`advance()` already re-reads the issue at the top of every iteration — that is where a graceful pause lands. It must also return early for `paused` and `cancelled`, alongside the existing `blocked`/`done`/`in_review` halt.

- [ ] **Step 1: Failing tests** covering: graceful pause parks at the next step and does NOT kill; force pause kills and parks at THIS step; cancel is terminal and refuses to resume; resume re-runs only the parked step and does not repeat completed ones; a comment names who asked; `advance()` on a paused issue is a no-op.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4/5:** run → PASS; `npm test`.

## Task 5: Routes

**Files:** Modify `http/router.ts`, `openapi.yaml`; test `test/router.test.ts`.

```
POST /issues/{id}/pause    {force?: boolean}
POST /issues/{id}/cancel
POST /issues/{id}/resume
```

Each records an `actions` row, so "who cancelled this" is answerable. Each returns **202** and the updated issue — a graceful pause may wait twenty minutes for the step to end, so the response must not hold the connection.

- [ ] **Step 1: Failing tests** — 401 without a credential; 404 for another organisation's issue; 202 and the request recorded; cancel then resume → 409.
- [ ] **Step 2–4:** implement, document in `openapi.yaml`, run.
- [ ] **Step 5: Verify** `npm test -- router openapi`.

## Task 6: CLI

**Files:** Modify `cli/index.ts` (`cmdRun`), `cli/repl.ts`.

```
scyne run pause  <SCY-7> [--force]
scyne run cancel <SCY-7>
scyne run resume <SCY-7>
```

- [ ] **Step 1:** Implement, resolving `SCY-n` to a uuid the way the other verbs do.
- [ ] **Step 2:** `npm run typecheck`.
- [ ] **Step 3:** Exercise against a live server: start a workflow, pause it, resume it, cancel it; confirm `scyne status` shows each transition.

## Task 7: Chatbot

**Files:** Modify `scyne-chatbot/server/index.ts`, `server/orchestrator.ts`, `src/api.ts`, `src/components/ProgressPanel.tsx`.

Three controls beside the stage pill. Cancel confirms first; pause does not (it is reversible).

- [ ] **Step 1:** Add `pauseIssue`/`cancelIssue`/`resumeIssue` to `server/orchestrator.ts` and the three `/api/issues/:id/{pause,cancel,resume}` routes.
- [ ] **Step 2:** Add the client functions to `src/api.ts` (through `apiFetch`).
- [ ] **Step 3:** Render the controls; disable them when the issue is `done`, `cancelled` or already `paused` as appropriate.
- [ ] **Step 4:** Exercise live.

## Done when

- [ ] `npm test` green including `control.test.ts` and `spawn-kill.test.ts`.
- [ ] `npm run typecheck` and `npm run check:routing` green.
- [ ] Live: a running issue pauses gracefully, resumes, and cancels; a cancelled run is never retried; the issue timeline names who asked for each.
