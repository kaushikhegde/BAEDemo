# Scyne stack — one-command Docker workflow.
#
# `make up` builds the Paperclip base image (it can't be built FROM another
# image inside compose), then builds + starts the whole stack. After the first
# build, `docker compose up -d` works on its own too.

PAPERCLIP_DIR ?= ../paperclip
BASE_IMAGE    ?= scyne/paperclip-base:local

.PHONY: up build base down stop clean logs ps oauth

up: build
	docker compose up -d
	@echo ""
	@echo "Stack starting. Chatbot: http://localhost:4000   Paperclip: http://localhost:3100"
	@echo "Watch provisioning:  make logs"

build: base
	docker compose build

base:
	docker build -t $(BASE_IMAGE) $(PAPERCLIP_DIR)

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
