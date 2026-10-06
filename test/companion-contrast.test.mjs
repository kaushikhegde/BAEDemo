import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Found by a contrast audit of every companion-app view in light and dark mode
// on BAE's red theme: the only text below WCAG AA was painted in `--line` (a
// border colour, ~1.3:1) or in raw `--brand` behind white (3.96:1 on #FF0033).
// `--sel-bg` / `--sel-fg` are the pair the renderer guarantees at 4.5:1, and
// `--muted` is the readable secondary text colour.
const css = readFileSync(new URL("../scripts/render-companion-app.mjs", import.meta.url), "utf8");

test("no text is coloured with the border colour", () => {
  const offenders = css.split("\n").filter((l) => /(^|[;{\s])color:var\(--line\)/.test(l));
  assert.deepEqual(offenders, []);
});

test("the skip link sits on the guaranteed brand surface", () => {
  const rule = css.split("\n").find((l) => l.startsWith(".skip{"));
  assert.ok(rule, "no .skip rule");
  assert.match(rule, /background:var\(--sel-bg\)/);
  assert.match(rule, /color:var\(--sel-fg\)/);
});
