# Scyne — setup and operations

How to wipe the database, run your own server, claim it as administrator, and get
the `scyne` command onto a colleague's machine.

Commands are given exactly as typed. Everything here has been run on a real
machine except where marked **unverified**.

---

## New machine — two commands

You need **Node 24**, **Claude Code** installed and signed in once
(`npm install -g @anthropic-ai/claude-code`, then `claude`), and a **Gemini API
key** for the chat. No Docker, no Postgres.

```bash
npm run setup     # once: packages, skills, .env, and your admin login
npm run dev       # every time
```

Then open `http://localhost:5173` and sign in with the login setup created.

Setup also saves `SCYNE_ORCH_TOKEN`, the key background jobs use to report
progress — without it, document reading shows nothing until it has finished.
Setup writes a `.env` that keeps everything on this machine: the built-in
database (`.orchestrator/pgdata`), documents in a folder
(`.orchestrator/blobs`, `SCYNE_DOCUMENT_STORE=local`) and publishing off
(`PUBLISH_TARGET=none`). It is safe to re-run; an existing `.env` is kept.
Back up `.orchestrator/` to back up everything.

---

## The four pieces

Knowing which is which makes the rest of this readable.

| Piece | What it owns |
|---|---|
| **orchestrator** `:3100` | The server. Projects, documents, accounts, gates, cost. Everything talks to it. |
| **chatbot** `:4000` / `:5173` | The web UI, and the Gemini conversation. The `scyne` session borrows its chat. |
| **`scyne`** | The command line. With no arguments it opens an interactive session. |
| **`projects/` on disk** | Where agents still read and write generated documents. A database reset never touches it. |

---

## Part A — Your own server

### 1. Wipe the database

The bare verb is a **dry run**: it prints what would go and deletes nothing.

```bash
# Stop `npm run dev` first — the database allows one writer.
npm run orch -- reset --all
```

```
Would delete, for company …:
  7 issue(s) and every comment, work product, gate and run under them
  every budget
  10 raw run log(s) in .orchestrator/runs/
  1 user(s), every API token and session
  1 project(s) with their features, members and audit trail
  0 stored document(s) — the DATABASE copy; files under projects/ are untouched
  0 plugin installation(s), and every saved chat

  After this the installation is UNCLAIMED — run `scyne init` to set it up again.

Nothing has been deleted. Re-run with --yes to do it.
```

When the list looks right:

```bash
npm run orch -- reset --all --yes
```

**Three depths**, each a superset of the last:

| Command | Removes |
|---|---|
| `reset` | Issues, runs, gates, comments, budgets |
| `reset --hard` | ＋ agents and console overrides |
| `reset --all` | ＋ users, projects, documents, installations, chats — a factory reset |

Only `--all` leaves the installation claimable again.

> **Your generated work is safe.** `projects/SAPN`, `projects/SAPN_DEMO` and both
> companion apps live on disk and are never touched by a database reset. What you
> lose is run history and cost accounting.

---

### 2. Choose where the database lives

This is the decision that separates "works on my laptop" from "my team can use it".

| Setting | Database | Good for |
|---|---|---|
| *(unset)* | PGlite — a file at `.orchestrator/pgdata`, **single writer** | You, on one machine. **Cannot serve a team.** |
| `DATABASE_URL` | A real PostgreSQL server | Several people, several machines |

Put it in `.env` at the **repo root** — the same file the chatbot reads:

```bash
# .env
DATABASE_URL=postgres://scyne:secret@db.internal:5432/scyne
```

Migrations apply automatically on boot. Verified against a copy of a live
database: existing issues and runs survive, the new tables are added.

> A `.env` inside `packages/orchestrator/` is a natural guess and does nothing —
> the config warns you if it finds one there. Configuration lives in one file.

**Unverified:** no PostgreSQL server was available on the build machine, so the
`external` driver has only been exercised through PGlite (which *is* Postgres
16.4). The first real connection is yours to make.

---

### 3. Start it

```bash
npm run dev          # orchestrator :3100 + chatbot :4000 / :5173
```

