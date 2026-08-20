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
