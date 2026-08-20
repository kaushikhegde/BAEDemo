/**
 * Shared Atlassian credentials for the publishing scripts.
 *
 * The Atlassian MCP's OAuth grant cannot do two things these scripts need:
 * attachments (no scope at all) and posting a large page body without routing
 * every byte through a model's context. Both go through the API token instead,
 * with Basic auth against the SITE domain — a 3LO bearer is only valid against
 * api.atlassian.com, which is the second, independent way hand-rolled curls
 * have failed here.
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Resolved from THIS FILE, not from process.cwd(): these scripts are run from
// wherever the caller happens to be — an agent that has cd'd into a temporary
// diagram directory, most obviously — and a credentials lookup that depends on
// the working directory fails there with a message about a path nobody chose.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

/** Env vars win; otherwise read scyne-chatbot/.env (the only place these live). */
export async function loadCredentials() {
  let site = process.env.ATLASSIAN_SITE_URL;
  let email = process.env.ATLASSIAN_EMAIL;
  let token = process.env.ATLASSIAN_API_TOKEN;

  if (!site || !email || !token) {
    const envPath = path.join(REPO_ROOT, "scyne-chatbot", ".env");
    let raw = "";
    try {
      raw = await fs.readFile(envPath, "utf8");
    } catch {
      fail(
        `No Atlassian API token available.\n` +
          `  Looked for ATLASSIAN_SITE_URL / ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN in the\n` +
          `  environment and in ${envPath}.\n` +
          `  The Atlassian MCP token CANNOT be used here. Set an API token from\n` +
          `  id.atlassian.com/manage-profile/security/api-tokens.`
      );
    }
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const val = m[2].replace(/^["']|["']$/g, "");
      if (m[1] === "ATLASSIAN_SITE_URL" && !site) site = val;
      if (m[1] === "ATLASSIAN_EMAIL" && !email) email = val;
      if (m[1] === "ATLASSIAN_API_TOKEN" && !token) token = val;
    }
  }

  const missing = [
    !site && "ATLASSIAN_SITE_URL",
    !email && "ATLASSIAN_EMAIL",
    !token && "ATLASSIAN_API_TOKEN",
  ].filter(Boolean);
  if (missing.length) fail(`Missing credential(s): ${missing.join(", ")}`);

  return {
    // A trailing slash breaks every concatenated path built from this.
    site: site.replace(/\/+$/, ""),
    auth: "Basic " + Buffer.from(`${email}:${token}`).toString("base64"),
  };
}
