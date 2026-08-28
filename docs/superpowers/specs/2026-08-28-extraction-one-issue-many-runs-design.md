# Document extraction: one issue, one run per document

**Date:** 2026-08-28
**Status:** design, awaiting review
**Touches:** `scripts/extract-documents.mjs`, `packages/orchestrator/`, `scyne-chatbot/server/index.ts`

## The problem, measured

Three separate faults, all visible on SA-DEMO's SCY-5.

**1. Nine uploads produce nine issues.** Every upload route calls
`startExtraction` ([`scyne-chatbot/server/index.ts:2507`](../../../scyne-chatbot/server/index.ts)),
which calls `paperclip.startWorkflow("extract", { project })`, which is a bare
`POST /issues` with no dedupe
([`server/orchestrator.ts:168`](../../../scyne-chatbot/server/orchestrator.ts)).
Nine documents uploaded in sequence started nine `extract` issues, racing each
other over one project's document tree. Eight of them blocked.

**2. The one that ran, ran too early.** SCY-5 started when only
`documents/Introduction.md` had landed. `extract-documents.mjs` resolves its
work list once, at the top of the pass, from `projectState`. It extracted 1
document. By the time step 3 ran, the store held 9, and
`validate-extracts.mjs` blocked the issue with `8 problems across 9
document(s)`. The script's work list is a snapshot; the validator's is not.

**3. None of it is visible.** The stage compiles to a single `exec` step that
spawns `claude` processes by hand
([`extract-documents.mjs:190`](../../../scripts/extract-documents.mjs)). Only
`agent` steps create `runs` rows, so nine agent invocations produced no run
rows, no transcripts, no cost, and nothing in `/spend`. The script's own header
comment already names this as the cost of the shortcut. During the twenty-five
minutes a pass takes, a healthy run and a wedged one are indistinguishable.

## What we are changing

Three parts, independent enough to land and verify separately.

---

### Part 1 — make the script's spawn match the runner's

**Keeping `claude -p`.** There is no API key and none is being introduced: the
local Claude Code CLI runs on the existing subscription, and that is what
extraction keeps using. No SDK, no `ANTHROPIC_API_KEY`, no new dependency.

The fault is narrower than "it uses the CLI". It is that the script hand-rolled
its own copy of the runner's flags and dropped two of them. `CLAUDE_ARGS` in
[`extract-documents.mjs`](../../../scripts/extract-documents.mjs) says it mirrors
`buildArgs` "minus the streaming output this script has no use for" — but that
streaming output is exactly where the usage comes from. Without
`--output-format stream-json --verbose` the CLI emits no `result` event, so
there are no token counts, no cost, and no transcript to render. The script
opted out of the data it now needs.

**The change: stop restating the flags, import them.**

```js
import { buildArgs, extractUsage } from "@scyne/orchestrator";
```

Both are already exported from the package index
([`packages/orchestrator/src/index.ts:22,60`](../../../packages/orchestrator/src/index.ts)).
`CLAUDE_ARGS` is deleted. The script spawns with `buildArgs({...})`, tees the
child's stdout to the run's log path, and passes it to `extractUsage` to get
the same `RunUsage` the engine records for every other agent run.

This is a deletion, not an addition — one hand-maintained copy of a flag list
that had already drifted from the thing it was copied from, replaced by the
thing itself. The comment in `runner.ts` is emphatic that every flag there is
"confirmed against a real invocation, not assumed"; a second list that is
assumed is the problem.

**Invocation.** The orchestrator package is TypeScript, so the script runs
under `tsx` rather than bare `node`, and `pipeline.mjs`'s `script:` line changes
to match. Precedent exists: `npm run migrate:blobs` already runs a root script
through `./packages/orchestrator/node_modules/.bin/tsx`.

> **The one decision in this part.** The alternative is to copy
> `--output-format stream-json --verbose` into `CLAUDE_ARGS` and keep the script
> on bare `node`. Smaller diff, no invocation change — and it recreates the
> drift that caused this, because the next flag the runner learns will not
> reach the copy either. Recommending the import; say so if the invocation
> change is not worth it.

#### Model

`--model` is a flag `buildArgs` already handles, so choosing a model costs
nothing new.

| Model | ID | Context | Relative price |
|---|---|---|---|
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | 1M | the org default today |
| **Claude Sonnet 5** | **`claude-sonnet-5`** | **1M** | cheaper than 4.6, and newer |
| Claude Opus 5 | `claude-opus-5` | 1M | ~2.5× Sonnet 5 |

**`claude-sonnet-5`**, overridable with `SCYNE_EXTRACT_MODEL`. Note the org-wide
default in `orchestrator.config.ts` is still `claude-sonnet-4-6`; extraction
pins its own and does not touch that default, which is a separate decision about
every other stage.

`--effort low`. Filling a fixed form from one document is the case low effort is
for, and on the CLI it is a flag `buildArgs` already passes.

#### What structured outputs would have given us, and does not

