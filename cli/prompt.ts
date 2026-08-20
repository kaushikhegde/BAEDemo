// Asking a person for something, from a terminal.
//
// Extracted from cli/index.ts so the interactive session can use it too: the
// REPL had no /login, because the one implementation of a hidden password
// prompt lived in a module it does not import. Duplicating raw-mode handling
// would have meant two of them drifting.

import { createInterface } from "node:readline/promises";
import { ApiError } from "./client.ts";

/**
 * Read a secret from a terminal without echoing it.
 *
 * Written against raw stdin rather than readline, deliberately. The obvious
 * approach — override readline's `_writeToOutput` so keystrokes are swallowed
 * — is wrong twice over. It depends on an internal that Node 24 no longer
 * exposes (the method moved behind a symbol, so touching it throws
 * "Cannot read properties of undefined"), and even where it does exist,
 * muting it hides the PROMPT as well: readline clears the line and re-renders
 * `prompt + input` through that same method on every keystroke, so muting
 * leaves a bare cursor and the command looks like it has hung.
 *
 * Raw mode has neither problem and behaves the same on every Node version.
 * Backspace, Ctrl-C and Ctrl-D are handled here because raw mode means the
 * terminal no longer handles them for us.
 */
export function readSecret(label: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(label);

    const wasRaw = stdin.isRaw === true;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";
    const done = (finish: () => void): void => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stdout.write("\n");
      finish();
    };

    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        switch (ch) {
          case "\r": case "\n":
            return done(() => resolve(value));
          case "":                       // Ctrl-C
            return done(() => reject(new ApiError(130, "cancelled")));
          case "":                       // Ctrl-D
            return done(() => resolve(value));
          case "": case "\b":            // backspace
            value = value.slice(0, -1);
            break;
          default:
            // Ignore the remaining control characters — arrow keys arrive as
            // escape sequences and would otherwise land in the password.
            if (ch >= " ") value += ch;
        }
      }
    };

    stdin.on("data", onData);
  });
}

/**
 * Where a prompt gets its answer, when something other than a bare terminal is
 * driving.
 *
 * The interactive session installs its own reader here. It has to: the session
 * drains stdin through one line queue, and a command that opened a SECOND
 * readline would wait forever for lines the first has already buffered — which
 * is exactly how `/login` hung on "Email:". With this, every command that
 * prompts (`user password`, `run cancel`) works inside the session too, rather
 * than each one needing to be found and special-cased.
 */
type Reader = (label: string, silent: boolean) => Promise<string>;
let reader: Reader | null = null;

export function setPromptReader(r: Reader | null): void { reader = r; }

/** Ask a question. `silent` hides what is typed, for passwords. */
export async function prompt(question: string, opts: { silent?: boolean } = {}): Promise<string> {
  if (reader) return (await reader(question, opts.silent === true)).trim();
  // A terminal is the only place there is anyone to hide input from — and the
  // only place raw mode exists. Piped input (`printf 'pw\n' | scyne init`)
  // goes through readline unchanged.
  if (opts.silent && process.stdin.isTTY) {
    return (await readSecret(`${question.replace(/:\s*$/, "")} (hidden as you type): `)).trim();
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}
