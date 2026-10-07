#!/usr/bin/env node
// Render a project's companion app — one self-contained HTML page.
//
//   node scripts/render-companion-app.mjs <project> [--no-diagrams]
//
// Kept at this path because the pipeline, the orchestrator workflows, the
// chatbot server and the agent prompts all invoke it by name. The renderer
// itself lives in scripts/companion/ (render.mjs is the entry point).

import { main } from "./companion/render.mjs";
import { die } from "./companion/load.mjs";

main().catch((e) => die(e.stack || String(e)));
