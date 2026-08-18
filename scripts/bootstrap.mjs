#!/usr/bin/env node
// Retired. This script hired agents in Paperclip, swapped the placeholder UUIDs
// baked into agent-instructions/pm.json, and wrote .bootstrap/ids.json for the
// chatbot to read. None of that has a meaning any more: the org chart reconciles
// from orchestrator.config.ts on every boot of the orchestrator, agents are
// addressed by key, and there is no company to hire into.
//
// The one job it did that still matters — symlinking ./skills into
// .claude/skills, without which every run fails with `Unknown skill` — lives in
// `npm run link-skills`, which is where it should always have been.
//
// The old implementation is in git history if a Paperclip install is ever
// resurrected: `git log --follow -- scripts/bootstrap.mjs`.

console.log(`\`npm run bootstrap\` is retired — Paperclip is gone.

  Agents:  npm run orch -- seed     reconciles the org from orchestrator.config.ts
  Skills:  npm run link-skills      symlinks ./skills into .claude/skills
  Run it:  npm run dev              orchestrator on :3100, chatbot on :5173
`);
