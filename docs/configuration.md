# Configuration

Split out of `CLAUDE.md`. Adapters, budgets, model pricing and storage — read before touching `orchestrator.config.ts`, `core/usage.ts`, `core/spawn.ts`, `core/materialise.ts` or anything to do with cost.

`orchestrator.config.ts` is the whole of it — the org chart, the adapter
registry, the defaults, and the workflows compiled from `scripts/pipeline.mjs`.
It is reconciled into the database on **every** boot, so the file is the source
of truth and cannot drift from what is running.

**Adapters.** `claude_local` (Claude Code), `codex` (Codex CLI), `gemini` and
`azure_foundry` (both loop-driven). `SCYNE_ADAPTER` picks the org-wide default;
`scyne adapter set <name> --project <p>` overrides it per project, and an agent
or a step can pin its own.

`codex` is registered when the binary is on PATH — auth is `codex login`, not an
API key, so there is nothing in the environment to detect. Install with
`npm i -g @openai/codex && codex login`.

`CODEX_MODEL` is only read when the org-wide default adapter is `codex`
(`SCYNE_ADAPTER=codex`) — it names the model `codex exec` is called with
(`--model`). It must be one this account actually serves; naming one it does
not is how an entire org's runs die on their first request.

**Setting it is what makes Codex runs costable.** A price needs a model name,
and the Codex transcript carries none — verified against a real capture, whose
events are `thread.started`, `turn.started`, `item.completed`, `turn.completed`
and `error`, with no model field anywhere. So the only record of what a run was
billed at is what `resolveRuntime` resolved, written to `runs.model` for exactly
the reason 004 wrote `runs.adapter`. Leave `CODEX_MODEL` unset and Codex still
runs — but every run shows `—` for cost, and no cost budget can fire on it.

> Current Codex models are **gpt-5.6-sol** (detail and polish), **gpt-5.6-terra**
> (the everyday workhorse) and **gpt-5.6-luna** (fast and cheap). **gpt-5.4 and
> gpt-5.4-mini retire from Codex on 31 August 2026**; gpt-5.2 and gpt-5.3-codex
> are already deprecated there. `scyne models list` flags both states — a
> retired model is not a slow run, it is every run failing on its first request.

> **Codex reports no cost — so we compute one, and label it.** `core/usage.ts`
> still records `total_cost_usd` verbatim from Claude Code's result event into
> `runs.cost_usd`, which continues to mean REPORTED BY THE CLI and nothing
> else. Codex emits token counts and no dollar figure, so since migration 007 a
> Codex run is priced by `priceRun()` from the `model_prices` table and stored
> in **`runs.est_cost_usd`**, with `runs.cost_source` recording which of the two
> a reader is looking at. Totals read `$4.10 reported + ~$1.23 est` rather than
> being merged — a single figure cannot be audited, because nobody reading it
> can tell which half came from a vendor's billing and which from a price table
> somebody typed.
>
> **A cost budget now fires on the estimate.** It could not before, which meant
> moving the org onto Codex silently removed the dollar ceiling from every
> agent. The blocking comment says the figure was estimated and names the model
> — being stopped by an arithmetic nobody can see is worse than not being
> stopped. Token and duration ceilings are unchanged.
>
> **A model with no published price stays unpriced** — `—`, never `$0.00`,
> which would read as a run that cost nothing.
>
> **A run is attributed to its project at CREATION.** `002_platform` added
> `issues.project_id` / `issues.feature_id` saying "cost per project is a
> group-by once this exists" — and then nothing ever wrote them, for months.
> `/spend?by=project` joins through those columns, so every row came back
> `project_name: null`: ONE anonymous row holding the whole installation's
> cost, by project, by feature, for every run ever recorded. The project was
> never missing — it sat in `issues.params` as jsonb, because that is what the
> workflow is parameterised by. `repo.createIssue` now resolves it into the
> foreign key, by name within the company, and `008_issue_project_backfill`
> lifts the history. A name that resolves to nothing leaves a null rather than
> guessing, and the issue is still created: the tree and the database do
> disagree (a `reset` clears one and leaves the other), and an unattributed run
> is a gap in a chart where a refused run is somebody's afternoon.
>
> It survived that long because every spend test seeded `project_id` by hand
> with an `update`, exercising the report and never the path that was missing.

The agent-key table — key, bundle path and `mcpEnabled` — is in
`CLAUDE.md` § Agents. There are no agent UUIDs to keep in sync and no
`.bootstrap/ids.json`; all of that belonged to Paperclip's hire flow.

**Budgets** are a ceiling, not a target: 10M tokens / $15 / 45 minutes per agent
run. The one measured requirements run took 25 minutes and $3.19. A run that
breaches the duration limit is killed (SIGTERM, then SIGKILL); token and cost
limits are checked once the final `result` event lands and flag the run
`over_budget`.

