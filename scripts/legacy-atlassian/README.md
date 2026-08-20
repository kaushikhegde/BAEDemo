# The Atlassian publishing path, retired 2026-08-20

Delivery moved to Azure DevOps: wiki pages replace Confluence pages, work items
replace Jira issues. These files are kept rather than deleted because they are
the only record of how the Atlassian protocol actually worked, and two of the
lessons in them cost real money to learn. The same precedent as
`scripts/legacy-react-scaffold/`.

Nothing imports them. `scripts/lib/ado.mjs`, `scripts/ado-publish.mjs` and
`scripts/ado-workitems.mjs` are the live equivalents.

| File | What it was |
|---|---|
| `confluence-publish.mjs` | Created or updated a page from a markdown file, converting to storage format and rendering Mermaid to PNG in one pass |
| `confluence-attach.mjs` | Uploaded attachments — the ONLY supported way, because the Atlassian MCP has no attachment scope |
| `atlassian.mjs` | Shared credentials: API token, Basic auth, against the SITE domain |
| `atlassianProvision.ts.txt` | Created a missing Jira project or Confluence space at approval time |

## The two lessons, and where they went

**Moving bytes is not a reasoning task.** On run SCY-6 (18 Aug 2026) an agent
was told to read a 110 KB data model and pass it to `createConfluencePage` as a
tool argument. It read the document three times assembling the call, hit a
context compaction thirteen minutes in, lost its place and started over: $2.73
spent, no page created, and it would have run to the 45-minute budget kill.
`confluence-publish.mjs` existed to send the file straight from disk.

Publishing is now done through the Azure DevOps MCP by choice, and that lesson
survives as a size threshold: the publish prompt tells the agent to use
`scripts/ado-publish.mjs` for anything over about 40 KB.

**The Atlassian MCP has no attachment scope and never will.** Its OAuth grant
carries twenty scopes, eight for Confluence, none for attachments, so
`POST .../child/attachment` answered `401 "scope does not match"` — and a raw
curl reusing that token failed the same way, because a 3LO bearer is only valid
against `api.atlassian.com`, not the site domain. The symptom was a page that
published with its diagrams **silently missing**.

That whole problem is gone rather than solved: Azure DevOps wiki takes markdown
natively and renders ```mermaid fences itself, so there is no conversion pass,
no PNG rendering and nothing to attach.

## Provisioning became verification

`atlassianProvision.ts` CREATED a missing Jira project or Confluence space
during approval. `scyne-chatbot/server/services/adoVerify.ts` deliberately does
not: creating an Azure DevOps project is a long-running asynchronous operation
returning an operation id to poll, and a half-created project is a worse thing
to hand a client than a clear refusal. It checks, and says precisely what is
wrong — including the one that reads like something else, a **401 on the wiki
API beside a working project call**, which means the token lacks
`vso.wiki_write` rather than being invalid.
