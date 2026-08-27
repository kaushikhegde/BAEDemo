# Publishing — Confluence/Jira and Azure DevOps

Split out of `CLAUDE.md`. Read this before touching anything that writes to a
client's wiki or backlog: `scripts/confluence-publish.mjs`,
`scripts/confluence-attach.mjs`, `scripts/jira-issues.mjs`,
`scripts/ensure-confluence-space.mjs`, `scripts/ado-publish.mjs`,
`scripts/ado-workitems.mjs`, `scripts/lib/publish-shared.mjs`, or the publish
prompt in `orchestrator.workflows.ts`.

**TWO publishing back ends, and `PUBLISH_TARGET` picks the default.**
`atlassian` (Confluence pages + Jira issues) is the default; `ado` (an Azure
DevOps wiki + work items) is the other. Both are live and both are asserted by
`npm run check:workflows`, which reads the same variable.

**A project keeps the system it has already published into.** The target is
recorded in `projects/<p>/.published.json` — `atlassianTarget` or `adoTarget`
— and mirrored into `projects.atlassian_target` / `projects.ado_target`. Every
publishing script resolves it from there (`resolvePublishTarget`,
`scripts/lib/publish-shared.mjs`), so flipping the environment variable cannot
move a project that has already delivered: a client has links to those
documents, and half a pack in each system is worse than either. A workflow's
prompt, though, is a fixed string compiled at boot from `PUBLISH_TARGET`, so a
mismatch cannot be papered over — `ensure-confluence-space.mjs` refuses loudly
before anything is written.

