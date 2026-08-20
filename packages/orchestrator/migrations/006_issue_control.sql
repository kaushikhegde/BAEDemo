-- Stopping a running issue: pause, pause now, cancel.
--
-- Nothing could stop a run before this. `spawn.ts` killed a child only on a
-- budget breach; there was no route, no CLI verb and no button. An agent run
-- averages twenty-five minutes and real money, so "I started the wrong thing"
-- cost twenty-five minutes and its spend.
--
-- A REQUEST, not a status, and the difference is the whole design. The request
-- is made by a human at an arbitrary moment; the status changes when the engine
-- next reaches a point where it can honour it. Collapsing the two means either
-- lying about the status for twenty minutes ("paused" while an agent is still
-- burning tokens) or losing the request (setting a status the engine then
-- overwrites when the step it was mid-way through completes).
--
--   pause      let the in-flight step finish, then park before the NEXT one.
--              Nothing lost, nothing wasted.
--   pause_now  kill the child now and park at THIS step, to be re-run later.
--   cancel     kill the child now; the issue is over.
alter table issues add column control_request      text;
alter table issues add column control_requested_by uuid references users(id) on delete set null;
alter table issues add column control_requested_at timestamptz;

-- The vocabulary is checked in the database, not only in the route handler.
-- A typo in a handler would otherwise sit in this column forever as a request
-- the engine does not recognise and will never clear — an issue that looks
-- like it is being stopped and never is.
alter table issues add constraint issues_control_request_check
  check (control_request is null or control_request in ('pause', 'pause_now', 'cancel'));

-- Finding the issues with an outstanding request is the engine's hot path
-- while anything is running; the partial index keeps it proportional to the
-- number of REQUESTS rather than to the number of issues.
create index on issues (control_request) where control_request is not null;

-- `issues.status` gains 'paused'. 'cancelled' was already in 001's documented
-- vocabulary for this column and was never written by anything.
--   todo | in_progress | in_review | paused | blocked | done | cancelled
