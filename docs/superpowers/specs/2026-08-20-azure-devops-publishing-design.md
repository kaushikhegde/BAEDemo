# Confluence + Jira → Azure DevOps — design

**Date:** 2026-08-20
**Status:** Design, awaiting review
**Sibling specs:** `2026-08-20-codex-cli-adapter-design.md`, `2026-08-20-super-admin-tracking-design.md`

> **Superseded in part, 2026-08-20** by
> `2026-08-20-multitenant-platform-design.md`, which was written after the
> user chose a MULTI-ORGANISATION model with a super-admin above it, and chose MCP-based publishing over the REST-scripts-only recommendation in §3 below.
> Read that spec first; this one is kept for the reasoning it records.

---

## 1. Why

Delivery moves to Azure DevOps. Confluence pages become **ADO Wiki pages** and
Jira stories become **User Story work items**. Atlassian is retired, not run
alongside.

The good news is that the hard lesson has already been learned and the shape is
already right. `scripts/confluence-publish.mjs` exists because passing a 110 KB
document through a tool call cost $2.73 on run SCY-6 and produced no page at
all: the agent read the document three times building the call, hit compaction
thirteen minutes in, and started over. **Moving bytes is not a reasoning task.**
ADO publishing is therefore scripts, invoked by the publish agent, for exactly
the same reason.

It gets simpler on the way across. ADO Wiki takes **markdown natively**, so the
markdown → Confluence storage-format conversion disappears entirely, and page
identity is the **path** rather than a title lookup plus a remembered `pageId`.

## 2. The two scripts

### `scripts/ado-publish.mjs`

```
node scripts/ado-publish.mjs <file.md> \
     --org <org> --project <project> --wiki <wiki> \
     --path "/Scyne/RTWSA/Data Model" \
     [--attach diagram.png ...] [--render-mermaid] \
     [--published-json <path> --artefact-key <key>] [--json] [--verify]
```

- **Auth:** Basic, `":" + PAT` base64-encoded, PAT from `ADO_PAT` (falling back
  to `MCP_TOKEN_FOR_AZURE`), read from the root `.env` the same way
  `confluence-attach.mjs` reads its token today.
- **Create or update:** `PUT /{org}/{project}/_apis/wiki/wikis/{wiki}/pages?path={path}&api-version=7.1`
  with `{"content": "<the markdown>"}`. An update requires the `If-Match` ETag
  from a `GET` of the same path; a create is the bare `PUT`. **Idempotent by
  path** — republishing a revision updates in place and can never leave the
  client with two documents.
- **Images:** `PUT .../wikis/{wiki}/attachments?name={n}&api-version=7.1` with
  the raw bytes, then the markdown `![alt](diagram.png)` is rewritten to
  `![alt](/.attachments/diagram.png)`. Re-uploading a name replaces it, which is
  what a revision needs.
- **Mermaid:** ADO Wiki renders ```` ```mermaid ```` fences natively, so the
  default is to **leave them alone** — the `npx @mermaid-js/mermaid-cli` PNG
  pass, and the whole reason `confluence-attach.mjs` had to exist, both go away.
  `--render-mermaid` is kept as a fallback for diagram types the wiki's older
  Mermaid build rejects; it renders to PNG, attaches, and rewrites the fence.
- **`--verify`:** confirms the org, project and wiki exist and the PAT can write,
  and exits non-zero naming which one failed. Publishing agents run this first,
  so a bad target blocks in seconds rather than after a document is built.

### `scripts/ado-workitems.mjs`

```
node scripts/ado-workitems.mjs <stories.json> \
     --org <org> --project <project> \
     [--parent <epicId>] --summary-url <wiki url> [--json]
