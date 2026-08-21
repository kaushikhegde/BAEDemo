// Bracketed paste, tested as a pure parser.
//
// The bug this exists for: `/new` asks four questions, each reading ONE line.
// A pasted paragraph arrives as N lines, so it was consumed as N answers and
// the overflow fell through to the chat loop, where the assistant read each
// stray sentence as "create a feature". A terminal that brackets its pastes
// lets us see the block as one thing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createPasteReader, createPasteStore, PASTE_START, PASTE_END } from "./paste.ts";

const wrap = (s: string): string => PASTE_START + s + PASTE_END;

test("ordinary keystrokes pass straight through", () => {
  const r = createPasteReader();
  assert.deepEqual(r.feed("hello"), { typed: "hello", pastes: [] });
  assert.deepEqual(r.feed("\r"), { typed: "\r", pastes: [] });
});

test("a bracketed block is lifted out, markers and all", () => {
  const r = createPasteReader();
  const out = r.feed(wrap("one\ntwo\nthree"));
  assert.equal(out.typed, "");
  assert.deepEqual(out.pastes, ["one\ntwo\nthree"]);
});

test("text either side of a paste is still typed", () => {
  const r = createPasteReader();
  const out = r.feed("a" + wrap("X\nY") + "b\r");
  assert.equal(out.typed, "ab\r");
  assert.deepEqual(out.pastes, ["X\nY"]);
});

test("a paste split across chunks yields nothing until it closes", () => {
  const r = createPasteReader();
  assert.deepEqual(r.feed(PASTE_START + "one\n"), { typed: "", pastes: [] });
  assert.deepEqual(r.feed("two\n"), { typed: "", pastes: [] });
  assert.deepEqual(r.feed("three" + PASTE_END), { typed: "", pastes: ["one\ntwo\nthree"] });
});

test("a marker split across chunks is not mistaken for typing", () => {
  const r = createPasteReader();
  // A 64KB stream boundary can land anywhere, including inside the escape.
  assert.deepEqual(r.feed("\x1b[20"), { typed: "", pastes: [] });
  assert.deepEqual(r.feed("0~body\x1b[2"), { typed: "", pastes: [] });
  assert.deepEqual(r.feed("01~"), { typed: "", pastes: ["body"] });
});

test("carriage returns inside a paste never reach readline", () => {
  const r = createPasteReader();
  // This is the whole bug: each \r is an Enter, and each Enter submitted.
  const out = r.feed(wrap("one\rtwo\rthree"));
  assert.equal(out.typed, "");
  assert.equal(out.typed.includes("\r"), false);
  assert.deepEqual(out.pastes, ["one\rtwo\rthree"]);
});

test("two pastes in one chunk stay two blocks", () => {
  const r = createPasteReader();
  const out = r.feed(wrap("a\nb") + wrap("c\nd"));
  assert.deepEqual(out.pastes, ["a\nb", "c\nd"]);
});

test("a held escape is released rather than swallowed", () => {
  const r = createPasteReader();
  // The Escape key is one byte, and it is also the first byte of the marker.
  assert.deepEqual(r.feed("\x1b"), { typed: "", pastes: [] });
  assert.equal(r.held, true);
  assert.equal(r.flush(), "\x1b");
  assert.equal(r.held, false);
});

test("flush refuses to break up an unterminated paste", () => {
  const r = createPasteReader();
  r.feed(PASTE_START + "half\x1b[2");
  assert.equal(r.flush(), "");          // that \x1b[2 may yet be the END marker
  assert.deepEqual(r.feed("01~"), { typed: "", pastes: ["half"] });
});

test("a one-line paste is inserted verbatim, minus the newline that would submit it", () => {
  const s = createPasteStore();
  assert.equal(s.stash("https://acme.example\n"), "https://acme.example");
  assert.equal(s.stash("no newline at all"), "no newline at all");
});

