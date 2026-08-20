-- Many organisations in one install, and a super-admin above them.
--
-- `companies` and a `company_id` on every platform table have existed since
-- 001. Nothing ever used them as a DIMENSION: index.ts resolved one company id
-- at boot and handed that same value to every call for the life of the
-- process, so the schema was multi-tenant and the application was not.
--
-- Nothing here changes an existing row's meaning. It adds the three columns an
-- organisation needs to be addressable (a slug), suspendable (a status) and
-- retirable (archived_at — never a delete, because issues, runs and spend all
-- reference it), plus the attribution column that makes "who started this run"
-- an answerable question.

alter table companies add column slug        text;
alter table companies add column status      text not null default 'active';
alter table companies add column archived_at timestamptz;

-- A slug for rows that predate the column, DERIVED from the name rather than
-- invented: lowercase, every run of non-alphanumerics collapsed to one hyphen,
-- ends trimmed. 'Scyne AI Lab' -> 'scyne-ai-lab'.
--
-- Deliberately a one-off backfill rather than a generated column. A generated
-- slug would silently change the moment anyone renamed an organisation, and
-- the slug is what `X-Scyne-Org` carries and what `scyne org use` pins — so a
-- rename would quietly invalidate every operator's saved config and every
-- script that names an org. Derived once, then owned.
update companies
   set slug = trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'))
 where slug is null;

-- A company whose name is entirely non-alphanumeric backfills to '' rather
-- than to null, which would then pass NOT NULL and collide with the next one.
-- Falling back to the id keeps it unique and still human-recognisable.
update companies set slug = 'org-' || left(id::text, 8) where slug = '';

-- Two organisations may not share a slug: it is what an operator types and
-- what an authorisation header carries, so an ambiguous one is a security bug
-- rather than a cosmetic one. Applied AFTER the backfill — before it, the
-- backfill itself could violate it.
alter table companies alter column slug set not null;
create unique index companies_slug_key on companies (slug);
create index on companies (status) where archived_at is null;

-- Who started this issue.
--
-- `on delete set null`, NOT cascade: deleting a user must never delete the
-- work they did. Existing rows stay null and render as '—'. Back-filling an
-- attribution that nobody recorded would be inventing evidence, and "started
-- before we tracked this" is a true and useful thing for a column to say.
alter table issues add column created_by uuid references users(id) on delete set null;
create index on issues (created_by);

-- One person, one account, one organisation.
--
-- `users` was unique on (company_id, email), which is the right constraint for
-- a single-tenant install and the WRONG one the moment there are two
-- organisations: `POST /auth/login` receives an email and a password and
-- nothing else. A person does not know their organisation's uuid, so a
-- company-scoped lookup would leave every user outside the home organisation
-- unable to sign in at all — the login form would simply reject them.
--
-- Making the address unique across the whole install is what lets login be
-- org-agnostic. The alternative — asking for an organisation on the login
-- form — pushes an implementation detail onto the person signing in and has
-- to be repeated on the CLI, the console and the chatbot.
--
-- If this index fails to create, two organisations already share an address.
-- Postgres names the offending value in the error. Decide which account is
-- real, delete or re-address the other, and re-run.
create unique index users_email_key on users (lower(email));

-- The person who claimed this installation becomes its superadmin.
--
-- `POST /auth/bootstrap` recorded them as `admin` because `superadmin` did not
-- exist yet. Claiming an installation is exactly what superadmin means — they
-- operate the whole thing rather than one organisation inside it — so leaving
-- them as an admin would lock the only human out of the organisation
-- management they are about to be given.
--
-- Narrow on purpose: only in an install that has exactly ONE organisation
-- (so there is no ambiguity about who "the operator" is), and only the
-- earliest-created user, and only if they are currently an admin.
update users set role = 'superadmin'
 where role = 'admin'
   and created_at = (select min(created_at) from users)
   and (select count(*) from companies) = 1;