The API design this replaces would have enforced the extract's shape with
`output_config.format`, so the model could not return a wrong shape. The CLI has
no equivalent, so the existing belt stays exactly as it is: the prompt embeds
the pre-filled JSON envelope, warns that no other top-level field is permitted,
and `validateExtract` rejects anything that does not match before the `.partial`
is renamed into place.

That is a real thing given up, and it is worth naming rather than glossing:
the "agent invented its own wrapper" failure the current prompt works around
remains possible. It is caught, every time, by a validator that runs before the
extract is accepted — which is why this is a cost worth paying to avoid an API
key, not a hole.
#### What does not change

`extract-documents.mjs` keeps everything deterministic it already does, and all
of it is load-bearing:

- content-hash keying and `extractPathFor`
- the `.partial` claim protocol (`wx`, TTL, stale-owner takeover)
- `.extract.failed.json` markers with `attempts` / `firstFailedAt` / `lastFailedAt`
- `validateExtract` before `rename`
- the `scrub()` pass that keeps machine paths out of anything a human reads
- concurrency lanes and per-document narration
- `SCYNE_EXTRACT_CMD`, the positional-contract override the tests run on

Also unchanged: the CLI is still whatever `claude` resolves to on PATH, using
the local subscription. Nothing about how the machine authenticates changes.

#### Costs of this part, stated plainly

- The stage's command changes from `node` to `tsx`, so `scripts/pipeline.mjs`
  and anything that shells the stage by hand must move together.
- Root scripts now import `@scyne/orchestrator`. That direction is fine — the
  discipline is that the *package* must not import from `scripts/`,
  `orchestrator.config.ts` or `projects/`, and this does not reverse it — but it
  is the first time a root script depends on the package, and it should be
  noted in `docs/scripts.md`.
- `.env` gains `SCYNE_EXTRACT_MODEL` only. No key, no new dependency.

---

### Part 2 — a run row per document

Now that a document's extraction is an in-process HTTP call with a known start,
end, token count and outcome, it can be recorded the way an `agent` step is.

**Two new routes**, both added to `openapi.yaml` (which
`test/openapi.test.ts` diffs against the router in both directions):

| Route | Body | Returns |
|---|---|---|
| `POST /issues/{id}/runs` | `{ agentKey, phase, stepIndex, adapter, model }` | the run row, with `id` and `logPath` |
| `PATCH /runs/{id}` | `{ status, exitCode, inputTokens, outputTokens, costUsd, durationMs }` | the finished run row |

They are thin wrappers over `repo.startRun` / `repo.finishRun`, which already
exist and already carry every field. `est_cost_usd` continues to be computed by
the existing `priceRun` path from the `model_prices` table, so per-document cost
appears in `/spend` and on the issue with no new arithmetic.

`phase` is free text on the `runs` table, so each document's run is labelled
with its own `docId` — `extract: documents/Introduction.md` — and the console's
existing run list renders nine distinguishable rows with no schema change.

**Transcript.** The script writes the same `.jsonl` shape the runner emits to
the `logPath` the POST returns, so `/runs/{id}/transcript` works unchanged. What
goes in it: the document id, the model, the resolved token counts, and the
extract's own summary counts (how many of each of the eight kinds were found).
**Not** the document text and **not** the full extract — a transcript is for
telling a working run from a wedged one, and a client's SOP does not belong in
this deployment's runtime log directory.

**Authentication.** The script already holds `SCYNE_ORCH_TOKEN` and an issue id
for its `narrate()` calls, and already treats failure there as non-fatal. Run
recording follows the same rule: **best-effort, never fails the extraction.**
A run row is bookkeeping; the extract is the work.

#### Retry-counter consequence

`engine.ts` counts a step's attempts as
`listRuns(issue.id).filter(r => r.step_index === issue.step_index).length`.
Nine rows at one `step_index` would make an unrelated `agent` step believe it
had already retried. Extraction is an `exec` step and `exec` steps are never
retried, so nothing miscounts today — but the invariant "one run per step
attempt" is being broken deliberately and must be made explicit. The counter
gets scoped by `phase`: an engine-started run carries the step's own phase
(`generate`, `publish`), a fan-out run carries `extract: <docId>`, so
`r.step_index === issue.step_index && r.phase === step.phase` counts attempts
and nothing else. A test pins it.

The fan-out rows still carry `agent_id` — they are the Capabilities Process
Architect's spend and must attribute to that agent in `/spend` — which is
exactly why `agent_id` cannot be the discriminator.

---

### Part 3 — one issue, and no document left behind

**Coalescing.** `POST /issues` gains an optional `coalesceKey`. If an issue
exists with the same `company_id`, `workflow_key` and `coalesceKey` in a
non-terminal status — `todo`, `in_progress`, `in_review`, `blocked`, `paused` —
the route returns **that** issue with `200` instead of creating a second with
`201`. `done` and `cancelled` are terminal: the next upload after a finished
extraction starts a fresh issue, so one issue does not accumulate a project's
entire history.

`startExtraction` sends `coalesceKey: "extract:<project>"`. Nothing else in the
repo passes one, so no other workflow's behaviour changes.

Written into `openapi.yaml`, and the 200-vs-201 distinction is part of the
contract: a caller must be able to tell "I started a run" from "one was already
going".

