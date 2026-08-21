-- Attribute existing issues to their project and feature.
--
-- 002_platform added `issues.project_id` and `issues.feature_id` with the note
-- "Cost per project is a group-by once this exists" — and then nothing ever
-- wrote them. The spend query has been joining `projects p on p.id =
-- i.project_id` ever since, so every row it returned carried `project_name:
-- null`: the Spend view showed one anonymous "—" holding the whole
-- installation's cost, by project, by feature, for every run ever recorded.
--
-- The project was never actually missing. It was sitting in `issues.params`
-- as a jsonb string the whole time, because that is what the workflow is
-- parameterised by. This lifts it into the foreign key that the reporting
-- side reads. `createIssue` now sets both at insert time; this is the history.
--
-- Matched by NAME within the same company, which is exactly how every other
-- part of this system resolves a project (`scyne use <name>`, the chatbot's
-- target picker, `stage.mjs`). Names are unique per company by constraint.
--
-- Idempotent and conservative: only rows that have no attribution yet, and
-- only where a name actually resolves. An issue naming a project that has
-- since been deleted keeps its null rather than acquiring a wrong one.

update issues i
   set project_id = p.id
  from projects p
 where i.project_id is null
   and i.params ->> 'project' is not null
   and p.company_id = i.company_id
   and p.name = i.params ->> 'project';

-- Features are scoped to a project, so this must run second and join through
-- the project_id the statement above has just set. Matching a feature by name
-- alone would attribute one client's "Appeals" to another client's.
update issues i
   set feature_id = f.id
  from features f
 where i.feature_id is null
   and i.project_id is not null
   and i.params ->> 'feature' is not null
   and f.project_id = i.project_id
   and f.name = i.params ->> 'feature';
