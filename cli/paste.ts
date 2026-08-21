// Pasting into the interactive session.
//
// Every prompt in this session reads exactly one line, because readline
// delivers one `line` event per newline. That is correct for a typed answer
// and wrong for a pasted one: a pasted paragraph is N line events, so `/new`
// consumed a client's description as its description, its website, its
// document paths and its first feature name — and the lines still left over
// fell through to the chat loop, where the assistant read each stray sentence
// as an instruction and created a feature for it. One paste, a folder tree
// full of features, and real money spent on the runs behind them.
//
// The fix is the one every modern terminal already offers and Claude Code and
// Codex both use: BRACKETED PASTE. Ask the terminal with DECSET 2004 and it
// wraps pasted text in \x1b[200~ … \x1b[201~, which is the only way to tell a
// pasted newline from a pressed Return — the bytes are otherwise identical.
//
// readline cannot do this itself. Node's key decoder does not recognise the
// markers, so they arrive as literal text and its default branch splits the
// insert on newlines and submits each piece. So the markers are stripped
// BEFORE readline sees them: real stdin is read raw, the paste is lifted out
// here, and readline is handed a plain stream carrying only what was typed.
//
// Pure parser plus a small store, so both halves are testable without a
// terminal. See paste.test.ts.

import { PassThrough } from "node:stream";

/** DECSET 2004: on, and off. Written to the OUTPUT, read back on the input. */
export const PASTE_ON = "\x1b[?2004h";
export const PASTE_OFF = "\x1b[?2004l";

export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

/** The longest suffix of `s` that is also a proper prefix of `marker`. */
function heldPrefix(s: string, marker: string): number {
  const max = Math.min(s.length, marker.length - 1);
  for (let k = max; k > 0; k--) {
    if (s.endsWith(marker.slice(0, k))) return k;
  }
  return 0;
}

export interface PasteReader {
  /** Split one raw chunk into what was typed and any paste blocks it completed. */
  feed(chunk: string): { typed: string; pastes: string[] };
  /** True while bytes are being held back as a possible marker. */
  readonly held: boolean;
  /** Give up on a held marker and hand the bytes back. Never splits a paste. */
  flush(): string;
}

/**
 * A state machine over the raw stdin byte stream.
 *
 * Chunk boundaries land wherever the OS puts them, so neither the markers nor
 * the pasted text can be assumed whole: a 40 KB paste arrives in pieces, and
 * a piece can end in the middle of `\x1b[201~`. Anything that might be the
 * start of a marker is therefore held until the next chunk proves it either
 * way.
 */
export function createPasteReader(): PasteReader {
  let inPaste = false;
  let pasteBuf = "";
  let carry = "";

  return {
    get held() { return carry.length > 0; },

    feed(chunk: string) {
      let s = carry + chunk;
      carry = "";
      let typed = "";
      const pastes: string[] = [];

      for (;;) {
        const marker = inPaste ? PASTE_END : PASTE_START;
        const at = s.indexOf(marker);
        if (at >= 0) {
          const before = s.slice(0, at);
          if (inPaste) { pastes.push(pasteBuf + before); pasteBuf = ""; }
          else typed += before;
          s = s.slice(at + marker.length);
          inPaste = !inPaste;
          continue;
        }
        const hold = heldPrefix(s, marker);
        const settled = s.slice(0, s.length - hold);
        if (inPaste) pasteBuf += settled; else typed += settled;
        carry = s.slice(s.length - hold);
        break;
      }

      return { typed, pastes };
    },

    flush() {
      // Mid-paste the held bytes are a possible closing marker, and releasing
      // them would put `\x1b[2` in the middle of the client's description.
      // The close is coming; wait for it.
      if (inPaste) return "";
      const out = carry;
      carry = "";
      return out;
    },
  };
}

