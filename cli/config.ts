// Where the CLI keeps what it knows between invocations: which server, which
// credential, which project.
//
// `~/.scyne/config.json`, not a dotfile in the working directory. The plugin
// is installed once and pointed at projects that live on a server, so its
// configuration belongs to the user, not to whatever directory they happen to
// be standing in.
//
// The file holds a bearer token, so it is written 0600 and created inside a
// 0700 directory. A token that is world-readable on a shared machine is the
// same as no authentication at all.

import { chmodSync, mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface CliConfig {
  apiUrl: string;
  token?: string;
  /**
   * The organisation `scyne org use` pinned, by slug.
   *
   * Only a superadmin may act as another organisation — the server refuses the
   * header from anyone else rather than ignoring it, so a stale pin fails
   * loudly instead of silently doing nothing.
   */
  org?: string;
  /** The project `scyne use` pinned, by name. */
  project?: string;
  feature?: string;
  /** Stable per machine, so the server can recognise this installation again. */
  machineId?: string;
}

export const DEFAULT_API_URL = "http://127.0.0.1:3100";

export function configHome(): string {
  return process.env.SCYNE_HOME || join(homedir(), ".scyne");
}

export function configPath(): string {
  return join(configHome(), "config.json");
}

export function load(): CliConfig {
  const path = configPath();
  if (!existsSync(path)) {
    return { apiUrl: process.env.SCYNE_API_URL || DEFAULT_API_URL };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CliConfig;
    // The environment wins over the file: a shell that has deliberately
    // pointed at another server should not be silently overridden by whatever
    // was last written here.
    return { ...parsed, apiUrl: process.env.SCYNE_API_URL || parsed.apiUrl || DEFAULT_API_URL };
  } catch {
    throw new Error(`${path} is not valid JSON. Delete it and run \`scyne login\` again.`);
  }
}

export function save(config: CliConfig): void {
  const dir = configHome();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Temp file plus rename, so an interrupted write cannot leave a config that
  // parses as half a file — the same discipline the console uses for bundles.
  const tmp = configPath() + ".tmp";
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, configPath());
  try { chmodSync(configPath(), 0o600); chmodSync(dir, 0o700); } catch { /* best effort on odd filesystems */ }
}

export function patch(changes: Partial<CliConfig>): CliConfig {
  const next = { ...load(), ...changes };
  save(next);
  return next;
}

/**
 * A stable identifier for this machine, so re-registering the plugin updates
 * one installation row rather than accumulating one per run. Derived by
 * hashing the hostname and home directory — no hardware identifier is read,
 * and the value is not reversible into either.
 */
export function machineId(): string {
  const existing = load().machineId;
  if (existing) return existing;
  const id = createHash("sha256").update(`${hostname()}|${homedir()}|${platform()}`).digest("hex").slice(0, 32);
  patch({ machineId: id });
  return id;
}
