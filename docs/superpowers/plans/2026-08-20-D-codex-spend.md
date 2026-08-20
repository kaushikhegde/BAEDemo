# Workstream D — Codex Everywhere, and What It Costs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans.

**Goal:** Make Codex the default adapter, and give a Codex run a dollar figure — computed from a price table in the database, clearly labelled an estimate, and enforceable by a cost budget.

**Architecture:** `runs.cost_usd` keeps its meaning untouched — *reported by the CLI, never computed by us*. The estimate lives in its own column beside it, so the console can say `$4.10 reported + ~$1.23 est` rather than one number nobody can audit. Prices live in `model_prices`, seeded from a real fetched table, editable, and refreshable through a validated proposal a superadmin applies.

**Spec:** `docs/superpowers/specs/2026-08-20-multitenant-platform-design.md` §4

## Global Constraints

- **Australian English.** No new runtime dependencies. Owner commits their own work — verify, never `git commit`.
- **An unknown or unpriced model computes nothing and renders `—`.** It never guesses, and never renders `$0.00`, which reads as a free run.
- **A price is never written by an agent directly.** A refresh produces a *proposal*; a superadmin applies it.

---

## Task 1: Migration 007 — prices, and which model ran

**Files:** Create `migrations/007_model_prices.sql`; test in `platform-schema.test.ts`.

**Produces:** `model_prices(provider, model, input_per_mtok, cached_input_per_mtok, output_per_mtok, currency, retires_on, source_url, fetched_at, updated_by, updated_at)`; `runs.model`, `runs.est_cost_usd`, `runs.cost_source`.

Seeded from `developers.openai.com/api/docs/pricing`, fetched 2026-08-20 ($/1M):

| model | input | cached | output | retires |
|---|---|---|---|---|
| gpt-5.6-sol | 5.00 | 0.50 | 30.00 | |
| gpt-5.6-terra | 2.00 | 0.20 | 12.00 | |
| gpt-5.6-luna | 0.20 | 0.02 | 1.20 | |
| gpt-5.5 | 5.00 | 0.50 | 30.00 | |
| gpt-5.5-pro | 30.00 | — | 180.00 | |
| gpt-5.4 | 2.50 | 0.25 | 15.00 | **2026-08-31** |
| gpt-5.4-mini | 0.75 | 0.075 | 4.50 | **2026-08-31** |
| gpt-5.4-nano | 0.20 | 0.02 | 1.25 | |
| gpt-5.4-pro | 30.00 | — | 180.00 | |
| gpt-5.2 | 1.75 | 0.175 | 14.00 | |
| gpt-5.2-pro | 21.00 | — | 168.00 | |
| gpt-5.3-codex | 1.75 | 0.175 | 14.00 | |
| gpt-5.3-codex-spark | — | — | — | (unpriced: no published price) |
| gpt-5.1, gpt-5 | 1.25 | 0.125 | 10.00 | |
| gpt-5-mini | 0.25 | 0.025 | 2.00 | |
| gpt-5-nano | 0.05 | 0.005 | 0.40 | |
| gpt-5-pro | 15.00 | — | 120.00 | |
| gpt-4.1 | 2.00 | 0.50 | 8.00 | |
| gpt-4.1-mini | 0.40 | 0.10 | 1.60 | |
| gpt-4.1-nano | 0.10 | 0.025 | 0.40 | |
| o3 | 2.00 | 0.50 | 8.00 | |
| o3-pro | 20.00 | — | 80.00 | |
| o3-mini | 1.10 | 0.55 | 4.40 | |
| o4-mini | 1.10 | 0.275 | 4.40 | |
| o1 | 15.00 | 7.50 | 60.00 | |
| o1-pro | 150.00 | — | 600.00 | |

- [ ] Failing test → migration → passing test → `npm test`.

## Task 2: `priceRun` — the arithmetic, pure and testable

**Files:** Modify `core/usage.ts`; test `test/usage.test.ts`.

**Produces:** `priceRun(usage: RunUsage, price: ModelPrice | null): number | null`

Cached input is billed at the cached rate and **subtracted from** the input count — `usage.inputTokens` from Codex is the total, and billing it all at full rate over-reports every cached run.

- [ ] Failing tests: exact arithmetic; a null price → null; an unpriced row (all-null rates) → null; zero tokens → 0; cached tokens billed at the cached rate; a negative or non-finite figure never returned.
- [ ] Implement → pass → `npm test`.

## Task 3: Record the model and the estimate

**Files:** Modify `core/engine.ts`, `core/repo.ts`; test `test/engine.test.ts`.

`runs.model` is written from `resolveRuntime` — the only place that knows, exactly as `adapter` was in 004. After a run settles, if `costUsd` is null and the model is priced, write `est_cost_usd` and `cost_source = 'estimated'`; if the CLI reported one, `cost_source = 'reported'`.

- [ ] Failing tests → implement → pass.

## Task 4: Budgets fire on an estimate

**Files:** Modify `core/spawn.ts` (post-hoc budget check), `core/engine.ts`; test `test/engine.test.ts`.

Today a cost ceiling **cannot fire on a Codex run at all** — so moving the org to Codex silently removes the dollar cap. That is the reason this workstream exists.

- [ ] Failing test: a Codex run over its cost ceiling is flagged `over_budget`, and the comment says the figure was estimated and names the price row.
- [ ] Implement → pass.

## Task 5: Spend by every dimension

**Files:** Modify `core/platform.ts` (`spend`), `http/platform-router.ts`, `openapi.yaml`; test `test/platform.test.ts`.

```ts
spend(companyId, { by: "project"|"feature"|"user"|"agent"|"adapter"|"model",
                   project?, feature?, user?, since?, until? })
```
`SpendRow` gains `feature_id`/`feature_name`, a real `user_id`/`user_email`, `model`, and splits cost into `reported_cost_usd` + `estimated_cost_usd` + `unpriced_run_count`.

**Also fixes a tracked bug:** `order by 8 desc` counts columns positionally and currently orders by `output_tokens`, not `cost_usd`.

- [ ] Failing tests per dimension and filter → implement → pass.

## Task 6: The model catalogue over HTTP

**Files:** Modify `http/platform-router.ts`, `openapi.yaml`; test `test/platform-router.test.ts`.

```
GET   /models                      catalogue + in-use counts
PUT   /models/{provider}/{model}   upsert by hand (admin)
POST  /models/refresh              propose an update (admin)
GET   /models/refresh              the outstanding proposal and its diff
POST  /models/refresh/apply        apply it (superadmin)
DELETE /models/refresh             discard it (admin)
```

A refresh is validated before it is stored: every rate finite, non-negative, and under a sanity ceiling. A model within 30 days of `retires_on` is flagged; past it, it is not offered.

- [ ] Failing tests → implement → pass.

## Task 7: CLI + defaults

**Files:** Modify `cli/index.ts`; `.env`.

```
scyne models [--json]                     the catalogue, retirements flagged
scyne models set <model> --input --output [--cached] [--provider]
scyne models refresh [--apply]
scyne spend [--by …] [--project] [--feature] [--user] [--since] [--json]
```
`SCYNE_ADAPTER=codex` in `.env`.

- [ ] Implement → `npm run typecheck` → exercise live.

## Done when

- [ ] `npm test`, `npm run typecheck`, `npm run check:routing` green.
- [ ] A Codex run shows `~$x.xx est`, never `$0.00`, and never a figure for an unpriced model.
- [ ] `scyne spend --by model` attributes correctly and separates reported from estimated.
- [ ] A cost budget fires on an estimated Codex run.