**Diagrams: this is the one real difference between the two.** An Azure DevOps
wiki takes **markdown natively** and renders ` ```mermaid ` fences itself, so
there is nothing to convert, render or attach. **Confluence does neither.**
Every diagram has to be rendered to PNG and ATTACHED, and the Atlassian MCP
**cannot attach anything at all** — its OAuth grant carries twenty scopes,
eight for Confluence, none for attachments, so `POST .../child/attachment`
answers `401 "scope does not match"` whichever host it is sent to, and
re-authorising does not add it. The symptom is the bad one: a page that
publishes cleanly with its diagrams **silently missing**.

So on the Atlassian path the MCP publishes pages and issues, and
`scripts/confluence-publish.mjs --render-mermaid` does the storage-format
conversion, the mermaid-cli PNG pass and the upload in one go, over an **API
token with Basic auth against the SITE domain**. A 3LO bearer from the MCP is
only valid against `api.atlassian.com`; reusing it is the second, independent
way a hand-rolled call has failed here, and it fails looking like the first.
`ATLASSIAN_SITE_URL` / `ATLASSIAN_EMAIL` / `ATLASSIAN_API_TOKEN` in the root
`.env`.

**Publishing goes through the Azure DevOps MCP** when `PUBLISH_TARGET=ado`,
configured in `.mcp.json`
with the PAT read from the root `.env` as `${MCP_TOKEN_FOR_AZURE}` — never
inlined, because that file is committed and a PAT in it is a PAT in the git
history. `scripts/ado-publish.mjs` and `scripts/ado-workitems.mjs` are the
REST equivalents, kept as fallbacks. The publish prompt reaches for the first
when a document exceeds about 40 KB — `wiki_upsert_page` takes the page body
as a `content` STRING parameter, with no publish-from-file form, so the whole
document must travel through the agent's context to reach it. Passing 110 KB
that way is measured to fail (run SCY-6: $2.73, no page).

**Two scopes, and a 401 that lies.** The PAT needs `vso.wiki_write` AND
`vso.work_write`. Azure DevOps answers a MISSING SCOPE with **401**, not 403 —
so a wiki call failing beside a working project call means a scope, not a bad
token. `node scripts/ado-publish.mjs --verify` says which.

**The PAGE goes through the MCP; the BACKLOG does not.** True on BOTH back
ends, and it is the same lesson. The publishing agent writes the page and
stops there. The backlog is created by the step after it — an `exec` running
`scripts/ado-workitems.mjs` or `scripts/jira-issues.mjs` — and the publish
prompt says, in as many words, not to create the items itself.

That split is the whole lesson of SA-Power-Networks / CRM-Management: 45
stories, the wiki page published cleanly, **zero** work items, and the agent's
turn finished normally, so the run recorded `succeeded`. Only
`verify-published.mjs` caught it, one step later, with the stage already paid
for. An exit code says a model stopped talking; it has never said the work
happened, and 45 sequential tool calls in one turn is where it stops.

A step cannot half-finish quietly (non-zero exit blocks the issue with the
real stderr), it is idempotent (`adoId` / `jiraKey` is written back per story,
so a re-run UPDATES rather than duplicating a client's backlog — the one
failure here that re-running cannot undo), and it discovers the work item /
issue type itself. The
prompt half was deleted rather than kept as a fallback: an instruction a model
may or may not follow, running beside a script that always does, is how you
get 90 work items instead of 45. `check-workflows.mts` asserts both halves.

It needs no `--summary-url`: that URL does not exist when the command is
compiled, so the script reads it back out of the `ado.<artefact>` /
`atlassian.<artefact>` record the publish step wrote moments earlier — which is why the publish prompt now
insists on the `url` field and not the path alone.

**An optional param reaches an `exec` step through the environment**, as
`SCYNE_PARAM_<NAME>`, never as a `{placeholder}`: `interpolate` THROWS on a
placeholder the issue does not carry, so `--parent {adoParentEpicId}` would
block every run that sets none. That is the same trap that broke every
requirements publish once already, and why `ensureAdoProjectStep` restricts
itself to `{project}`.

**The work item type is a PARAMETER, because no MCP tool lists them.** None of
those 40 can enumerate a project's work item types, and the name depends
entirely on the process template: "User Story" exists only under **Agile**,
while **Basic** has Epic → Issue → Task with no User Story at all — so an
agent guessing a familiar name fails every story at once, after the gate was
approved and the page already published.

It is now **per project**, not per install: `ado_target.workItemType` on the
project ROW (`projects.ado_target`), written when the project is created and
confirmed to exist BY NAME at that moment. New projects use the Agile
template and therefore `User Story`, which is what the BA's house style has
always described; SAPN predates this and is backfilled to Basic / `Issue`.
`npm run ado:verify` and the approval-time check both still confirm the exact
name before anything runs. `ADO_WORK_ITEM_TYPE` is retired.

`scripts/ado-workitems.mjs` remains the deterministic fallback — it discovers
the type itself, refuses to write a description still containing
`{{PRODUCT_SUMMARY_URL}}`, and writes the created ids back so a re-run cannot
duplicate a backlog.

## The Azure DevOps MCP

Project-scope, configured in `.mcp.json` at the workspace root:

```json
{
  "mcpServers": {
    "azure-devops": {
      "command": "npx",
      "args": ["-y", "@azure-devops/mcp", "Scyne-AI-Lab", "--authentication", "pat"],
      "env": { "PERSONAL_ACCESS_TOKEN": "${MCP_TOKEN_FOR_AZURE}" }
    }
  }
}
```

Organisation `Scyne-AI-Lab`, project `Scyne AI Project`. Microsoft's first-party
server in **PAT mode** — a configuration the client tested and published with,
rather than one researched here. It is also the only ADO MCP that has BOTH wiki
write tools and work item tools: the PAT-based third-party server
(`@tiberriver256/mcp-server-azure-devops`) exposes `get_wikis`, `get_wiki_page`
and `search_wiki` and no wiki writes at all.

**`${VAR}` is expanded by us on the Codex path.** Claude Code expands
`${VAR}` in `.mcp.json` itself. `readMcpServers` in `core/codex-runner.ts` does
not go through Claude Code — it parses the same file and re-encodes each value
as a `codex -c` TOML override — so without expansion a Codex run would hand the
MCP server the literal string `${MCP_TOKEN_FOR_AZURE}`, and every ADO call
would 401 with a credential that looks perfectly present in the config. Since
the whole org runs on Codex, that is not an edge case. A variable that resolves
to nothing is a hard error naming the variable and the file, because
substituting an empty string produces a 401 that reads like a permissions
problem.

The runner passes `--mcp-config <workspace>/.mcp.json --strict-mcp-config` for
any agent with `mcpEnabled: true`, and omits both for everyone else. Without
`--mcp-config`, a project-scope MCP needs interactive trust approval, which
cannot happen in `--print` mode. `--strict-mcp-config` keeps an agent from
inheriting whatever MCPs the developer happens to have configured at user scope.