test("a multi-line paste becomes one placeholder that expands back exactly", () => {
  const s = createPasteStore();
  const text = "ReturnToWorkSA administers the scheme.\n\nIt is obliged under the Act to…";
  const shown = s.stash(text);
  assert.equal(shown, "[Pasted text #1 +3 lines]");
  assert.equal(s.expand(shown), text);
  assert.equal(s.expand("  " + shown + "  "), "  " + text + "  ");
});

test("CRLF and bare CR are normalised before anything counts lines", () => {
  const s = createPasteStore();
  assert.equal(s.stash("a\r\nb\rc\r\n"), "[Pasted text #1 +3 lines]");
  assert.equal(s.expand("[Pasted text #1 +3 lines]"), "a\nb\nc");
});

test("each paste gets its own id", () => {
  const s = createPasteStore();
  assert.equal(s.stash("a\nb"), "[Pasted text #1 +2 lines]");
  assert.equal(s.stash("c\nd"), "[Pasted text #2 +2 lines]");
  assert.equal(s.expand("[Pasted text #2 +2 lines]"), "c\nd");
});

test("a placeholder nobody stashed is left as typed text", () => {
  const s = createPasteStore();
  assert.equal(s.expand("[Pasted text #9 +4 lines]"), "[Pasted text #9 +4 lines]");
});

test("a paste of nothing but whitespace inserts nothing", () => {
  const s = createPasteStore();
  assert.equal(s.stash("\n\n"), "");
});

// ── The seam that actually broke ──────────────────────────────────────────
// Everything above is the parser. What follows drives the real thing: a
// pasted block goes in as bytes and readline must produce ONE line from it.

import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { attachPasteAwareInput } from "./paste.ts";

/** A stream readline and the paste reader will both treat as a terminal. */
function fakeTty(): NodeJS.ReadStream {
  const s = new PassThrough() as unknown as NodeJS.ReadStream;
  (s as unknown as { isTTY: boolean }).isTTY = true;
  (s as unknown as { setRawMode: (m: boolean) => void }).setRawMode = () => {};
  return s;
}

async function linesFrom(bytes: string[], bracketed: boolean): Promise<string[]> {
  const stdin = fakeTty();
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  stdout.resume();

  const term = bracketed
    ? attachPasteAwareInput(stdin, stdout)
    : { input: stdin, terminal: true, expand: (l: string) => l, restore() {} };

  const rl = createInterface({
    input: term.input, output: stdout, terminal: term.terminal, historySize: 500,
  });
  const seen: string[] = [];
  rl.on("line", raw => seen.push(term.expand(raw)));

  for (const b of bytes) stdin.write(b);
  await new Promise(r => setTimeout(r, 40));
  rl.close();
  term.restore();
  return seen;
}

const PARAGRAPH = "ReturnToWorkSA administers the scheme.\nIt is obliged under the Act.\nIts customers are injured workers.";

test("a pasted paragraph is one answer, not one answer per line", async () => {
  const lines = await linesFrom([PASTE_START + PARAGRAPH + PASTE_END, "\r"], true);
  assert.deepEqual(lines, [PARAGRAPH]);
});

test("the paste does not submit itself — the person still presses Return", async () => {
  const before = await linesFrom([PASTE_START + PARAGRAPH + "\n" + PASTE_END], true);
  assert.deepEqual(before, []);
});

test("typing either side of a paste ends up on the same line", async () => {
  const lines = await linesFrom(["one ", PASTE_START + "two\nthree" + PASTE_END, " four", "\r"], true);
  assert.deepEqual(lines, ["one two\nthree four"]);
});

test("the bug, for the record: unbracketed, the same bytes are four answers", async () => {
  // Which is how /new consumed one description as its description, its
  // website, its document paths and its first feature name.
  const lines = await linesFrom([PARAGRAPH.replace(/\n/g, "\r") + "\r"], false);
  assert.equal(lines.length, 3);
});
