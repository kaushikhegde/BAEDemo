-- Where an agent's runtime (adapter, model, effort) is decided.
--
-- Two problems, one migration.
--
-- FIRST: `agents.adapter` was NOT NULL with a default of 'claude_local', and
-- `upsertAgent` wrote `spec.adapter ?? 'claude_local'`. Since no agent in the
-- org chart declares an adapter, every row said 'claude_local' — and
-- `resolveRuntime` reads step → agent → defaults, so the AGENT always answered
-- and the configured default was never consulted. `SCYNE_ADAPTER=gemini`
-- therefore changed nothing at all: every run still spawned Claude Code.
--
-- Nullable is the honest shape. "This agent has no opinion" and "this agent is
-- pinned to claude_local" are different statements, and a NOT NULL column with
-- a default cannot express the first.
alter table agents alter column adapter drop not null;
alter table agents alter column adapter set default null;

-- Existing rows were all written by that defaulting, so none of them expresses
-- a real preference. Clearing them lets the configured default apply; anyone
-- who genuinely wants an agent pinned sets it again through the console or
-- PATCH /agents/{key}, which writes a real value.
update agents set adapter = null where adapter = 'claude_local';

-- SECOND: there was nowhere to say "this client's work runs on Azure". The
-- only dimensions were per-step, per-agent and one global default from an
-- environment variable, so an operator could not vary the model per project
-- without restarting the server for everyone.
--
-- Scope vocabulary matches `budgets`, which already anticipated exactly this
-- shape (agent | workflow | project | company). `scope_key` is '*' for a
-- company-wide setting and the scope's own identifier otherwise.
create table settings (
  company_id uuid not null references companies(id) on delete cascade,
  scope      text not null,          -- company | project
  scope_key  text not null,          -- '*' | 'RTWSA'
  key        text not null,          -- adapter | model | effort
  value      text not null,
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (company_id, scope, scope_key, key)
);

create index on settings (company_id, scope);
