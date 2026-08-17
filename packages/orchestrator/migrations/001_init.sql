create table if not exists _migrations (
  name       text primary key,
  applied_at timestamptz not null default now()
);

create table companies (
  id          uuid primary key,
  name        text not null unique,
  created_at  timestamptz not null default now()
);

-- Mirrored from the config file. The file is the source of truth.
create table agents (
  id           uuid primary key,
  company_id   uuid not null references companies(id) on delete cascade,
  key          text not null,            -- stable config key ('ba') — dispatch address
  name         text not null,
  title        text,
  icon         text,
  reports_to   uuid references agents(id),
  adapter      text not null default 'claude_local',  -- key into the runner registry
  model        text,
  effort       text,                                  -- low|medium|high|xhigh|max
  fallback_model jsonb not null default '[]',         -- tried in order when overloaded
  cwd          text,
  mcp_enabled  boolean not null default false,
  extra_args   jsonb not null default '[]',
  bundle_path  text,
  status       text not null default 'idle',   -- idle | running | disabled
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (company_id, key)
);

create table skills (
  id             uuid primary key,
  company_id     uuid not null references companies(id) on delete cascade,
  slug           text not null,
  path           text not null,          -- skills/<slug>/SKILL.md
  content_hash   text not null,
  token_estimate int,
  updated_at     timestamptz not null,
  unique (company_id, slug)
);

create table agent_skills (
  agent_id uuid references agents(id) on delete cascade,
  skill_id uuid references skills(id) on delete cascade,
  primary key (agent_id, skill_id)
);

create table issues (
  id                uuid primary key,
  company_id        uuid not null references companies(id) on delete cascade,
  identifier        text not null,       -- SCY-1
  parent_id         uuid references issues(id) on delete cascade,
  title             text not null,
  description       text,
  status            text not null,       -- todo|in_progress|in_review|blocked|done|cancelled
  assignee_agent_id uuid references agents(id),
  workflow_key      text,                -- 'requirements'
  step_index        int  not null default 0,
  params            jsonb not null default '{}',   -- project, feature, keys, instruction
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (company_id, identifier)
);

create table comments (
  id              uuid primary key,
  issue_id        uuid not null references issues(id) on delete cascade,
  author_agent_id uuid references agents(id),
  author_user     text,
  body            text not null,
  created_at      timestamptz not null default now()
);

create table work_products (
  id         uuid primary key,
  issue_id   uuid not null references issues(id) on delete cascade,
  type       text not null,              -- document | preview_url | …
  provider   text not null,              -- local | confluence | jira
  title      text not null,
  url        text not null,
  created_at timestamptz not null default now(),
  unique (issue_id, url)                 -- idempotent re-attach
);

create table gates (
  id            uuid primary key,
  issue_id      uuid not null references issues(id) on delete cascade,
  kind          text not null default 'approval',
  status        text not null default 'pending',  -- pending|approved|rejected|cancelled
  payload       jsonb not null default '{}',      -- {title, summary}
  decision_note text,
  decided_by    text,
  decided_at    timestamptz,
  created_at    timestamptz not null default now()
);

create table runs (
  id                    uuid primary key,
  issue_id              uuid not null references issues(id) on delete cascade,
  agent_id              uuid references agents(id),
  step_index            int,
  phase                 text,            -- generate | publish | <custom>
  status                text not null,   -- running|succeeded|failed|over_budget|orphaned
  started_at            timestamptz not null default now(),
  finished_at           timestamptz,
  exit_code             int,
  log_path              text not null,   -- .orchestrator/runs/<id>.jsonl
  session_id            text,
  input_tokens          bigint,
  output_tokens         bigint,
  cache_read_tokens     bigint,
  cache_creation_tokens bigint,
  cost_usd              numeric(12,6),
  duration_ms           bigint,
  num_turns             int
);

create table budgets (
  id             uuid primary key,
  company_id     uuid not null references companies(id) on delete cascade,
  scope          text not null,          -- agent | workflow | project | company
  scope_key      text not null,          -- 'ba' | 'requirements' | 'RTWSA' | '*'
  max_tokens     bigint,
  max_cost_usd   numeric(12,6),
  max_duration_ms bigint,
  unique (company_id, scope, scope_key)
);

create index on issues (company_id, status);
create index on issues (parent_id);
create index on runs   (issue_id, started_at desc);
create index on comments (issue_id, created_at);
create index on gates  (issue_id, status);
