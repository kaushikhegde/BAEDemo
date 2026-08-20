-- What a run cost, when the CLI that ran it does not say.
--
-- This repository deliberately held NO price table: `core/usage.ts` read
-- `total_cost_usd` straight off Claude Code's own final `result` event and
-- recorded it verbatim, so a figure in the console was the CLI's arithmetic
-- rather than ours. That is still true of `runs.cost_usd`, and this migration
-- does not change it.
--
-- What changed is which CLI runs the work. Codex emits token counts and no
-- dollar figure at all, so a Codex run recorded null — which meant `—` in the
-- console and, far more seriously, that **a cost budget could not fire on it**.
-- Moving the whole org onto Codex therefore silently removed the dollar
-- ceiling from every agent. That is the reason this table exists.
--
-- The estimate lives in its OWN column beside the reported figure rather than
-- replacing it, so a total can be presented as "$4.10 reported + ~$1.23 est"
-- instead of one number nobody can audit.

create table model_prices (
  provider              text not null,          -- openai | anthropic | google
  model                 text not null,
  -- Nullable throughout: "this model has no published price" and "this model
  -- is free" are different facts, and a 0 here would render as $0.00 and read
  -- as the second. An unpriced model computes nothing.
  input_per_mtok        numeric(12,4),
  cached_input_per_mtok numeric(12,4),
  output_per_mtok       numeric(12,4),
  currency              text not null default 'USD',
  -- Codex retires models on announced dates, and a model that is gone is a run
  -- that dies on its first request. The catalogue warns within thirty days and
  -- stops offering it past the date.
  retires_on            date,
  source_url            text,
  fetched_at            timestamptz,
  updated_by            uuid references users(id) on delete set null,
  updated_at            timestamptz not null default now(),
  primary key (provider, model),
  -- A negative rate is a typo or a bad refresh, and it would silently credit
  -- spend rather than charge it.
  constraint model_prices_non_negative check (
    coalesce(input_per_mtok, 0) >= 0 and
    coalesce(cached_input_per_mtok, 0) >= 0 and
    coalesce(output_per_mtok, 0) >= 0)
);

-- A refresh is a PROPOSAL, never a direct write. `POST /models/refresh` asks an
-- agent to fetch the current published pricing; an agent that hallucinates a
-- price must not be able to change what every run in the install is billed at,
-- so the result is validated, stored here with its diff, and applied by a
-- superadmin.
create table model_price_proposals (
  id           uuid primary key,
  company_id   uuid not null references companies(id) on delete cascade,
  proposed_by  uuid references users(id) on delete set null,
  source       text,                    -- where the agent said it read this
  rows         jsonb not null,          -- [{provider, model, input_per_mtok, ...}]
  status       text not null default 'pending',   -- pending | applied | discarded
  created_at   timestamptz not null default now(),
  decided_at   timestamptz,
  decided_by   uuid references users(id) on delete set null
);

create index on model_price_proposals (company_id, status);

-- Which model ran, and what we make of it.
--
-- `model` could not be derived: `resolveRuntime` picks it from the step, the
-- agent, a project setting or the default, and only the engine knows the
-- answer. Exactly the reasoning migration 004 used for `adapter`.
--
-- `cost_usd` keeps its meaning: REPORTED, verbatim, never computed.
-- `est_cost_usd` is ours. `cost_source` says which of the two a reader is
-- looking at, so the distinction survives into every query and every screen.
alter table runs add column model        text;
alter table runs add column est_cost_usd numeric(12,6);
alter table runs add column cost_source  text;

alter table runs add constraint runs_cost_source_check
  check (cost_source is null or cost_source in ('reported', 'estimated'));

create index on runs (model);

-- No backfill. Runs recorded before these columns existed were all Claude Code
-- and all carry a reported cost, but writing 'reported' into them would assert
-- something the data never said. `—` is the honest rendering.

-- ---------------------------------------------------------------- the seed
--
-- Fetched 2026-08-20 from developers.openai.com/api/docs/pricing, standard
-- tier, US dollars per 1M tokens. `fetched_at` records when, so a stale table
-- is visible rather than assumed current.
--
-- gpt-5.4 and gpt-5.4-mini retire from Codex on 2026-08-31 — eleven days after
-- this was written. gpt-5.3-codex-spark is seeded UNPRICED because no price is
-- published for it, not because it is free.
insert into model_prices
  (provider, model, input_per_mtok, cached_input_per_mtok, output_per_mtok, retires_on, source_url, fetched_at)
