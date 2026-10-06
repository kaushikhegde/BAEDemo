import { test } from "node:test";
import assert from "node:assert/strict";
import { contrast, readableOn, selectedSurface } from "./colour.mjs";

// A brand surface carries text: the selected nav item, capability ID badges,
// journey stage headers. Left to the maths alone, a bright red such as BAE's
// #FF0033 gets NEAR-BLACK text (5.0:1 beats white's 4.0:1). A client whose
// brand is red-with-white-text needs to be able to say so, and the page must
// still clear WCAG AA when they do.

test("with no preference, the foreground is whichever reads better", () => {
  const { bg, fg } = selectedSurface("#FF0033");
  assert.equal(bg, "#FF0033");
  assert.equal(fg, readableOn("#FF0033"));
  assert.ok(contrast(bg, fg) >= 4.5);
});

test("a white preference on bright red keeps white and darkens the red until it passes AA", () => {
  const { bg, fg } = selectedSurface("#FF0033", "#ffffff");
  assert.equal(fg, "#ffffff");
  assert.ok(contrast(bg, fg) >= 4.5, `${bg} on ${fg} is ${contrast(bg, fg).toFixed(2)}:1`);
  assert.notEqual(bg.toLowerCase(), "#ff0033", "the surface had to move");
  // Still recognisably red: the red channel dominates.
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16));
  assert.ok(r > 200 && g < 40 && b < 70, `${bg} is no longer the brand red`);
});

test("a preference that already passes leaves the surface alone", () => {
  const { bg, fg } = selectedSurface("#1f4c71", "#ffffff");
  assert.equal(bg, "#1f4c71");
  assert.equal(fg, "#ffffff");
});

test("an invalid preference is ignored, not trusted", () => {
  const { fg } = selectedSurface("#FF0033", "white; background:url(x)");
  assert.equal(fg, readableOn("#FF0033"));
});