```

- `POST /{org}/{project}/_apis/wit/workitems/$User Story?api-version=7.1`,
  `Content-Type: application/json-patch+json`, one `add` op per field:
  `System.Title`, `System.Description` (HTML — ADO's rich-text format, not
  Atlassian Document Format), `Microsoft.VSTS.Common.AcceptanceCriteria`, plus a
  `System.LinkTypes.Hierarchy-Reverse` relation to `--parent` when one is given.
- Prints `story_number | work_item_id | url` and writes the ids back into
  `stories.json`, so a re-run **updates** rather than duplicating.

**This deletes a documented footgun.** Today the model is told to replace
`{{PRODUCT_SUMMARY_URL}}` in each description before creating the issue — and
that doubled brace exists only because the engine's own interpolator once
matched the inner `{PRODUCT_SUMMARY_URL}` and blocked every requirements run at
publish, immediately after a human had approved its gate. `--summary-url` moves
the substitution into the script, where it is a string replace instead of an
instruction a model can forget.

## 3. MCP: recommended not to wire one

Both scripts use the REST API with the PAT. Once they do, the only thing an MCP
would add is lookups — "does this project exist" — which `--verify` answers more
cheaply and without a subprocess.

Recommendation: **ship without an ADO MCP**, and delete `.mcp.json`'s atlassian
entry rather than replacing it. `mcpEnabled` stays on the agent spec and on the
runners (both Claude and Codex support it) so wiring one later is configuration,
not code.

If an MCP is wanted anyway, `@azure-devops/mcp` (Microsoft, v2.9.0) authenticates
through Azure CLI login rather than a PAT, so `MCP_TOKEN_FOR_AZURE` would not be
what it uses — a PAT-based third-party server would be needed instead. That
mismatch is the second reason not to start here.

## 4. Everything that changes

| File | Change |
|---|---|
| `orchestrator.workflows.ts` | `publishPrompt` rewritten: `ado-publish.mjs`, then `ado-workitems.mjs` for `requirements`. Gate summaries say "publishes to Azure DevOps" |
| `scripts/pipeline.mjs` | unchanged — it describes stages, not destinations |
| `agent-instructions/*.thin.md` | 8 bundles mention Confluence/Jira; each rewritten to ADO |
| `scyne-chatbot/server/orchestrator.ts` | `confluenceSpace`/`jiraProjectKey`/`parentEpicKey` params → `adoOrg`/`adoProject`/`adoWiki`/`adoParentEpicId` |
| `scyne-chatbot/server/services/atlassianProvision.ts` | replaced by `adoVerify.ts`. **Verify only, never create** — an ADO project create is a long-running async operation and a half-created project is worse than a clear refusal |
| `scyne-chatbot/.env` + root `.env` | `ATLASSIAN_*` and `DEFAULT_CONFLUENCE_*`/`DEFAULT_JIRA_*` out; `ADO_ORG`/`ADO_PROJECT`/`ADO_WIKI`/`ADO_PAT` in |
| `packages/orchestrator/openapi.yaml` | any route whose params changed; `openapi.test.ts` diffs both directions |
| `npm run check:routing` | asserts the new title/description shapes route correctly — must be re-run |
| `projects/<p>/.published.json` | `{pageId,url,title,space}` → `{wikiPath,url,wiki,project,org}` |
| `CLAUDE.md` | the Mermaid→PNG note, the attachment-scope note, the publishing section, the endpoint table |
| `scripts/confluence-{publish,attach}.mjs` | moved to `scripts/legacy-atlassian/` with a README, following the `legacy-react-scaffold/` precedent — they are the only record of how the Atlassian publishing protocol worked |

### Page identity and existing projects

`.published.json` gains an `ado` namespace; any existing `confluence` block is
left in place and ignored. Nothing migrates: the ADO wiki has no page to update
until the first ADO publish creates one, and inventing a mapping between a
Confluence pageId and a wiki path would be guessing.

## 5. Testing

- `test/ado-publish.test.ts` against a mocked REST surface: create, update via
  ETag, attachment rewrite, `--verify` failure modes, and idempotency (same path
  twice → one page, version 2).
- `test/ado-workitems.test.ts`: JSON-Patch body shape, parent link present only
  when `--parent` is given, `--summary-url` substituted, re-run updates rather
  than duplicating.
- `npm run check:routing` and `openapi.test.ts` both green.
- **Acceptance:** a full `requirements` run publishes one wiki page and its
  stories as work items under the epic, and a `revise-requirements` run updates
  that same page rather than creating a second.

## 6. Open — needed before the first live run, not before implementation

The org, project and wiki names. They are workflow **params**, exactly as
`confluenceSpace` is today, so the code does not need them; the first end-to-end
run does. Also worth confirming the PAT carries `vso.wiki_write` and
`vso.work_item_write` — `--verify` will report it either way.

## 7. Risks

| Risk | Handling |
|---|---|
| ADO Wiki's Mermaid build rejects a diagram type | `--render-mermaid` PNG fallback is kept, not deleted |
| PAT expires (ADO PATs are max 1 year) | `--verify` fails with the auth error before any document is built |
| A wiki path collides across features | Path template includes project and feature; asserted by a test |
| Losing the Atlassian publishing knowledge | Scripts archived, not deleted; CLAUDE.md keeps a short note on why they went |