values
  ('openai', 'gpt-5.6-sol',          5.00,  0.50,   30.00,  null,               'https://developers.openai.com/api/docs/pricing', '2026-08-20T00:00:00Z'),
  ('openai', 'gpt-5.6-terra',        2.00,  0.20,   12.00,  null,               'https://developers.openai.com/api/docs/pricing', '2026-08-20T00:00:00Z'),
  ('openai', 'gpt-5.6-luna',         0.20,  0.02,    1.20,  null,               'https://developers.openai.com/api/docs/pricing', '2026-08-20T00:00:00Z'),
  ('openai', 'gpt-5.5',              5.00,  0.50,   30.00,  null,               'https://developers.openai.com/api/docs/pricing', '2026-08-20T00:00:00Z'),
  ('openai', 'gpt-5.5-pro',         30.00,  null,  180.00,  null,               'https://developers.openai.com/api/docs/pricing', '2026-08-20T00:00:00Z'),
  ('openai', 'gpt-5.4',              2.50,  0.25,   15.00,  date '2026-08-31',  'https://developers.openai.com/api/docs/pricing', '2026-08-20T00:00:00Z'),
  ('openai', 'gpt-5.4-mini',         0.75,  0.075,   4.50,  date '2026-08-31',  'https://developers.openai.com/api/docs/pricing', '2026-08-20T00:00:00Z'),
  ('openai', 'gpt-5.4-nano',         0.20,  0.02,    1.25,  null,               'https://developers.openai.com/api/docs/pricing', '2026-08-20T00:00:00Z'),
  ('openai', 'gpt-5.4-pro',         30.00,  null,  180.00,  null,               'https://developers.openai.com/api/docs/pricing', '2026-08-20T00:00:00Z'),
  ('openai', 'gpt-5.2',              1.75,  0.175,  14.00,  null,               'https://developers.openai.com/api/docs/pricing', '2026-08-20T00:00:00Z'),
  ('openai', 'gpt-5.2-pro',         21.00,  null,  168.00,  null,               'https://developers.openai.com/api/docs/pricing', '2026-08-20T00:00:00Z'),
  ('openai', 'gpt-5.3-codex',        1.75,  0.175,  14.00,  null,               'https://developers.openai.com/api/docs/pricing', '2026-08-20T00:00:00Z'),
  ('openai', 'gpt-5.3-codex-spark',  null,  null,    null,  null,               'https://developers.openai.com/api/docs/pricing', '2026-08-20T00:00:00Z'),
  ('openai', 'gpt-5.1',              1.25,  0.125,  10.00,  null,               'https://developers.openai.com/api/docs/pricing', '2026-08-20T00:00:00Z'),
  ('openai', 'gpt-5',                1.25,  0.125,  10.00,  null,               'https://developers.openai.com/api/docs/pricing', '2026-08-20T00:00:00Z'),
  ('openai', 'gpt-5-mini',           0.25,  0.025,   2.00,  null,               'https://developers.openai.com/api/docs/pricing', '2026-08-20T00:00:00Z'),
  ('openai', 'gpt-5-nano',           0.05,  0.005,   0.40,  null,               'https://developers.openai.com/api/docs/pricing', '2026-08-20T00:00:00Z'),
  ('openai', 'gpt-5-pro',           15.00,  null,  120.00,  null,               'https://developers.openai.com/api/docs/pricing', '2026-08-20T00:00:00Z'),
  ('openai', 'gpt-4.1',              2.00,  0.50,    8.00,  null,               'https://developers.openai.com/api/docs/pricing', '2026-08-20T00:00:00Z'),
  ('openai', 'gpt-4.1-mini',         0.40,  0.10,    1.60,  null,               'https://developers.openai.com/api/docs/pricing', '2026-08-20T00:00:00Z'),
  ('openai', 'gpt-4.1-nano',         0.10,  0.025,   0.40,  null,               'https://developers.openai.com/api/docs/pricing', '2026-08-20T00:00:00Z'),
  ('openai', 'o3',                   2.00,  0.50,    8.00,  null,               'https://developers.openai.com/api/docs/pricing', '2026-08-20T00:00:00Z'),
  ('openai', 'o3-pro',              20.00,  null,   80.00,  null,               'https://developers.openai.com/api/docs/pricing', '2026-08-20T00:00:00Z'),
  ('openai', 'o3-mini',              1.10,  0.55,    4.40,  null,               'https://developers.openai.com/api/docs/pricing', '2026-08-20T00:00:00Z'),
  ('openai', 'o4-mini',              1.10,  0.275,   4.40,  null,               'https://developers.openai.com/api/docs/pricing', '2026-08-20T00:00:00Z'),
  ('openai', 'o1',                  15.00,  7.50,   60.00,  null,               'https://developers.openai.com/api/docs/pricing', '2026-08-20T00:00:00Z'),
  ('openai', 'o1-pro',             150.00,  null,  600.00,  null,               'https://developers.openai.com/api/docs/pricing', '2026-08-20T00:00:00Z');
