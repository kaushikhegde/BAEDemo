// Who draws a wizard step's label.
//
// The case that motivated this file: `/new`, type a project name, press
// backspace to correct a letter, and the label «Project name:» is replaced
// mid-answer by the session's own `no project ›`. readline in terminal mode
// redraws the whole line from ITS prompt on every edit, so a label written
// straight to stdout survives exactly until the first correction.
//
// The consequence is worse than a smudged screen: the step now looks like the
// ordinary prompt, so the next thing typed is typed as a COMMAND. `/new` at a
// vanished "Project name:" was consumed AS the project name and refused for
// containing a slash — which reads as the wizard rejecting a good name.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { drawLabel } from "./repl.ts";

const SESSION = "no project > ";
const LABEL = "  Project name: ";

/** A readline in terminal mode, and everything it has drawn since last read. */
function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  let drawn = "";
  output.on("data", (d) => { drawn += String(d); });
  const rl = createInterface({ input, output, terminal: true });
  rl.setPrompt(SESSION);
  rl.prompt();
  return {
    rl, input,
    take: () => { const s = drawn; drawn = ""; return s; },
    done: () => rl.close(),
  };
}

test("a step's label survives the redraw a backspace triggers", () => {
  const t = terminal();
  drawLabel(t.rl, LABEL, true);
  t.take();

  t.input.write("SA");
  t.input.write("\x7f");                       // backspace
  const redraw = t.take();

  assert.ok(redraw.includes(LABEL), `the label was wiped: ${JSON.stringify(redraw)}`);
  assert.ok(!redraw.includes(SESSION), `the session prompt came back: ${JSON.stringify(redraw)}`);
  assert.ok(redraw.includes("S"), "the edited buffer should still be shown");
  t.done();
});

test("the bug, for the record: written to stdout, the label is gone by the first backspace", () => {
  const t = terminal();
  // What ask() used to do — write it out of band, where readline cannot see it.
  (t.rl as unknown as { output: PassThrough }).output.write(LABEL);
  t.take();

  t.input.write("SA");
  t.input.write("\x7f");
  const redraw = t.take();

  assert.ok(!redraw.includes(LABEL));
  assert.ok(redraw.includes(SESSION));
  t.done();
});

test("on a pipe the label is written directly, and readline's prompt is left alone", () => {
  let written = "";
  const calls: string[] = [];
  const rl = {
    setPrompt: (p: string) => calls.push(p),
    prompt: () => calls.push("<prompt>"),
  };
  drawLabel(rl as never, LABEL, false, { write: (s: string) => { written += s; } });

  assert.equal(written, LABEL);
  assert.deepEqual(calls, [], "a pipe has no line editing — nothing to hand readline");
});
