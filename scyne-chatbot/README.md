# Scyne Requirements Assistant — Chatbot

A Scyne-branded chat UI that takes a conversational requirement-generation request and runs it through Paperclip → PM agent → BA agent → Atlassian.

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
   - `PAPERCLIP_PM_AGENT_ID` — the Project Manager agent ID
3. Run:
   ```
   npm run dev
   ```
4. Open `http://127.0.0.1:5173` in your browser.

## How it works
1. You chat with Claude. It collects the parameters (feature name, process numbers, Jira keys, etc).
2. When all parameters are set, Claude calls the `trigger_requirement_generation` tool — the backend creates a Paperclip issue assigned to the PM agent (status `todo`, which auto-fires it).
3. The chatbot polls Paperclip every 4s for the parent issue + its children, rendering progress and any pending approvals inline.
4. When the BA raises an approval gate, the chatbot shows an inline Approve/Reject card.
5. After approval, the BA pushes to Confluence + Jira via the Atlassian MCP. The chatbot reports the final Jira keys and Confluence URL.

Inputs (transcript, policy doc, UI screen) live at `../inputs/` (the requirement-generator project root). The BA agent reads from there directly.