**Re-sweep.** Coalescing alone strands a document uploaded while the pass is
running — that is fault 2 above, and it is what actually blocked SCY-5. So after
the queue drains, `extract-documents.mjs` re-runs `projectState` and enqueues
anything still not `ready` that it has not already attempted this pass. It
repeats until a sweep adds nothing, capped at **3 sweeps**; if the cap is hit
with work outstanding it says so on stderr and lets `validate-extracts.mjs`
block, which is the honest outcome — something is wrong that another lap will
not fix.

The cap is not a formality. Without it, a document that fails on every attempt
loops forever; the "not already attempted this pass" filter is what makes each
sweep strictly smaller.

**Cleanup, one-off.** SA-DEMO's nine blocked `extract` issues are cancelled by
hand once this lands. Not scripted — a one-time mess from a fixed bug does not
earn a migration.

---

## Data flow, after

```
upload  ─┐
upload  ─┼─→  POST /issues  {workflow: extract, coalesceKey: "extract:SA-DEMO"}
upload  ─┘         │
                   ├─ existing open issue?  → 200, return it
                   └─ none?                 → 201, create it
                                                  │
   SCY-5 ─ step 1  exec   stage.mjs
           step 2  exec   extract-documents.mjs
                            ├─ sweep 1: resolve todo from projectState
                            │    ├─ POST /issues/SCY-5/runs  → run A
                            │    │    claude -p --model claude-sonnet-5
                            │    │      --output-format stream-json --verbose
                            │    │      → stdout teed to the run's logPath
                            │    │    PATCH /runs/A  {tokens, cost}
                            │    └─ × 8 more, 8 lanes
                            ├─ sweep 2: anything new? → extract it
                            └─ sweep 3: nothing new → done
           step 3  exec   validate-extracts.mjs
           step 4  attach
```

## Error handling

| Failure | Behaviour |
|---|---|
| `claude` exits non-zero, or exits 0 having written nothing | Unchanged: both are already caught, the second explicitly — see `runClaude`'s doc comment |
| The CLI emits no `result` event | Usage is null; the run row is finished with `succeeded` and no cost rather than being failed. The extract is the work; its price tag is not |
| Output fails `validateExtract` | Unchanged: `.partial` removed, failure marker written with `attempts` incremented, the pass continues |
| `POST /issues/{id}/runs` unreachable | Logged, extraction proceeds. Bookkeeping never fails the work |
| 3 sweeps and work outstanding | stderr says which documents; `validate-extracts.mjs` blocks the issue |
| Coalesce lookup throws | Falls through to creating an issue. A duplicate issue is a worse day than a lost upload, not a lost extraction |

## Testing

- `SCYNE_EXTRACT_CMD` stays the money-free path for every existing script test.
- **New, no money:** the spawn's argv comes from `buildArgs` and carries
  `--output-format stream-json`, `--verbose`, `--model` and `--effort` — pinned
  so the copy cannot silently return.
- **New, no money:** `extractUsage` over a captured stream-json fixture yields
  the tokens and cost the run row is finished with; a stream with no `result`
  event yields null and finishes the run without failing it.
  `packages/orchestrator/fixtures/result-event.jsonl` already exists.
- **New:** coalescing — same key returns 200 with the same issue id; a `done`
  issue does not coalesce; a different project does not coalesce.
- **New:** re-sweep — a document appearing between sweep 1 and sweep 2 is
  extracted; the sweep cap terminates with work outstanding.
- **New:** the retry counter ignores fan-out run rows.
- `test/openapi.test.ts` covers the three new routes by construction.
- `npm run check:routing` after `server/index.ts` changes.

## Explicitly out of scope

- Anything requiring an API key: the SDK, structured outputs, `count_tokens`,
  the Batch API. Ruled out by the decision to stay on the local subscription.
- Changing the org-wide default model in `orchestrator.config.ts` (still
  `claude-sonnet-4-6`). Extraction pins its own; every other stage is a
  separate conversation.
- A general `fanout` step type in the engine. It is the right long-term shape
  and the script's header comment argues for it, but Part 2 delivers the
  visibility this is about without adding a sixth member to the `Step` union
  that every consumer of the library must then handle.
- Chunking a document that exceeds the model's 1M context. The schema's
  `windows[]` and `coverage.truncated` anticipate it; nothing has hit it yet.
  Without `count_tokens` there is no pre-flight size check either — an
  over-long document fails at the CLI and lands in its failure marker like any
  other failure, which is the same place a person would look anyway.

## Open questions for review

1. ~~**Default model.**~~ **Resolved 2026-08-28: `claude-sonnet-5`**, passed as
   `--model` to the local CLI.
2. ~~**Where the credential lives.**~~ **Resolved 2026-08-28: there is no
   credential.** Extraction stays on `claude -p` and the local subscription; the
   SDK, the API key and structured outputs are all out.
3. **`node` → `tsx` for the extract stage** — the one open decision, boxed in
   Part 1. Importing `buildArgs`/`extractUsage` costs an invocation change;
   copying two flags costs the drift that caused this bug.
