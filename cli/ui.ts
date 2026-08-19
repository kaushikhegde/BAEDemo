// Terminal presentation: colour, a spinner, and just enough markdown.
//
// No dependency. Everything here is ANSI escapes and string handling, because
// the session deliberately prints and scrolls rather than repainting a screen
// — that is what keeps copy-paste, scrollback and piping working, and it is
// what Claude Code does too. A TUI library would buy boxes and cost all three.

const TTY = process.stdout.isTTY === true;
// NO_COLOR is a convention worth honouring: it is how people using screen
// readers, dumb terminals and CI logs ask for plain text.
const COLOUR = TTY && !process.env.NO_COLOR;

const wrap = (open: string, close = "\x1b[0m") =>
  (s: string): string => (COLOUR ? `${open}${s}${close}` : s);

export const c = {
  bold: wrap("\x1b[1m"),
  dim: wrap("\x1b[2m"),
  italic: wrap("\x1b[3m"),
  red: wrap("\x1b[31m"),
  green: wrap("\x1b[32m"),
  yellow: wrap("\x1b[33m"),
  blue: wrap("\x1b[34m"),
  magenta: wrap("\x1b[35m"),
  cyan: wrap("\x1b[36m"),
  grey: wrap("\x1b[90m"),
  /** Scyne's indigo, as the closest 256-colour cell to #464e7e. */
  brand: wrap("\x1b[38;5;61m"),
};

export const out = (s = ""): void => { process.stdout.write(s + "\n"); };

/**
 * Render the small subset of markdown the assistant actually emits: **bold**,
 * `code`, bullets, and fenced blocks. A full parser would be a dependency and
 * several hundred lines to make four constructs legible.
 */
export function markdown(text: string, indent = "  "): string {
  const lines: string[] = [];
  let inFence = false;

  for (const raw of text.split("\n")) {
    if (raw.trim().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) { lines.push(indent + c.grey("│ ") + c.cyan(raw)); continue; }

    let line = raw
      .replace(/\*\*(.+?)\*\*/g, (_, m: string) => c.bold(m))
      .replace(/`([^`]+)`/g, (_, m: string) => c.cyan(m))
      // A bare URL is the one thing worth making obvious — it is usually the
      // Confluence page someone is waiting for.
      .replace(/(https?:\/\/\S+)/g, (_, m: string) => c.blue(m));

    if (/^\s*[-*]\s+/.test(raw)) line = line.replace(/^(\s*)[-*]\s+/, `$1${c.brand("•")} `);
    if (/^#{1,6}\s+/.test(raw)) line = c.bold(line.replace(/^#{1,6}\s+/, ""));

    lines.push(line.trim() ? indent + line : "");
  }
  return lines.join("\n");
}

/**
 * A one-line spinner that erases itself.
 *
 * Only ever occupies the CURRENT line and clears it on stop, so the scrollback
 * above is never rewritten — a spinner that redrew earlier output would break
 * the copy-paste property the whole design is built around. On a non-TTY it
 * degrades to a single printed line, so piping to a file stays readable.
 */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface Spinner {
  update(label: string): void;
  stop(final?: string): void;
}

export function spinner(label: string): Spinner {
  if (!TTY) {
    out("  " + c.grey(label));
    return { update: () => {}, stop: (final) => { if (final) out(final); } };
  }
  let i = 0;
  let current = label;
  const draw = (): void => {
    process.stdout.write(`\r\x1b[2K  ${c.brand(FRAMES[i++ % FRAMES.length])} ${c.grey(current)}`);
  };
  draw();
  const timer = setInterval(draw, 80);
  return {
    update(next: string) { current = next; },
    stop(final?: string) {
      clearInterval(timer);
      process.stdout.write("\r\x1b[2K");
      if (final) out(final);
    },
  };
}

export const tick = c.green("✓");
export const cross = c.red("✗");
export const dot = c.grey("·");
export const arrow = c.brand("▸");

export function banner(info: { apiUrl: string; chatUrl: string; user?: string; adapter?: string }): void {
  out();
  out("  " + c.brand(c.bold("█ SCYNE")) + "  " + c.grey("requirements pipeline"));
  const bits = [
    info.user ?? "not signed in",
    info.adapter ? `adapter ${info.adapter}` : null,
    info.apiUrl.replace(/^https?:\/\//, ""),
  ].filter(Boolean);
  out("  " + c.grey(bits.join(` ${dot} `)));
  out();
  out("  " + c.grey("Talk to it in plain English. ") + c.cyan("/help") + c.grey(" for commands, ")
      + c.cyan("/exit") + c.grey(" to leave."));
  out();
}

/** `RTWSA / Appeals ›` — the prompt carries the target so it is never ambiguous. */
export function promptLabel(project?: string | null, feature?: string | null): string {
  const scope = project
    ? c.brand(project) + (feature ? c.grey(" / ") + c.brand(feature) : "")
    : c.grey("no project");
  return `\n${scope} ${c.brand("›")} `;
}
