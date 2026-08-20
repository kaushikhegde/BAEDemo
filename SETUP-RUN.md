# Running the stack, end to end

Everything below is from a **clean database**. Read the two blockers at the
bottom first — the code is done, but two credentials on this machine are not.

---

## 0. Once per clone

```bash
npm run setup          # installs root, packages/orchestrator and scyne-chatbot
npm run link-skills    # .claude/ is gitignored — a fresh clone always needs this
```

Without `link-skills`, every agent run dies with `Unknown skill: <slug>`.

## 1. Start it

```bash
npm run dev            # orchestrator on :3100 (console at /orch), chatbot on :5173
```

## 2. Claim the installation

The first account is the installation's **superadmin** — it can create
organisations and see every one of them.

```bash
node cli/index.ts init
#   Superadmin email: you@scyne.co
#   Password: ********
```

Then open **http://127.0.0.1:3100/orch** and sign in with those credentials.
The console will not show you anything until you do: every engine and platform
route now requires a credential, and only `/health`, `/orch`, `/docs` and
`/openapi.json` are open.

## 3. Create an organisation and a person in it

```bash
node cli/index.ts org create "Alpha Council of SA"
node cli/index.ts org use alpha-council-of-sa      # act inside it
node cli/index.ts user create ana@alpha.co --role admin
node cli/index.ts project create "AlphaClaims"
```

Or do all of it in the console: **Organisations** → **Users** → **Projects**.

An ordinary `admin` sees only their own organisation, and cannot create another
or act inside one. Only a superadmin can.

## 4. Run a stage, and stop it if you need to

```bash
node cli/index.ts run capabilities --project AlphaClaims
node cli/index.ts status SCY-1

node cli/index.ts run pause  SCY-1            # the step in flight finishes first
node cli/index.ts run pause  SCY-1 --force    # stop the agent NOW
node cli/index.ts run resume SCY-1
node cli/index.ts run cancel SCY-1            # for good; prompts unless --yes
```

The same four are on the console's issue page and in the chatbot's Workflow
panel. All of them are recorded against the person who asked.

## 5. See what it cost

```bash
node cli/index.ts spend --by model      # or project | feature | user | agent | adapter
node cli/index.ts models list           # the price catalogue, retirements flagged
```

Reported and estimated are separate columns and never added together. Codex
reports no cost of its own, so on this install the estimated column is most of
the bill — it is computed from token counts and the recorded model price.

## 6. Publish

Publishing goes to the Azure DevOps wiki and work items. Check the target
first — it takes two seconds and saves a run:

```bash
npm run ado:verify
```

---

# Two things that must be fixed before a run can succeed

Both are credentials on this machine, not code. Everything else is done and
verified.

### 1. The Azure DevOps PAT has no wiki scope

`npm run ado:verify` reports:

```
✓ organisation reachable and the token is valid — 1 project(s)
✓ project exists — Scyne AI Project
✗ token has the WIKI scope        ← 401
✓ token has the WORK ITEM scope — 12 type(s)
```

Azure DevOps answers a **missing scope with 401**, not 403, so this reads
exactly like a bad token. It is not — work items already work with it.

**Fix:** add `vso.wiki_write` (and keep `vso.work_write`) at
<https://dev.azure.com/Scyne-AI-Lab/_usersSettings/tokens>, put the new value in
the root `.env` as `MCP_TOKEN_FOR_AZURE`, and re-run `npm run ado:verify`.

### 2. Codex is not actually authenticated

`codex login status` says "Logged in using an API key", but a real run gets:

```
401 Unauthorized: Incorrect API key provided … url: https://api.openai.com/v1/responses
```

The key currently in `CODEX_CLI` has **Azure** key shape and is being sent to
`api.openai.com`, which rejects it.

`SCYNE_ADAPTER=codex` is now the default, so **every agent run will fail at its
first request until this is sorted.**

**Fix — pick one:**

- `codex login` with a real OpenAI API key or a ChatGPT sign-in; or
- point Codex at Azure through its own provider configuration, if that key is
  meant for an Azure deployment; or
- set `SCYNE_ADAPTER=claude_local` in `.env` to keep running on Claude Code
  while you sort it. Everything else in this work is adapter-independent —
  though a Claude run reports its own cost, so the estimated column stays empty.

> That key was printed into the working transcript while diagnosing this.
> Worth rotating if the log is shared.