/** `[Pasted text #3 +12 lines]` — what readline shows in place of a block. */
const PLACEHOLDER = /\[Pasted text #(\d+) \+\d+ lines\]/g;

export interface PasteStore {
  /** What readline should display for this block. Verbatim, if it is one line. */
  stash(text: string): string;
  /** Put any placeholder in a submitted line back to what was pasted. */
  expand(line: string): string;
}

/**
 * What a paste looks like in the prompt, and what it turns back into.
 *
 * A block with newlines in it is replaced by a one-line placeholder rather
 * than inserted whole. That is Claude Code's own behaviour, and it is not
 * only cosmetic: readline draws its buffer on ONE line, so a forty-line
 * insert would leave the cursor arithmetic — and every subsequent edit —
 * wrong.
 *
 * A trailing newline is dropped in both cases, so a paste never submits
 * itself. The Return is the person's to press, which also gives them the
 * chance to see what landed.
 */
export function createPasteStore(): PasteStore {
  const texts = new Map<number, string>();
  let seq = 0;

  return {
    stash(raw: string) {
      const text = raw.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
      if (!text) return "";
      if (!text.includes("\n")) return text;
      const id = ++seq;
      texts.set(id, text);
      return `[Pasted text #${id} +${text.split("\n").length} lines]`;
    },

    expand(line: string) {
      // An id nobody stashed is text somebody typed. Leave it alone.
      return line.replace(PLACEHOLDER, (whole, id: string) => texts.get(Number(id)) ?? whole);
    },
  };
}

export interface TerminalInput {
  /** Hand this to readline in place of process.stdin. */
  input: NodeJS.ReadableStream;
  /**
   * What to pass readline as `terminal`.
   *
   * It cannot be left to default: readline reads it off `output.isTTY`, and
   * `input` here is a PassThrough that would otherwise get no line editing,
   * no history and no prompt. On the pipe path nothing is wrapped, so the
   * default is reproduced exactly rather than forced on.
   */
  terminal: boolean;
  /** Expand any placeholder a submitted line still carries. */
  expand(line: string): string;
  /** Let something else own stdin for a moment — readSecret(), for a password. */
  suspend(): void;
  resume(): void;
  /** Put the terminal back as we found it. */
  restore(): void;
}

/**
 * Read stdin raw, strip pastes out of it, and hand readline the remainder.
 *
 * Only at a terminal. A pipe has no bracketed paste to enable and no paste to
 * detect — every line arrives at once by design, which is what makes the
 * session scriptable (`printf '/use RTWSA\n/gates\n/exit\n' | scyne`), so it
 * is passed through untouched.
 *
 * The streams are parameters so that this — the part that has to be right and
 * cannot be reasoned about from the parser alone — is testable without a
 * terminal. Nothing but a test passes anything.
 */
export function attachPasteAwareInput(
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
): TerminalInput {
  if (!stdin.isTTY) {
    return {
      input: stdin, terminal: stdout.isTTY === true,
      expand: l => l, suspend() {}, resume() {}, restore() {},
    };
  }

  const proxy = new PassThrough();
  const reader = createPasteReader();
  const store = createPasteStore();
  let timer: NodeJS.Timeout | null = null;
  let attached = false;

  const onData = (chunk: string | Buffer): void => {
    if (timer) { clearTimeout(timer); timer = null; }
    const { typed, pastes } = reader.feed(
      typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    if (typed) proxy.write(typed);
    for (const block of pastes) {
      const shown = store.stash(block);
      if (shown) proxy.write(shown);
    }
    // Escape is one byte, and it is also the first byte of the marker — so a
    // pressed Escape is indistinguishable from a paste whose chunk ended
    // early, and is held. Nothing more is coming for a keypress, so release it
    // almost at once rather than swallowing the key.
    if (reader.held) {
      timer = setTimeout(() => {
        timer = null;
        const late = reader.flush();
        if (late) proxy.write(late);
      }, 5);
      timer.unref();
    }
  };

  const attach = (): void => {
    if (attached) return;
    attached = true;
    stdout.write(PASTE_ON);
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.resume();
  };

  const detach = (): void => {
    if (!attached) return;
    attached = false;
    if (timer) { clearTimeout(timer); timer = null; }
    stdin.off("data", onData);
    stdout.write(PASTE_OFF);
  };

  attach();

  const restore = (): void => {
    detach();
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
  };
  // Leaving DECSET 2004 and raw mode on would hand the shell back a terminal
  // that does not echo. Cheap insurance against every exit path.
  process.once("exit", restore);

  return {
    input: proxy,
    terminal: true,
    expand: line => store.expand(line),
    suspend: detach,
    // readSecret() leaves stdin paused; without the resume here the session
    // takes no further input after a password.
    resume: () => { attach(); },
    restore,
  };
}