Confirm it is the current build. `401` is the correct answer here — it means the
route exists but you are not signed in:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3100/auth/whoami
# 401
```

> **Before letting colleagues connect.** The server binds **loopback only**
> (`127.0.0.1`) and speaks plain HTTP with bearer tokens. Put it behind a reverse
> proxy with TLS (Caddy, nginx) before anyone reaches it over a network. Do not
> simply widen the bind address.

---

### 4. Install the `scyne` command

`scyne` is not on your PATH until you link it. From the repo root, once:

```bash
npm link
```

```bash
which scyne
# /Users/you/.nvm/versions/node/v24.x.x/bin/scyne
```

It now works from **any directory** — that is the point, since the plugin is
pointed at projects on a server rather than at the folder you are standing in.

**Three ways to run it**, if you would rather not link:

| Form | Needs | Notes |
|---|---|---|
| `scyne <cmd>` | `npm link` once | Works anywhere. Recommended. |
| `npm run scyne -- <cmd>` | nothing | From the repo root. The `--` is required, or npm eats the flags. |
| `node cli/index.ts <cmd>` | nothing | From the repo root. Node 24 runs the TypeScript directly. |

To undo: `npm unlink -g scyne`.

> **If `npm link` fails with a permissions error**, your global npm prefix is
> root-owned. Either use a node version manager (nvm, fnm, volta), or set a user
> prefix: `npm config set prefix ~/.npm-global` and add `~/.npm-global/bin` to
> your PATH.

---

### 5. Claim it as administrator

Once per installation, ever — **not** once per person.

```bash
scyne init
```

```
This claims the Scyne installation at http://127.0.0.1:3100
as its first administrator. It can only be done once.

Administrator email: you@yourdomain.com
Password: (typed, not echoed)

✓ installation claimed by you@yourdomain.com
```

The token is saved to `~/.scyne/config.json`, mode `0600`. Choose the password
yourself; only pass `--password` when scripting, since it lands in shell history.

---

## Part B — Handing it to your team

### 6. Create their account

On your machine, once per colleague:

```bash
scyne user create bob@yourdomain.com --role member
```

```
✓ created bob@yourdomain.com (member)

  temporary password: k3n8fq2wp1zx
  Give it to them once, in person or over something private —
  it is not stored anywhere and will not be shown again.
```

Then grant access to the projects they need:

```bash
scyne member add bob@yourdomain.com --project RTWSA --role editor
```

| Project role | Can | Cannot |
|---|---|---|
| `viewer` | Read the project | Upload, run stages, approve |
| `editor` | Upload, run stages, approve gates | Change who has access |
| `owner` | Everything, including granting access | — |

A project is **private until shared**. Someone with no membership gets `404`, not
`403` — they cannot even learn it exists.

---

### 7. Get the command onto their machine

> **Not yet packaged.** There is no published npm package or installer —
> packaging was outside the build. Distribution today is a git clone.

What a colleague runs, once:

```bash
git clone <your repo url> && cd requirement-generator
npm install
npm --prefix packages/orchestrator install
npm link                      # puts `scyne` on their PATH (see step 4)

scyne login --api https://scyne.yourdomain.com
```

```
Email: bob@yourdomain.com
Password: (the temporary one you gave them)

✓ logged in as bob@yourdomain.com (member)
```

They never run `scyne init` — it refuses once the installation is claimed, and
says so. They only ever `login`.

Have them change the temporary password immediately:

```bash
scyne user password bob@yourdomain.com   # prompts, no echo
```

---

## Part C — Daily use

### The session

Type `scyne` with no arguments. Talk to it in plain English.

```
█ SCYNE  requirements pipeline
you@yourdomain.com · adapter claude_local · 127.0.0.1:3100

Talk to it in plain English. /help for commands, /exit to leave.

RTWSA / Appeals › run the data model

  ▸ Data Model · RTWSA / Appeals
  ✓ issue SCY-8
    │ Step 1 of 6 · running `node scripts/stage.mjs …`
    │ Step 2 of 6 · Data Modeler starting
  ⏸  Waiting for your approval · Salesforce Data Model
     /approve 3f7bc727-…
```

Slash commands run instantly, with no model call and no cost:
`/use` `/projects` `/docs` `/gates` `/approve` `/reject` `/status` `/spend`
`/actions` `/whoami` `/clear` `/help` `/exit`

The session is scriptable, because it reads piped input the same way:

```bash
printf '/use RTWSA Appeals\n/gates\n/exit\n' | scyne
```

### One-shot commands

| Command | Does |
|---|---|
| `scyne project create RTWSA` | New project; you become its owner |
| `scyne feature add "Appeals"` | New feature under it |
| `scyne use RTWSA Appeals` | Pin what later commands act on |
| `scyne doc upload f.docx --as sop` | Store a document (`sop`, `transcripts`, `notes`, `ui`, `template`) |
| `scyne doc list` | Documents for the current target |
| `scyne run datamodel` | Start a stage. Bare `scyne run` lists them |
| `scyne status <issue>` | Activity, gates and work products |
| `scyne gate list` / `approve <id>` | See and clear approvals |
| `scyne logs <runId> --follow` | Stream an agent's transcript |
| `scyne spend --by project` | Cost per project |
| `scyne actions` | Who did what, newest first |
| `scyne installs` | Who installed the plugin, and where |
| `scyne user list` / `create` / `role` / `password` / `disable` | Accounts |
| `scyne member list` / `add` / `remove` | Per-project access |

Add `--json` to most commands for machine-readable output.

---

## Configuration

One `.env` at the repo root. The chatbot reads the same file.

```bash
# ─── Database ────────────────────────────────────────────────────────────
# Unset → PGlite, a local file. Single writer, one machine only.
# Set   → real PostgreSQL. Required for more than one person.
DATABASE_URL=

