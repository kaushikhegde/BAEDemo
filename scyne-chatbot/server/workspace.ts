import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Single source of truth for the workspace root (the requirement-generator repo
// that holds projects/, outputs/, generated-apps/, .bootstrap/ids.json).
//
// NEVER hardcode an absolute path here. This code runs on client machines whose
// home directory is not the developer's — a baked-in /Users/<dev>/... fallback
// makes every write (mkdir projects/<p>/<f>/..., upload, outputs wipe) fail with
// EACCES at the filesystem root.
//
// Resolution order:
//   1. WORKSPACE_PATH env var (Docker sets /workspace; may also be relative).
//   2. Derived from this module's own location by walking up for the repo root.
//   3. The repo root two levels up (scyne-chatbot/server → scyne-chatbot → repo).

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

function isUsable(dir: string): boolean {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const derived = findRepoRoot(here);
const configured = (process.env.WORKSPACE_PATH || "").trim();
const configuredAbs = configured ? path.resolve(derived, configured) : "";

// A configured path that doesn't exist / isn't writable on THIS machine is
// almost always a .env copied from another developer's box. Fall back to the
// derived root rather than failing every write with EACCES.
let source = "derived from install location";
let resolved = derived;
if (configuredAbs) {
  if (isUsable(configuredAbs)) {
    resolved = configuredAbs;
    source = "from WORKSPACE_PATH";
  } else {
    console.warn(
      `[workspace] WORKSPACE_PATH=${configuredAbs} is missing or not writable on this machine — ` +
        `ignoring it and using ${derived}. Fix or remove WORKSPACE_PATH in scyne-chatbot/.env.`,
    );
  }
}

/** Absolute path to the workspace root. Always resolved, never relative. */
export const WORKSPACE_PATH = resolved;

console.log(`[workspace] root = ${WORKSPACE_PATH} (${source})`);
