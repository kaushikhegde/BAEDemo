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

## Client handoff (no Paperclip source needed)

The stack is built `FROM` a locally-built Paperclip base image (`scyne/paperclip-base:local`).
A client who only has *this* repo doesn't have the Paperclip source at `../paperclip`,
so `make up` / `docker compose up --build` fail at the base image
(`scyne/paperclip-base:local: manifest unknown`). Hand them a prebuilt base instead.

**On your machine** (you have `../paperclip`):

```bash
make handoff                 # cross-builds the base + writes paperclip-base.tar.gz
```

Give the client this repo **plus** `paperclip-base.tar.gz`.

**On the client's machine** (one command):

```bash
make client                  # loads the base image (once) then builds + starts the stack
```

`make client` never touches `../paperclip` and needs no registry. It's idempotent —
if the base image is already loaded it skips straight to `docker compose up`.

### Ubuntu / Linux clients

- **Install prerequisites first** (fresh Ubuntu has neither Docker nor `make`):

  ```bash
  sudo apt update
  sudo apt install -y docker.io docker-compose-plugin make
  sudo usermod -aG docker $USER   # then log out/in so `docker` runs without sudo
  ```

- **Architecture must match.** `make handoff` cross-builds for `linux/amd64` by
  default — correct for almost all Intel/AMD Ubuntu servers and desktops. If the
  client runs **ARM** (AWS Graviton, Ampere, Raspberry Pi), build for it instead:

  ```bash
  make handoff TARGET_PLATFORM=linux/arm64
  ```

  Check the client's arch with `uname -m` on their box: `x86_64` → `linux/amd64`,
  `aarch64` → `linux/arm64`. A mismatch surfaces as `exec format error` at runtime.

- Don't commit `paperclip-base.tar.gz` to git — it's hundreds of MB.

## Host-Paperclip mode (client installs Paperclip natively)

Use this when the client **won't** run Paperclip in Docker — they install and run
it themselves on the host, and only want the chatbot + first-boot provisioning in
a container, talking to the host Paperclip. **No base image and no tarball are
needed** in this mode — `bootstrap` runs on a stock `node` image and the chatbot
image is self-contained.

Compose file: [`docker-compose.client.yml`](docker-compose.client.yml). It runs
only two services — a one-shot `bootstrap` and the `chatbot` — both with
`network_mode: host`.

> **Why host networking?** The containers reach the host Paperclip at
> `127.0.0.1:3100`, and their requests arrive from **loopback**, so Paperclip's
> `local_trusted` mode still treats them as the no-auth `local-board` admin.
> `host.docker.internal` would arrive from the Docker bridge IP and would **not**
> get admin — so host networking is required. (Linux-only; fine for an Ubuntu
> client.)

### Client prerequisites

1. **Paperclip running natively** on the host at `127.0.0.1:3100` in
   `local_trusted` / `private` mode (the standard `pnpm dev`), with the
   `requirement-generator` skill installed under its `skills/` directory.
2. **A shared workspace directory.** Whatever the host Paperclip uses as
   `WORKSPACE_PATH` must match `WORKSPACE_HOST_PATH` in `.env` — the chatbot
   bind-mounts it to read the agents' `outputs/` and the bootstrap-written
   `.bootstrap/ids.json`. Pointing both at this repo's root is the simplest
   choice (it already has `projects/`, `scripts/`, `examples/`, `.mcp.json`).
3. Docker + Compose v2 + `make` (see the Ubuntu prerequisites above).

### Setup

```bash
cp .env.example .env
# edit .env:
#   GEMINI_API_KEY=...                                  (chatbot)
#   ANTHROPIC_API_KEY=...  or  CLAUDE_CODE_OAUTH_TOKEN=... (agents — set on the
#                                                          HOST Paperclip too)
#   WORKSPACE_HOST_PATH=/absolute/path/to/this/repo     (== host Paperclip WORKSPACE_PATH)
#   PAPERCLIP_API_URL=http://127.0.0.1:3100/api         (default; usually fine)

# 1. Start the host Paperclip first (in the paperclip clone): pnpm dev
# 2. Then bring up the chatbot + provisioning:
make client-hosted
```

Open the chatbot at **http://localhost:4000**. `bootstrap` creates the Scyne
company + 4 agents in the host Paperclip and writes `ids.json`; the chatbot reads
those IDs and is ready. Re-running `make client-hosted` is safe (idempotent).

Tear down (leaves the host Paperclip untouched):

```bash
make client-hosted-down
```

> In this mode the **agents run on the host** (Paperclip spawns their Claude Code
> subprocesses there), so Node, npm, and Chromium for the UX Auditor must be on
> the host — not in any container. The Docker side is just the chatbot UI.

## What first boot does (automatic)

```
db healthy → paperclip (migrates DB, serves :3100 in local_trusted)
           → bootstrap (one-shot): creates company "Scyne", disables hire
             approval, provisions the 19-agent Scyne org, rewrites the Delivery
             Lead's instructions with the real agent IDs, pushes all bundles, writes
             /workspace/.bootstrap/ids.json
           → chatbot (reads ids.json, serves UI+API on :4000)
```

Because Paperclip generates its own UUIDs, the IDs are discovered at runtime and
handed to the chatbot via `ids.json` — nothing is hard-coded to a previous
install. Re-running is safe: every step looks up existing state by name.

## Agent auth (set exactly one)

- **API key:** set `ANTHROPIC_API_KEY` in `.env`. Done.
- **Claude subscription (no API key):** on the host run `claude setup-token`,
  paste the long-lived token into `CLAUDE_CODE_OAUTH_TOKEN` in `.env`, and leave
  `ANTHROPIC_API_KEY` empty. The `claude_local` adapter passes the token through
  to each agent subprocess.

> Mounting `~/.claude` is **not** a working fallback on macOS: Claude Code stores
> its login in the macOS Keychain, not in `~/.claude`, so a Linux container can't
> read it. Use the OAuth token (or an API key) instead.

If neither is set, agents fail with `Invalid API key` — that's the symptom of no
usable credential.

## Atlassian (Jira / Confluence) — one-time OAuth

Only needed for the BA's Phase 2 push. Requirements generation, UI builds, and
a11y audits all work without it. After the stack is up:

```bash
make oauth          # all-in-Docker stack: execs into the paperclip container
make oauth-hosted   # host-Paperclip mode: runs mcp-remote directly on the host
```

Use `make oauth` for the full Docker stack (`make up`) — it execs into the
`paperclip` container, and tokens persist in the `mcp-auth` volume.

In **host-Paperclip mode** (`make client-hosted`) there is no `paperclip`
container, so use `make oauth-hosted` instead — it runs `mcp-remote` on the host
and caches tokens in `~/.mcp-auth/`, which the host Paperclip's BA agent shares.
(Needs Node/npx on the host, already present from the Paperclip install.)

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

Then in the chatbot: trigger a requirements run (Delivery Lead → BA → outputs + approval
gate), approve it, then trigger a UI build (Developer scaffolds + previews on
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