# ─── Which model runs the agents ─────────────────────────────────────────
# Moves EVERY agent onto one provider. Unset = claude_local (Claude Code).
SCYNE_ADAPTER=
GEMINI_API_KEY=
AZURE_AI_PROJECT_ENDPOINT=
AZURE_AI_TOKEN=            # az account get-access-token --scope https://ai.azure.com/.default
AZURE_AI_API_KEY=          # or this instead of the token
```

A shell export always **wins** over the file:

```bash
DATABASE_URL=postgres://somewhere-else npm run serve
```

`.env.local` is read after `.env`, for per-machine overrides.

### Switching to Gemini

```bash
# .env
SCYNE_ADAPTER=gemini
GEMINI_API_KEY=your-key
```

```bash
npm run serve
```

Every agent moves to Gemini — no `claude` process is started at all. If the key
is missing, boot fails immediately and names what to set.

**Unverified:** proven at configuration level (every agent resolves to `gemini`,
config validates) and against a scripted model, but **no real stage has been run
on Gemini or Azure**. That spends money and needs your credentials. Try a small
feature first.

---

## Where the scripts live

`npm run serve` and friends are in the **root** `package.json`.
`packages/orchestrator/package.json` is the library and only has `test`.

| Script | Runs |
|---|---|
| `npm run dev` | orchestrator + chatbot together |
| `npm run serve` | orchestrator only, on :3100 |
| `npm run orch -- <verb>` | the operator CLI (`seed`, `reset`, `run`, `gate`, `runs`, `log`) |
| `npm run scyne -- <cmd>` | the `scyne` CLI without `npm link` |
| `npm run typecheck` | orchestrator + cli |
| `npm test` | the full suite |
| `npm run link-skills` | symlink `skills/` into `.claude/skills/` — **needed on every fresh clone** |

---

## When something is wrong

| Symptom | Cause | Fix |
|---|---|---|
| `not authenticated — run scyne login` | No token, or revoked | `scyne login` |
| `this installation already has users` | Someone already ran `init` | Ask them for an account, or `reset --all` |
| `cannot reach the Scyne server` | Orchestrator not running | `npm run dev`, or set `SCYNE_API_URL` |
| `The conversation runs on the chatbot server` | Only :3100 is up; chat lives on :4000 | `npm run dev` starts both |
| `no project named 'X'` | Typo, or no membership | The error lists what you can see |
| A CLI verb fails on a database lock | PGlite is single-writer and the server holds it | Stop the server, or use `scyne` / HTTP |
| `Unknown skill: <slug>` | `.claude/skills/` never linked on this clone | `npm run link-skills` |
| `scyne: command not found` | Never linked | `npm link` from the repo root (step 4) |
| Web UI errors right after a reset | The browser still polls a deleted issue from `localStorage` | Click **New session** in the right pane, or hard-refresh |
| `System prompt file not found` | An agent's `bundlePath` points nowhere | `curl -s localhost:3100/agents/<key>/bundle` reports the missing path |

---

## What is not built yet

**The one that will confuse you:** documents uploaded through `scyne` are **not
yet visible to the agents**. Uploads go into the database; agents still read the
`projects/` tree on disk. The bridge between them (materialise / harvest) is
built and tested, but not wired into the engine.

So there are two parallel worlds today — the CLI and new API on one side, the web
chatbot and `npm run stage` on the other. Both work. They do not meet.

Also outstanding:

- Existing `SAPN` / `SAPN_DEMO` work is on disk, not in the database. No importer,
  so `scyne project list` starts empty.
- Admin console tabs (installs, people, spend) — data and endpoints exist, the
  screens do not.
- The web chatbot authenticates against the orchestrator's user table — the same
  accounts the CLI and console use, with the session held in an httpOnly cookie.
  `scyne init` creates the first one, as the installation's superadmin.
- Chats and run logs have database tables, but the runner still writes `.jsonl`
  files.
- Jira publishing still needs the Atlassian MCP, so it works on Claude only.
  Confluence already publishes over REST and is adapter-independent.
- No packaged installer — distribution is a git clone.
- `scyne-chatbot` `npm run build` fails on a **pre-existing** type error
  (`server/orchestrator.ts:10` imports `pipeline.mjs` without the
  `@ts-expect-error` that `index.ts` has). Unrelated to any of the above.
