import path from "node:path";
import fs from "node:fs";
// FIRST, and for its side effect: this loads the workspace-root .env before
// anything below reads process.env.WORKSPACE_PATH. It also owns finding that
// root, so the env file and the workspace can never resolve to two different
// directories.
import { INSTALL_ROOT } from "./env.js";

// Single source of truth for the workspace root (the requirement-generator repo
// that holds projects/, outputs/, generated-apps/, .orchestrator/).
//
// NEVER hardcode an absolute path here. This code runs on client machines whose
// home directory is not the developer's — a baked-in /Users/<dev>/... fallback
// makes every write (mkdir projects/<p>/<f>/..., upload, outputs wipe) fail with
// EACCES at the filesystem root.
//
// Resolution order:
//   1. WORKSPACE_PATH env var (Docker sets /workspace; may also be relative).
//   2. INSTALL_ROOT — derived from this module's own location by env.ts.

function isUsable(dir: string): boolean {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const derived = INSTALL_ROOT;
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
        `ignoring it and using ${derived}. Fix or remove WORKSPACE_PATH in the workspace root .env.`,
    );
  }
}

/** Absolute path to the workspace root. Always resolved, never relative. */
export const WORKSPACE_PATH = resolved;

console.log(`[workspace] root = ${WORKSPACE_PATH} (${source})`);
