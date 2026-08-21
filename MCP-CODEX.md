# Publishing through the Azure DevOps MCP on Codex

Everything published — wiki pages and work items — goes through the Azure
DevOps MCP. `scripts/ado-publish.mjs` remains the fallback for a document too
large to pass through a tool call, and nothing else.

Getting MCP to work under `codex exec` needed three findings. Each is recorded
here because each cost a run to discover and every one of them fails in a way
that looks like something else.

## 1. The sandbox blocks shell commands, not MCP

Codex runs every agent inside macOS Seatbelt (`sandbox-exec`). Its outbound
allow-list is four entries:

```
(deny default)
(allow network-outbound (remote ip "*:53"))          DNS
(allow network-outbound (remote ip "localhost:*"))   loopback
(allow network-outbound (remote unix-socket))
(allow network-outbound (literal "/private/var/run/syslog"))
```

So a **shell command** the agent runs cannot reach `dev.azure.com`. Reproduced
exactly, same machine, same Node, only the sandbox differing:

```
under the policy : node fetch -> THREW: fetch failed  cause=EPERM
unrestricted     : node fetch -> HTTP 302
DNS resolves in BOTH cases
```

That is why run SCY-1's `node scripts/ado-publish.mjs` died with a bare
`fetch failed` and nothing that looked like a permissions problem. It also
explains why the agent could still think perfectly well for ten minutes:
`CODEX_BASE_URL` points at a proxy on `127.0.0.1`, which is on the allow-list.

**The MCP server is NOT in the sandbox.** Codex spawns it as a direct child,
the same way it spawns `git`. Verified by walking the process tree during a
live run:

```
codex exec --sandbox workspace-write
 └─ npm exec @azure-devops/mcp          sandbox-exec in its chain? FALSE
     └─ node .../mcp-server-azure-devops
```

**Consequence: publishing over MCP needs no change to the sandbox at all.**
Do not add `sandbox_workspace_write.network_access` for this — it would open a
hole nothing uses.

## 2. `codex exec` refuses every MCP call, and the flag that fixes it

`codex exec` is non-interactive and pins `approval_policy` to `never`. An MCP
tool call is something Codex wants approved. With nobody to ask, every call
fails:

```json
"tool": "wiki", "arguments": {"action":"list_wikis"},
"error": {"message": "MCP tool call requires approval, but approval policy is never"},
"status": "failed"
```

That is run SCY-1's real failure. The agent then explained itself in prose and
exited 0, the engine recorded `succeeded`, and the issue closed **`done`** with
no wiki page and no `.published.json`.

Three things do **not** fix it, all tested:

| Tried | Result |
|---|---|
| `mcp_servers.<name>.default_tools_approval_mode="auto"` | ignored |
| `mcp_servers.<name>.tools.<tool>.approval_mode="auto"` | ignored |
| `approval_policy="granular"` with every category | `exec` overrides it |

The only lever is **`--approve-for-me`**, set in `buildCodexArgs` for agents
with `mcpEnabled`. Note it is **mutually exclusive with `--sandbox`** — Codex
refuses the two together, and `--approve-for-me` applies workspace-write
itself, so nothing is loosened by the swap.

## 3. The reviewer model, and why the proxy rewrites it

`--approve-for-me` routes each approval through an automatic review — one
extra model call per tool call. **That review is hard-wired to
`gpt-5.6-luna`.** No config key redirects it; `auto_review_model_override` and
`guardian_review_model_override` are both accepted and both ignored, confirmed
by capturing the outgoing request:

```
model=gpt-5.2       ->  HTTP 200     the agent
model=gpt-5.6-luna  ->  HTTP 404     the reviewer
```

An install whose endpoint does not serve `gpt-5.6-luna` therefore has every
tool call rejected as *"unacceptable risk"* — a message that sounds like a
safety judgement and is really a missing deployment.

Two ways to fix it:

**(a) Deploy `gpt-5.6-luna`.** Cleanest, and it is the cheap model
($0.20 in / $1.20 per Mtok). Nothing else changes.

**(b) Map it at the proxy.** Three edits, each found by the error the previous
one unmasked:

```js
model:              gpt-5.6-luna -> gpt-5.2        404 deployment does not exist
reasoning.context:  all_turns    -> auto           400 'all_turns' not supported
header:             drop x-openai-internal-codex-responses-lite
                                                   400 model not supported in lite mode
```

(2) and (3) apply only to a request that was remapped — the lite mode and the
all-turns context are legitimate for the small review model, and only wrong
once the model underneath has changed.

Verified 4 runs out of 4: an agent calling `wiki`/`list_wikis` over MCP returns
`Scyne-AI-Project-Wiki`.

## 4. Pin the MCP version

`.mcp.json` runs `npx -y @azure-devops/mcp`, which resolves and starts the
package on **every run**. When it is slow, Codex proceeds with no tools
registered and the agent — seeing no Azure DevOps tools — invents a plausible
reason for failing. Observed in 2 of 5 consecutive runs; visible in the token
count, since the 40 tool schemas are worth tens of thousands of input tokens:

```
tools registered : 157k / 56k / 54k input tokens
tools missing    :  25k / 12.5k
```

Pin the version so the resolve is a cache hit.

## What a publish is now checked against

`scripts/verify-published.mjs` runs as an `exec` step after every publish and
blocks the issue unless the page is really there — first that
`.published.json` names the artefact, then that the page **resolves over the
API**. The second is the one that matters: the first is a file the agent wrote
about its own work.

An agent's exit code says the model finished talking. For every other stage the
`produces` files close that gap; a publish leaves nothing on this machine, so
it was the one step in the pipeline running on trust.

## Checking it without spending a run

```bash
npm run mcp:test          # config, server start, 40 tools, PAT through the MCP
npm run ado:verify        # org, project, wiki scope, work item type
```

`mcp:test` is the faster signal — it starts the server with exactly the argv
and env an agent gets, so it catches a wiring fault before a run does.
