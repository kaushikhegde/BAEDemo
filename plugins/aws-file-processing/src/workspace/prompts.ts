import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * The `scyne` MCP prompt.
 *
 * Claude Code surfaces this THREE ways, and all three are the same text:
 *
 *   - `commands/scyne.md`, the plugin's own slash command — `/scyne <verb>`.
 *     This is the one a user will actually type, and it is a file rather than a
 *     prompt because Claude Code sources slash commands from a `commands/`
 *     directory. (Codex, which this plugin was ported from, removed custom
 *     slash commands in 0.117.0 and invokes a skill with `$` instead — which is
 *     why the Codex build had a `skills/` entry and no `commands/`.)
 *   - `skills/scyne/SKILL.md`, the model-invoked skill, which fires on its own
 *     when somebody mentions a large PDF without typing any command at all.
 *   - this MCP prompt, which `prompts/list` exposes to any client that reads it.
 *
 * All three resolve to ONE body on disk, loaded at call time rather than
 * duplicated, so they cannot drift and editing the skill updates every surface.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** `src/workspace/` → the plugin root. Resolved rather than assumed relative to
 *  cwd: this server is started by `stack.sh` from the plugin directory, but
 *  nothing guarantees that for a caller who runs it another way. */
const COMMAND_FILE = resolve(here, "..", "..", "skills", "scyne", "SKILL.md");

const FALLBACK =
  "The scyne skill body could not be read from disk. The MCP tools are " +
  "unaffected: call `stages` to see what this server can run, `list_issues` " +
  "for what is in flight, and `issue_status` for one of them.";

export const readCommandBody = (file = COMMAND_FILE): string => {
  // A missing file must not take the prompt down with it — the command still
  // resolves, and says plainly that its own instructions are missing rather
  // than failing with a path nobody outside this repo can act on.
  if (!existsSync(file)) return FALLBACK;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return FALLBACK;
  }
};

export const registerPrompts = (server: McpServer): void => {
  server.registerPrompt(
    "scyne",
    {
      title: "Scyne pipeline",
      description:
        "Drive the Scyne requirements pipeline: run a stage, check an issue, approve a " +
        "gate, ingest a large document, revise an artefact, report spend. " +
        "Try: use SAPN \"CRM Management\" · run datamodel · status SCY-41 · " +
        "gate approve g_8f21 · spend --by feature",
      argsSchema: {
        // One free-form argument rather than a verb enum, so `/scyne run
        // datamodel` reads the way the brief drew it. The verb table lives in
        // the command body, which is also what refuses an unknown one.
        args: z
          .string()
          .optional()
          .describe('The verb and its arguments, e.g. `run datamodel` or `status SCY-41`'),
      },
    },
    ({ args }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              `${readCommandBody()}\n\n---\n\n` +
              (args?.trim()
                ? `The user invoked: \`/scyne ${args.trim()}\`\n\nDispatch on the verb above.`
                : "The user invoked `/scyne` with no verb. Report the current target if one " +
                  "is set, then run `stages` and `list_issues { open: true }` and summarise " +
                  "what is runnable and what is waiting on a person."),
          },
        },
      ],
    }),
  );
};
