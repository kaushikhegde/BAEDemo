# Scyne stack — one-command Docker workflow.
#
# `make up` builds the Paperclip base image (it can't be built FROM another
# image inside compose), then builds + starts the whole stack. After the first
# build, `docker compose up -d` works on its own too.

PAPERCLIP_DIR   ?= ../paperclip
BASE_IMAGE      ?= scyne/paperclip-base:local
BASE_TARBALL    ?= paperclip-base.tar.gz
# Architecture the CLIENT will run on. Ubuntu/Intel/AMD servers are linux/amd64;
# an ARM box (e.g. Graviton, Raspberry Pi, Apple-silicon Linux) is linux/arm64.
# `make handoff` cross-builds the base image for this platform so it runs
# natively on the client regardless of YOUR machine's CPU.
TARGET_PLATFORM ?= linux/amd64

.PHONY: up build base down stop clean logs ps oauth handoff client client-hosted client-hosted-down

up: build
	docker compose up -d
	@echo ""
	@echo "Stack starting. Chatbot: http://localhost:4000   Paperclip: http://localhost:3100"
	@echo "Watch provisioning:  make logs"

build: base
	docker compose build

base:
	docker build -t $(BASE_IMAGE) $(PAPERCLIP_DIR)

# === Handoff workflow (no Paperclip source needed on the client) ===========
#
# On YOUR machine (has the Paperclip source at ../paperclip):
#   make handoff      -> builds the base image, saves it to paperclip-base.tar.gz
# Hand the client this repo + paperclip-base.tar.gz, then they run ONE command:
#   make client       -> loads the base image (once) and starts the whole stack
#
# `make client` never touches ../paperclip, so the client needs neither the
# Paperclip source nor a registry login.

# Build + export the base image as a portable tarball for the client.
# Cross-builds for TARGET_PLATFORM (default linux/amd64) so the image runs
# natively on the client even when YOUR machine is a different architecture.
handoff:
	docker buildx build --platform $(TARGET_PLATFORM) -t $(BASE_IMAGE) --load $(PAPERCLIP_DIR)
	docker save $(BASE_IMAGE) | gzip > $(BASE_TARBALL)
	@echo ""
	@echo "Wrote $(BASE_TARBALL) ($(TARGET_PLATFORM)). Send it to the client alongside this repo."

# Client one-shot: ensure the base image is present (load from the tarball if
# Docker doesn't already have it), then build + start the stack.
client:
	@if ! docker image inspect $(BASE_IMAGE) >/dev/null 2>&1; then \
	  if [ -f "$(BASE_TARBALL)" ]; then \
	    echo "Loading base image from $(BASE_TARBALL)..."; \
	    docker load < $(BASE_TARBALL); \
	  else \
	    echo "ERROR: base image '$(BASE_IMAGE)' not found and '$(BASE_TARBALL)' is missing."; \
	    echo "Ask for paperclip-base.tar.gz and place it in this folder, then re-run 'make client'."; \
	    exit 1; \
	  fi; \
	else \
	  echo "Base image $(BASE_IMAGE) already present — skipping load."; \
	fi
	docker compose up --build --detach
	@echo ""
	@echo "Stack starting. Chatbot: http://localhost:4000   Paperclip: http://localhost:3100"
	@echo "Watch provisioning:  make logs"

# === Host-Paperclip mode ====================================================
#
# For a client running Paperclip NATIVELY on the host. Only the chatbot +
# bootstrap run in Docker, pointed at the host Paperclip (127.0.0.1:3100).
# No base image or tarball needed. The host Paperclip must be running first,
# and its WORKSPACE_PATH must equal WORKSPACE_HOST_PATH (set in .env).
client-hosted:
	docker compose -f docker-compose.client.yml up --build --detach
	@echo ""
	@echo "Chatbot: http://localhost:4000  (talking to host Paperclip at 127.0.0.1:3100)"
	@echo "Watch:   docker compose -f docker-compose.client.yml logs -f"

client-hosted-down:
	docker compose -f docker-compose.client.yml down

down:
	docker compose down

stop:
	docker compose stop

# Removes volumes too — wipes the DB, workspace, MCP tokens. Full reset.
clean:
	docker compose down -v

logs:
	docker compose logs -f

ps:
	docker compose ps

# One-time Atlassian MCP OAuth login (tokens persist in the mcp-auth volume).
# Complete the printed URL in your browser. Only needed for the BA's
# Confluence/Jira push.
oauth:
	docker compose exec paperclip npx -y mcp-remote https://mcp.atlassian.com/v1/mcp/authv2
