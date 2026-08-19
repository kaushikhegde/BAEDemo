#!/usr/bin/env node
// Agent instruction bundles are `{path, content}` JSON with the whole AGENTS.md
// crammed into one string, which is unreadable to edit and easy to corrupt.
//
//   node scripts/sync-bundles.mjs export <dir>   JSON → one .md per agent
//   node scripts/sync-bundles.mjs import <dir>   .md  → back into the JSON
//
// The JSON stays the source of truth in git; this is a round-trip editing aid.
// Import preserves every key except `content`.

import fs from "node:fs/promises";
import path from "node:path";
import { INSTALL_ROOT } from "./lib/roots.mjs";

// INSTALL_ROOT: this reads agent-instructions/, which ships with the code —
// it is never a per-project path, which is why it never consulted
// WORKSPACE_PATH even before the two roots were told apart.
const WORKSPACE = INSTALL_ROOT;
const BUNDLES = path.join(WORKSPACE, "agent-instructions");

const [mode, dir] = process.argv.slice(2);
if (!["export", "import"].includes(mode) || !dir) {
  console.error("usage: node scripts/sync-bundles.mjs export|import <dir>");
  process.exit(1);
}

const names = (await fs.readdir(BUNDLES)).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
await fs.mkdir(dir, { recursive: true });

for (const name of names) {
  const jsonPath = path.join(BUNDLES, `${name}.json`);
  const mdPath = path.join(dir, `${name}.md`);
  const bundle = JSON.parse(await fs.readFile(jsonPath, "utf8"));

  if (mode === "export") {
    await fs.writeFile(mdPath, bundle.content, "utf8");
    console.log(`export  ${name}`);
  } else {
    const content = await fs.readFile(mdPath, "utf8").catch(() => null);
    if (content === null) { console.log(`skip    ${name}  (no ${name}.md)`); continue; }
    if (content === bundle.content) { console.log(`same    ${name}`); continue; }
    await fs.writeFile(jsonPath, `${JSON.stringify({ ...bundle, content }, null, 2)}\n`, "utf8");
    console.log(`import  ${name}  (${bundle.content.length} → ${content.length} chars)`);
  }
}
