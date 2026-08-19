-- The platform tables: identity, projects, documents, chats, logs, audit.
--
-- 001 modelled the ENGINE — agents, issues, runs, gates. Everything a run
-- needed that was not an issue lived on a filesystem: which projects exist was
-- `readdir(projects/)`, a document was a file, a chat was browser
-- localStorage, a transcript was a .jsonl beside the code, and permission was
-- a hardcoded credential checked in the browser. None of that survives being
-- pointed at from more than one machine, which is what a plugin is.
--
-- Strictly additive. No column is dropped and no existing table is rewritten;
-- the only change to 001's shape is `runs.log_path` becoming nullable, because
-- events now live in `run_events`. A deployment that rolls back to the
-- previous build runs against this schema unchanged.
--
-- UUIDs are generated in application code (core/ids.ts), not by a database
-- default, so no pgcrypto/uuid-ossp extension is required — PGlite runs the
-- test suite and cannot be assumed to carry either.

-- ---------------------------------------------------------------- identity

create table users (
  id            uuid primary key,
  company_id    uuid not null references companies(id) on delete cascade,
  email         text not null,
  name          text,
  -- Nullable: a service account authenticates by token only and must not be
  -- forced to carry a password hash it can never use.
  password_hash text,
  role          text not null default 'member',   -- admin | member | viewer
  status        text not null default 'active',   -- active | disabled
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (company_id, email)
);

-- What the CLI and the plugin authenticate with. The secret itself is never
-- stored: `token_hash` is a SHA-256 of it, and `prefix` is the first few
-- characters, kept so a person can recognise which token a row refers to
-- without the row being enough to use.
create table api_tokens (
  id           uuid primary key,
  user_id      uuid not null references users(id) on delete cascade,
  name         text not null,
  prefix       text not null unique,
  token_hash   text not null unique,
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);

