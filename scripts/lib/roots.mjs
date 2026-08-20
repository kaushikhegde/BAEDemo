// The two roots, for the scripts. Mirrors packages/orchestrator/src/core/roots.ts.
//
// Every script under scripts/ used to open with its own copy of
//
//   const WORKSPACE = process.env.WORKSPACE_PATH
//     || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
//
// which conflated two different questions, and two scripts then went on to
// answer the wrong one: `convert-to-md.mjs` and `ado-publish.mjs` both
// resolve a node dependency through
// `createRequire(<root>/scyne-chatbot/package.json)`, and that lookup has to
// land on the INSTALL, not on whatever project tree the run is operating in.
// Hand them a materialised temp directory and they throw.
//
//   INSTALL_ROOT   where this code lives: scripts/, skills/,
//                  agent-instructions/, examples/, datamodel-reference/,
//                  scyne-chatbot/. Ships together; read-only during a run.
//
//   WORK_ROOT      the project tree being operated on: projects/,
//                  generated-apps/. Written to, then harvested.
//
// WORK_ROOT falls back to INSTALL_ROOT, which is exactly the historical
// behaviour for a checkout that holds both — so running any of these scripts
// by hand, with no environment set, works precisely as it always has.

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// From THIS FILE, never from process.cwd(). These scripts are invoked from
// wherever the caller happens to be — the orchestrator runs some of them with
// cwd set deliberately, and an agent may have cd'd into a temporary diagram
// directory — so a cwd-derived install path fails somewhere nobody chose.
// scripts/lib/roots.mjs → scripts/ → the install root.
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const INSTALL_ROOT = process.env.SCYNE_INSTALL_ROOT
  ? path.resolve(process.env.SCYNE_INSTALL_ROOT)
  : path.resolve(HERE, "..", "..");

export const WORK_ROOT = process.env.SCYNE_WORK_ROOT
  ? path.resolve(process.env.SCYNE_WORK_ROOT)
  // Kept ahead of the fallback because every existing invocation, the chatbot
  // and the Docker compose files all set WORKSPACE_PATH and nothing else.
  : process.env.WORKSPACE_PATH
    ? path.resolve(process.env.WORKSPACE_PATH)
    : INSTALL_ROOT;

/** Resolve a path inside the install — a skill, a script, a reference catalogue. */
export const inInstall = (...parts) => path.join(INSTALL_ROOT, ...parts);

/** Resolve a path inside the project tree — projects/…, generated-apps/…. */
export const inWork = (...parts) => path.join(WORK_ROOT, ...parts);
