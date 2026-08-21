// The ONE .env, loaded from the workspace root.
//
// This used to be `import "dotenv/config"` at the top of index.ts, which
// resolves against `process.cwd()` — and `npm run chatbot` does
// `cd scyne-chatbot`, so the server read `scyne-chatbot/.env` and NEVER the
// root one. Two files, two copies of ADO_ORG / GEMINI_API_KEY / WORKSPACE_PATH
// that drifted, and one measurable bug: `adoVerify.ts` needs
// `ADO_PAT || MCP_TOKEN_FOR_AZURE`, the PAT only ever lived in the ROOT .env
// (it is what `.mcp.json` expands), so every approval-time ADO check reported
// "token present: false" while the same token published fine from the agents.
//
// Root-relative and cwd-independent, so it does not matter whether the server
// was started from the repo root, from scyne-chatbot/, or by vitest.
//
// `process.loadEnvFile` is built into Node — same call orchestrator.config.ts
// makes, so both processes load the same file the same way. It does NOT
// overwrite a variable that is already set, so a real environment variable
// (Docker's `environment:` block, `PORT=4001 npm run dev`) still wins.
//
// MUST be the first import of any module that reads process.env at load time:
// ESM evaluates imports in order, so `import "./env.js"` on line 1 of index.ts
// runs before llm.ts, store.ts or workspace.ts read anything.
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Markers that identify the workspace root — both are checked into the repo.
const MARKERS = ["agent-instructions", "skills"];

function findRepoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    if (MARKERS.every((m) => fs.existsSync(path.join(dir, m)))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // server/ lives at <workspace>/scyne-chatbot/server
  return path.resolve(from, "..", "..");
}

/**
 * Where the install lives — the directory holding `.env`, `projects/`,
 * `skills/` and `agent-instructions/`.
 *
 * Exported so workspace.ts uses this same answer rather than walking up a
 * second time: the env file and the workspace root are the same directory by
 * definition, and two independent searches for it can only ever disagree.
 */
export const INSTALL_ROOT = findRepoRoot(here);

// `.env.local` second, for per-machine overrides. Neither is required — a
// deployment configured purely through real environment variables has neither.
for (const file of [".env", ".env.local"]) {
  const p = path.join(INSTALL_ROOT, file);
  if (fs.existsSync(p)) process.loadEnvFile(p);
}