-- Browser sessions. Same discipline: the cookie value is hashed here.
create table sessions (
  id         uuid primary key,
  user_id    uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- One row per machine the plugin is installed on. This is what makes "who
-- installed it, and who is running right now" answerable at all.
create table installations (
  id             uuid primary key,
  company_id     uuid not null references companies(id) on delete cascade,
  user_id        uuid references users(id) on delete set null,
  machine_id     text not null,
  hostname       text,
  os             text,
  plugin_version text,
  installed_at   timestamptz not null default now(),
  last_seen_at   timestamptz,
  revoked_at     timestamptz,
  unique (company_id, machine_id)
);

-- ------------------------------------------------------- projects & access

create table projects (
  id          uuid primary key,
  company_id  uuid not null references companies(id) on delete cascade,
  name        text not null,
  description text,
  website     text,
  theme       jsonb not null default '{}',
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz,
  unique (company_id, name)
);

create table features (
  id          uuid primary key,
  project_id  uuid not null references projects(id) on delete cascade,
  name        text not null,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  archived_at timestamptz,
  unique (project_id, name)
);

-- Per-project access. A user's global `role` says what KIND of thing they may
-- do; membership says WHICH projects they may do it to. Absence of a row is
-- absence of access — deliberately, so a new project is private until shared
-- rather than visible until restricted.
create table project_members (
  project_id uuid not null references projects(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  role       text not null,                       -- owner | editor | viewer
  granted_by uuid references users(id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

-- ---------------------------------------------------------------- documents

-- Content, addressed by hash. Split from `documents` so that uploading the
-- same 4 MB .docx to three features stores one copy, and so a document's
-- history costs nothing when a revision changes only part of a tree.
create table blobs (
  sha256       text primary key,
  bytes        bigint not null,
  content_type text,
  content      bytea not null,
  created_at   timestamptz not null default now()
);

-- Naming and versioning over that content. `path` is relative to the
-- document's own level — `projects/<p>/` for a project document,
-- `projects/<p>/<feature>/` for a feature one — which is the same convention
-- `produces[]` in scripts/pipeline.mjs already uses, so materialisation is a
-- direct write and needs no path translation.
create table documents (
  id          uuid primary key,
  project_id  uuid not null references projects(id) on delete cascade,
  feature_id  uuid references features(id) on delete cascade,   -- null = project level
  path        text not null,
  category    text,        -- sop | transcripts | notes | ui | template | output | artefact
  stage       text,        -- the stage that produced it; null for an upload
  sha256      text not null references blobs(sha256),
  version     int  not null default 1,
  is_current  boolean not null default true,
  uploaded_by uuid references users(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- One current version per path, per level. Two partial indexes rather than one
-- over `coalesce(feature_id, …)`: a null feature_id means "project level", and
-- inventing a sentinel uuid to make one index work would put a fake foreign
-- key in the data to satisfy a constraint.
create unique index documents_current_project_path
  on documents (project_id, path) where is_current and feature_id is null;
create unique index documents_current_feature_path
  on documents (project_id, feature_id, path) where is_current and feature_id is not null;

-- ------------------------------------------------------------------- audit

-- Who did what, scoped to a project. Written by the engine and by every
-- mutating route, so the answer never depends on someone remembering to log.
create table actions (
  id              uuid primary key,
  company_id      uuid not null references companies(id) on delete cascade,
  project_id      uuid references projects(id) on delete cascade,
  feature_id      uuid references features(id) on delete cascade,
  issue_id        uuid references issues(id) on delete cascade,
  user_id         uuid references users(id) on delete set null,
  agent_key       text,
  installation_id uuid references installations(id) on delete set null,
  verb            text not null,   -- project.create | doc.upload | stage.trigger | gate.approve
  target_type     text,
  target_id       text,
  detail          jsonb not null default '{}',
  created_at      timestamptz not null default now()
);

-- ------------------------------------------------------------------- chats

create table conversations (
  id         uuid primary key,
  company_id uuid not null references companies(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  feature_id uuid references features(id) on delete cascade,
  user_id    uuid references users(id) on delete set null,
  title      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table messages (
  id              uuid primary key,
  conversation_id uuid not null references conversations(id) on delete cascade,
  seq             int  not null,
  role            text not null,   -- user | assistant | system | tool
  content         jsonb not null,  -- Anthropic-shaped content blocks
  adapter         text,
  model           text,
  input_tokens    bigint,
  output_tokens   bigint,
  cost_usd        numeric(12,6),
  created_at      timestamptz not null default now(),
  unique (conversation_id, seq)
);

-- -------------------------------------------------------------------- logs

-- What used to be .orchestrator/runs/<id>.jsonl, one row per envelope.
--
-- `stream` + `chunk` are kept verbatim rather than parsed into typed events,
-- because core/transcript.ts reassembles the inner stream by concatenating
-- every chunk IN FILE ORDER — that is the only way a line split across two
-- pipe reads is rejoined. Storing parsed events would break that reassembly;
-- storing the envelopes preserves it exactly, and `seq` is what file order
-- becomes once the file is gone.
create table run_events (
  run_id uuid not null references runs(id) on delete cascade,
  seq    int  not null,
  ts     timestamptz not null default now(),
  stream text not null,          -- stdout | stderr
  chunk  text not null,
  primary key (run_id, seq)
);

-- ----------------------------------------------------------------- alters

-- Issues gain their project. Cost per project is a group-by once this exists;
-- before it, project lived only inside `issues.params` jsonb and `/usage`
-- could report a company total and nothing finer.
alter table issues add column project_id uuid references projects(id) on delete set null;
alter table issues add column feature_id uuid references features(id) on delete set null;

-- Events live in run_events now. Nullable rather than dropped so a row written
-- by the previous build still reads back.
alter table runs alter column log_path drop not null;

-- ---------------------------------------------------------------- indexes

create index on users            (company_id, status);
create index on api_tokens       (user_id) where revoked_at is null;
create index on sessions         (user_id);
create index on installations    (company_id, last_seen_at desc);
create index on projects         (company_id) where archived_at is null;
create index on features         (project_id) where archived_at is null;
create index on project_members  (user_id);
create index on documents        (project_id, feature_id) where is_current;
create index on documents        (sha256);
create index on actions          (company_id, created_at desc);
create index on actions          (project_id, created_at desc);
create index on conversations    (company_id, updated_at desc);
create index on messages         (conversation_id, seq);
create index on issues           (project_id);
