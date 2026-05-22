# Running the whole Scyne system in Docker

One `docker compose` stack brings up everything: Postgres, Paperclip (with the
Claude Code agents), a one-shot provisioner, and the chatbot. First boot
creates the `Scyne` company and all four agents automatically — no manual
Paperclip setup.

## Prerequisites

- Docker + Docker Compose v2.
- The Paperclip repo checked out next to this one at `../paperclip` (its
  Dockerfile is used as the base image). Override with `make base PAPERCLIP_DIR=…`.
- An Anthropic API key (or a host `~/.claude` login — see *Agent auth*).
- A Gemini API key for the chatbot.

## Quick start

```bash
cp .env.example .env        # then edit: set ANTHROPIC_API_KEY + GEMINI_API_KEY
make up                     # builds the paperclip base, builds the stack, starts it
make logs                   # watch provisioning + agent activity
```

Then open:

- **Chatbot** → http://localhost:4000
- **Paperclip UI/API** → http://localhost:3100

After the first `make up`, `docker compose up -d` / `make down` work on their own.

## What first boot does (automatic)

```
db healthy → paperclip (migrates DB, serves :3100 in local_trusted)
           → bootstrap (one-shot): creates company "Scyne", disables hire
             approval, hires PM/BA/UI/UX, wires reportsTo=PM, rewrites PM's
             instructions with the real agent IDs, pushes all bundles, writes
             /workspace/.bootstrap/ids.json
           → chatbot (reads ids.json, serves UI+API on :4000)
```

Because Paperclip generates its own UUIDs, the IDs are discovered at runtime and
handed to the chatbot via `ids.json` — nothing is hard-coded to a previous
install. Re-running is safe: every step looks up existing state by name.

## Agent auth (two options)

- **API key (default):** set `ANTHROPIC_API_KEY` in `.env`. Done.
- **Host Claude subscription (fallback):** leave `ANTHROPIC_API_KEY` empty, set
  `HOST_CLAUDE_DIR=/Users/you/.claude` in `.env`, and uncomment the
  `${HOST_CLAUDE_DIR}:/paperclip/.claude` bind in `docker-compose.yml`. claude-code
  finds it because `HOME=/paperclip`. Mount read-write if you want OAuth token
  refresh to persist (note: the entrypoint may chown it to the container user).

## Atlassian (Jira / Confluence) — one-time OAuth

Only needed for the BA's Phase 2 push. Requirements generation, UI builds, and
a11y audits all work without it. After the stack is up:

```bash
make oauth      # prints a URL; complete it in your browser
```

Tokens persist in the `mcp-auth` volume across restarts.

## Adding feature inputs

The workspace lives in the `workspace` named volume (seeded on first boot from
the repo's `projects/`, `examples/`, `scripts/`, `agent-instructions/`,
`.mcp.json`). Drop new inputs in via the chatbot's upload UI, or copy into the
volume:

```bash
docker compose cp ./projects/SADA/. paperclip:/workspace/projects/SADA/
```

## Verifying

```bash
docker compose ps                                   # db healthy, bootstrap Exited(0), others up
docker compose logs bootstrap                       # company + 4 agents resolved
docker compose exec chatbot cat /workspace/.bootstrap/ids.json
curl -s localhost:3100/api/companies | jq
```

Then in the chatbot: trigger a requirements run (PM → BA → outputs + approval
gate), approve it, then trigger a UI build (UI Engineer scaffolds + previews on
:5174, UX Auditor runs the a11y audit).

## Notes & rough edges

- **Generated-app ports** are published as `5174-5199`. That caps concurrent
  generated apps at 26; widen `GEN_APP_PORT_MIN/MAX` in `.env` and restart to
  raise it. `vite --strictPort` fails the scaffold on a collision.
- **a11y audit Chromium**: the paperclip image bakes distro `chromium` +
  `chromium-driver` and points pa11y/@axe-core at them. If an audit reports a
  Chromium sandbox error, it's the known container-sandbox case (a follow-up
  can pass `--no-sandbox` in `scripts/audit-a11y.mjs`).
- **Full reset**: `make clean` removes all volumes (DB, workspace, MCP tokens).
