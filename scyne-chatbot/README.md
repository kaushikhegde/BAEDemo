# Scyne Requirements Assistant — Chatbot

A Scyne-branded chat UI that takes a conversational requirement-generation request and runs it through Paperclip → Delivery Lead agent → BA agent → Atlassian.

## Stack
- Frontend: React + Vite + Tailwind, served on `http://127.0.0.1:5173`
- Backend: Node + Express + Anthropic SDK + Paperclip API client, served on `http://127.0.0.1:4000`

## Setup
1. Install deps:
   ```
   npm install
   ```
2. Set environment variables in `.env` (copied from `.env.example`):
   - `ANTHROPIC_API_KEY` — your Claude API key
   - `PAPERCLIP_API_URL` — default `http://127.0.0.1:3100/api`
   - `PAPERCLIP_COMPANY_ID` — the Scyne company ID
   - `PAPERCLIP_DELIVERY_LEAD_AGENT_ID` — the Delivery Lead agent ID
3. Run:
   ```
   npm run dev
   ```
4. Open `http://127.0.0.1:5173` in your browser.

## How it works
1. You chat with Claude. It collects the parameters (feature name, process numbers, Jira keys, etc).
2. When all parameters are set, Claude calls the `trigger_requirement_generation` tool — the backend creates a Paperclip issue assigned to the Delivery Lead agent (status `todo`, which auto-fires it).
3. The chatbot polls Paperclip every 4s for the parent issue + its children, rendering progress and any pending approvals inline.
4. When the BA raises an approval gate, the chatbot shows an inline Approve/Reject card.
5. After approval, the BA pushes to Confluence + Jira via the Atlassian MCP. The chatbot reports the final Jira keys and Confluence URL.

Inputs (transcript, policy doc, UI screen) live at `../inputs/` (the requirement-generator project root). The BA agent reads from there directly.

## Atlassian auto-provisioning (creating projects/spaces)

At the approval step the chatbot will create the Jira project + Confluence space if they don't exist yet — the Atlassian MCP can create *pages* and *issues* but **not** the project/space containers, so this fills the gap via the Atlassian REST API.

### Default: reuse the MCP login (no setup)

Out of the box, provisioning piggybacks on the OAuth login the client already does for the MCP (`npx mcp-remote https://mcp.atlassian.com/v1/mcp/authv2`, cached in `~/.mcp-auth/`). Nothing extra to configure — if that login has create permission, the project/space are created automatically; otherwise the chatbot will tell you exactly what's missing and ask you to either create it once in Atlassian or set an API token (below).

### When to set an API token

Use an API token when the MCP login lacks permission to create projects or spaces (you'll see a "login lacks … permission" message at approve), or when you want a deterministic, always-works setup. The API token takes priority over the MCP login.

#### Steps to create the token

1. Go to **<https://id.atlassian.com/manage-profile/security/api-tokens>**.
2. Sign in with the Atlassian account that has **admin rights** on your site (Jira *Create projects* + Confluence *Create space* permissions — usually a site admin).
3. Click **Create API token** (the plain one, *not* "Create API token with scopes" — the scoped variant uses a different auth flow that the provisioning code doesn't use).
4. Label it (e.g. `scyne-provisioning`), pick an expiry, click **Create**.
5. **Copy the token now** — it's only shown once.

#### Add to `.env` and restart

```env
ATLASSIAN_SITE_URL=https://your-team.atlassian.net
ATLASSIAN_EMAIL=<email of the account from step 2>
ATLASSIAN_API_TOKEN=<the token>
```

`.env` is not hot-reloaded, so restart:
```bash
npm run dev
```

#### Optional overrides (Jira project template/type)

Defaults suit a team-managed Kanban site. If your plan rejects them, override:
```env
ATLASSIAN_JIRA_PROJECT_TYPE=software
ATLASSIAN_JIRA_TEMPLATE_KEY=com.pyxis.greenhopper.jira:gh-simplified-kanban
```

### How approval-time provisioning behaves

- **Target exists** → no-op, approval proceeds.
- **Target missing + create succeeds** → created, approval proceeds, the BA pushes into it.
- **Target missing + create rejected (e.g. permission)** → approval is **held** and the chat shows the exact error (e.g. "create it once in Jira, or set `ATLASSIAN_API_TOKEN`").
- **Auth unavailable / lookup ambiguous** → soft-skip, approval proceeds, and the BA's verify-and-block at Phase 2 is the safety net (so a stale token never blocks an approval where the target already exists).

### Permissions checklist for the token's account
- **Jira:** *Create projects* global permission (or site-admin).
- **Confluence:** *Create Space* global permission (or Confluence-admin).
- The token inherits the account's permissions — give it an admin account for the most reliable result.
