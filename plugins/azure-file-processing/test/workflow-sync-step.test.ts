import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const src = readFileSync(resolve(repoRoot, "orchestrator.workflows.ts"), "utf8");

// Extracts the body of `function syncOutputsStep(...) { ... }`.
//
// A naive `[\s\S]{0,600}?\}` (as the brief originally proposed) stops at the
// FIRST literal `}` character anywhere in the source — including the one
// that closes `{project}` or `{feature}` inside a template-literal string,
// long before the function's own closing brace. Any implementation that
// quotes its placeholders (the whole point of this test) trips that early
// stop and gets truncated mid-string, so `toMatch(/"\{project\}"/)` can
// never see the closing quote. This repo's own formatting always puts a
// function's closing `}` alone at the start of a line, so anchoring on
// `\n}` finds the real end instead of the first incidental one.
const FN_BODY = /function syncOutputsStep[\s\S]*?\n\}/;

describe("workflow sync step", () => {
  it("defines a sync-outputs exec step", () => {
    expect(src).toMatch(/function syncOutputsStep/);
  });

  it("quotes the project placeholder — an unquoted one word-splits in sh", () => {
    const m = src.match(FN_BODY);
    expect(m).toBeTruthy();
    expect(m![0]).toMatch(/"\{project\}"/);
    expect(m![0]).not.toMatch(/[^"]\{project\}[^"]/);
  });

  it("runs the plugin's sync CLI with --up", () => {
    const m = src.match(FN_BODY)![0];
    expect(m).toMatch(/sync\.mjs/);
    expect(m).toMatch(/--up/);
  });

  it("is appended to the compiled workflow after attach", () => {
    // The step must exist in the step list, not merely be defined.
    // There must be at least one call site beyond the `function` declaration
    // itself (which also contains the literal text `syncOutputsStep(`).
    const occurrences = src.match(/syncOutputsStep\(/g) ?? [];
    expect(occurrences.length).toBeGreaterThan(1);
  });

  it("never fails the step it runs in — a sync hiccup must not block the issue", () => {
    // core/engine.ts blocks an issue on any exec step's non-zero exit, and a
    // sync failure is explicitly non-fatal per the workspace-plane plan, so
    // the compiled command must swallow a failing sync rather than propagate
    // its exit code.
    const m = src.match(FN_BODY)![0];
    expect(m).toMatch(/\|\|/);
  });
});
