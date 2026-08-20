// The Codex CLI runner: spawns `codex exec --json`, writes the prompt on
// stdin, and reads token usage out of the JSONL it emits.
//
// Beside createClaudeRunner rather than behind createLoopRunner, deliberately.
// The loop runner exists to supply the agency a bare chat API lacks — it does
// the reading, writing and skill-loading itself. Codex is a whole agent and
// already does all of that, so wrapping it would be re-implementing the binary.
//
// Every flag below was verified against `codex exec --help` on
// @openai/codex@0.148.0. Two differences from Claude Code shape this file:
// there is no --system-prompt-file (so the bundle and SKILL.md are prepended
// to the prompt), and MCP servers are per-invocation config overrides rather
// than a file path.

import { readFile } from "node:fs/promises";
import type { RunRequest, RunResult, Runner } from "./runner.js";
import { runChild, STDERR_TAIL_CHARS } from "./spawn.js";
import { buildSystemPrompt, loadSkill } from "./prompt.js";
import { extractCodexUsage } from "./usage.js";

export interface McpServer { command: string; args?: string[]; env?: Record<string, string> }

/**
 * Codex parses a `-c key=value` value as TOML, falling back to a raw string
 * when it fails to parse. This only ever has to encode three shapes for this
 * file's call sites — a string, an array of strings, and a flat
 * string-to-string map — so it is a small dispatcher, not a general TOML
 * serialiser, and should not grow into one.
 *
 * `JSON.stringify` is correct for the first two: TOML and JSON agree on
 * quoted-string and bracketed-array syntax, so `"npx"` and
 * `["-y","@azure-devops/mcp","scyne"]` are valid TOML as well as valid JSON.
 * It is NOT correct for the third. TOML's inline-table syntax is
 * `{ key = "value" }` — braces, but `=` rather than `:` — so
 * `JSON.stringify({ADO_PAT:"x"})` produces `{"ADO_PAT":"x"}`, which is JSON
 * object syntax and fails to parse as TOML. A value that fails to parse falls
 * back to being used as a raw string, so an `env` map encoded this way
 * silently loses every credential in it rather than erroring loudly. The
 * VALUES inside the table are still run through JSON.stringify so their
 * quoting and escaping stay correct — only the `key:value` separator and the
 * surrounding punctuation need to change.
 */
const toml = (v: string | string[] | Record<string, string>): string => {
  if (typeof v === "string" || Array.isArray(v)) return JSON.stringify(v);
  const entries = Object.entries(v).map(([k, val]) => `${k} = ${JSON.stringify(val)}`);
  return `{ ${entries.join(", ")} }`;
};

export function buildCodexArgs(req: RunRequest, mcpServers: Record<string, McpServer>): string[] {
  const a = [
    "exec",
    "--json",              // JSONL events on stdout — the transcript's raw material
    "--ephemeral",         // no session files; the orchestrator owns run history
    "--skip-git-repo-check",
    "--ignore-user-config", // a developer's ~/.codex/config.toml must never leak into a run
    "--sandbox", "workspace-write",
    "--cd", req.cwd,
  ];

  if (req.model) a.push("--model", req.model);

  // Codex has no --effort. Its equivalent is a config key, so an explicit pin
  // on a step or an agent still reaches the model.
  if (req.effort) a.push("-c", `model_reasoning_effort=${toml(req.effort)}`);

  // MCP is configuration here rather than a file path. The SAME .mcp.json the
  // Claude runner is handed is expanded into overrides, so there is one source
  // of truth for what servers exist and two argument shapes for it.
  if (req.agent.mcpEnabled) {
    for (const [name, s] of Object.entries(mcpServers)) {
      a.push("-c", `mcp_servers.${name}.command=${toml(s.command)}`);
      if (s.args?.length) a.push("-c", `mcp_servers.${name}.args=${toml(s.args)}`);
      if (s.env && Object.keys(s.env).length) a.push("-c", `mcp_servers.${name}.env=${toml(s.env)}`);
    }
  }

  // Last, so an operator's extraArgs can override anything above.
  if (req.agent.extraArgs?.length) a.push(...req.agent.extraArgs);
  return a;
}