> **The token ceiling counts cache reads at full weight, so it is a runaway
> backstop rather than a real limit.** Codex reports `input_tokens` as the
> total WITH cached tokens in it, and `core/spawn.ts` adds that figure raw —
> so what the ceiling actually measures is context size times the number of
> model round-trips, not how much unique material the agent read. Measured: a
> 14-minute persona run reported 1,995,078 input tokens of which **1,906,560
> were cache reads**, crossed the original 2M ceiling by 2%, and blocked an
> issue whose outputs were already written and had passed their validator. The
> same run cost $1.1592 — 8% of the dollar ceiling, because cached tokens
> price at a tenth of fresh ones. The dollar limit is the one that means
> something; the token limit is set at 10M so it does not fire first.

**Reported cost is reported; estimated cost is labelled.** `runs.cost_usd` is
read straight off the CLI's own final `result` event and recorded verbatim, so
a figure in that column is always the CLI's arithmetic rather than ours. What
Codex changed is that there IS no such event — so `runs.est_cost_usd` holds our
own figure, computed by `priceRun()` from `model_prices`, in its own column,
never merged into the reported one. `runs.cost_source` says which applies.

The price table lives in the database rather than in code, so it can be
corrected without a deploy:

```bash
scyne models list                                      # catalogue, retirements flagged
scyne models set gpt-5.6-terra --input 2 --output 12   # correct one by hand
scyne models proposal                                  # a proposed table, as a DIFF
scyne models apply                                     # superadmin only
```

**A refresh is a proposal, never a write.** Rows may come from an agent that
read the vendor's pricing page, from a script, or from a person pasting a
table; they are validated (finite, non-negative, under a sanity ceiling, no
duplicates) and stored with the diff they would apply. A superadmin applies
them. A model that hallucinates a rate must not be able to change what every
run in the install is billed at, or trip every cost budget at once. An omitted
field means "leave it alone" rather than "clear it", so a refresh that forgets a
column cannot silently wipe every cached rate — and that rule holds for
`models set` too, which used to clear the cached rate of any model whose input
rate you corrected.

> **Rows are canonicalised at the HTTP boundary, and a row naming no rate is
> refused.** `input_per_mtok` and `inputPerMTok` both work. They did not: the
> proposal path stored rows verbatim and read snake_case only, so a refresh
> written the way every other write endpoint accepts was taken with 200,
> reported "it changes nothing", and applied as a no-op answering
> `applied: 1` — the whole feature, inert. The sanity ceiling was reading the
> same absent key, so it was not checking those rows either.

**Storage** is Postgres for metadata and **Azure Blob Storage for every byte of
document content**, addressed by SHA-256. Raw run logs stay as JSONL at
`.orchestrator/runs/<issueId>-<stepIndex>.jsonl`.

> **No document content lives in the database, and none lives durably on disk.**
> `blobs.content` (bytea) was dropped by migration 011; `blobs` is now metadata
> ABOUT content it does not hold — the hash that names it, its size, its type,
> and `blob_path`, the locator saying where the bytes actually are.
>
> That removed three ceilings nobody chose: 1 GB per Postgres `bytea` field,
> ~384 MB once a document was base64'd into a JSON body to reach the API, and
> the 100 MB upload cap in front of both. A 300 MB document used to be streamed
> into Azure in 8 MiB blocks, converted there, then **downloaded, buffered
> twice and refused** — the last leg undoing the streaming every other leg did.
>
> The column was dropped rather than left empty, and `postgresBlobBackend`
> deleted with it, because a column that exists is a column something
> eventually writes to. `createDocumentStore` REQUIRES a `BlobBackend` and
> `createOrchestrator` refuses to boot without one — `memoryBlobBackend()`
> exists for tests and does not survive the process.
>
> **Disk is a SCRATCH surface, one tree per STEP.** `config.workspaces`
> materialises a project out of the store into a temporary directory, the step
> runs against it, what it wrote is harvested back, and the directory is
> deleted. Per step rather than per issue because a workflow parks at a gate
> for hours or days, and a temporary directory that must survive that is a
> lifecycle nobody wants to own on a container that can restart. Nothing
> survives a step, so a replica dying mid-run orphans nothing.
>
> A step that FAILED or was killed is released without harvesting: a
> half-written tree must not become the record, and there is no second copy to
> recover from any more.
>
> **`original-files/` is never materialised.** It is the archive of raw uploads
> and the only part of a project that reaches gigabytes; a scratch tree is only
> viable on a container because it holds a working set (measured: 8 MB for
> SAPN_DEMO) rather than an archive. `materialise` also refuses above a size
> ceiling and names the document that pushed it over, because the alternative
> is a container filling and a run dying on ENOSPC with nothing saying why.