/**
 * Expand `${VAR}` and `${VAR:-default}` against `process.env`.
 *
 * Claude Code does this itself when it reads `.mcp.json`. This path does NOT
 * go through Claude Code: it parses the same file and re-encodes each value as
 * a `codex -c` TOML override, so without expansion a Codex run hands the MCP
 * server the literal string `${MCP_TOKEN_FOR_AZURE}` — and every call fails
 * with a 401 for a credential that looks perfectly present in the config file.
 *
 * That matters because the alternative is putting the secret in `.mcp.json`,
 * which is committed. A PAT in that file is a PAT in the git history.
 *
 * A variable that resolves to nothing THROWS, naming it. Substituting an empty
 * string would hand the server a blank credential and produce a 401 that reads
 * like a permissions problem — an afternoon of debugging instead of a
 * thirty-second fix.
 */
function expandEnv(value: string, where: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, fallback?: string) => {
    const resolved = process.env[name];
    if (resolved !== undefined && resolved !== "") return resolved;
    if (fallback !== undefined) return fallback;
    throw new Error(
      `${where} references \${${name}}, which is not set.\n` +
      `  Set it in the workspace root .env (which the config file loads), or give it a\n` +
      `  default with \${${name}:-something}.`);
  });
}

/**
 * Read the `mcpServers` map out of the `.mcp.json` the engine points at,
 * expanding `${VAR}` references as it goes.
 */
export async function readMcpServers(path: string | undefined): Promise<Record<string, McpServer>> {
  if (!path) return {};
  let parsed: { mcpServers?: Record<string, McpServer> };
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as { mcpServers?: Record<string, McpServer> };
  } catch {
    // A missing or malformed .mcp.json is not fatal: an agent with mcpEnabled
    // and no servers simply has no tools beyond its own. The Claude runner
    // behaves the same way — it passes the path and lets the CLI decide.
    return {};
  }

  // An UNSET variable, on the other hand, IS fatal and is deliberately not
  // caught here: it means a server was configured and its credential is
  // missing, which fails loudly now rather than as a 401 twenty minutes in.
  const out: Record<string, McpServer> = {};
  for (const [name, server] of Object.entries(parsed.mcpServers ?? {})) {
    const at = `${path} (mcpServers.${name})`;
    out[name] = {
      command: expandEnv(server.command, at),
      ...(server.args ? { args: server.args.map(a => expandEnv(a, at)) } : {}),
      ...(server.env
        ? { env: Object.fromEntries(Object.entries(server.env).map(([k, v]) => [k, expandEnv(v, at)])) }
        : {}),
    };
  }
  return out;
}

export function createCodexRunner(
  opts: { installRoot: string; skillsDir?: string; bin?: string },
): Runner {
  const bin = opts.bin ?? "codex";
  const skillsDir = opts.skillsDir ?? "skills";

  return {
    async run(req: RunRequest): Promise<RunResult> {
      // Codex has no --system-prompt-file, so who-you-are and how-you-work
      // travel with the task on stdin. Same framing the loop adapters use, from
      // the same module, so the three non-Claude paths cannot drift.
      let system = "";
      try {
        const bundle = req.agent.bundlePath ? await readFile(req.agent.bundlePath, "utf8") : "";
        const skill = req.skill
          ? { name: req.skill, body: await loadSkill(opts.installRoot, skillsDir, req.skill) }
          : null;
        system = buildSystemPrompt(bundle, skill);
      } catch (err) {
        // A missing bundle or an unknown skill is a configuration error, and
        // spawning to discover it would bill a run to learn nothing. Fail here,
        // in the same shape a failed run takes, so the engine's blocking comment
        // reads identically either way.
        return {
          exitCode: -1, status: "failed", usage: null,
          stderrTail: String(err instanceof Error ? err.message : err).slice(-STDERR_TAIL_CHARS),
        };
      }

      const mcpServers = await readMcpServers(req.mcpConfigPath);
      return runChild(
        { ...req, prompt: `${system}\n\n---\n\n${req.prompt}` },
        { bin, args: buildCodexArgs(req, mcpServers), extractUsage: extractCodexUsage },
      );
    },
  };
}
