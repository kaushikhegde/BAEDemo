import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/make-fixture-pdf.mjs");
const dir = mkdtempSync(join(tmpdir(), "afp-fx-"));
const pdf = join(dir, "fixture.pdf");
let made: any;

beforeAll(() => {
  made = JSON.parse(execFileSync("node",
    [script, pdf, "40", "--needle", "TERMINATION_CLAUSE_NEEDLE", "--needle-page", "37"],
    { encoding: "utf8" }).trim());
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("make-fixture-pdf", () => {
  it("reports what it wrote", () => {
    expect(made.ok).toBe(true);
    expect(made.pages).toBe(40);
    expect(statSync(pdf).size).toBe(made.bytes);
  });

  it("produces a PDF poppler agrees has the right page count", () => {
    const info = execFileSync("pdfinfo", [pdf], { encoding: "utf8" });
    expect(info).toMatch(/^Pages:\s+40$/m);
  });

  it("puts the needle on the requested page and nowhere else", () => {
    const p37 = execFileSync("pdftotext", ["-f", "37", "-l", "37", pdf, "-"], { encoding: "utf8" });
    const p36 = execFileSync("pdftotext", ["-f", "36", "-l", "36", pdf, "-"], { encoding: "utf8" });
    expect(p37).toContain("TERMINATION_CLAUSE_NEEDLE");
    expect(p36).not.toContain("TERMINATION_CLAUSE_NEEDLE");
  });

  it("marks every page so extraction can be checked page by page", () => {
    const p12 = execFileSync("pdftotext", ["-f", "12", "-l", "12", pdf, "-"], { encoding: "utf8" });
    expect(p12).toContain("Page 12 of 40");
  });
});

// Runs the generator expecting it to refuse (non-zero exit). Returns the exit
// status and stderr so the caller can assert the refusal names the problem.
// Throws if the process unexpectedly succeeds, so a regression that silently
// stops refusing fails loudly rather than being skipped.
function runFail(args: string[]): { status: number; stderr: string } {
  try {
    execFileSync("node", [script, ...args], { encoding: "utf8" });
  } catch (e: any) {
    if (e.status === undefined || e.status === 0) throw e;
    return { status: e.status, stderr: String(e.stderr ?? "") };
  }
  throw new Error(`expected make-fixture-pdf ${args.join(" ")} to exit non-zero, but it succeeded`);
}

describe("make-fixture-pdf input validation", () => {
  it("refuses pages 0 rather than emitting an invalid PDF", () => {
    const { status, stderr } = runFail([join(dir, "zero.pdf"), "0"]);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/pages/i);
    expect(stderr).toMatch(/>= 1/);
  });

  it("refuses a non-numeric pages argument", () => {
    const { status, stderr } = runFail([join(dir, "nan.pdf"), "abc"]);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/pages/i);
    expect(stderr).toContain("abc");
  });

  it("refuses a needle-page outside 1..pages rather than silently dropping the needle", () => {
    const { status, stderr } = runFail(
      [join(dir, "oob.pdf"), "5", "--needle", "X", "--needle-page", "999"]);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/needle-page/i);
    expect(stderr).toContain("999");
  });

  it("refuses a lines-per-page too small for the needle to ever be reached", () => {
    const { status, stderr } = runFail(
      [join(dir, "toofew.pdf"), "5", "--needle", "X", "--lines-per-page", "3"]);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/lines-per-page/i);
    expect(stderr).toMatch(/line 3/);
  });

  it("refuses a needle with a character outside Latin-1", () => {
    const { status, stderr } = runFail(
      [join(dir, "nonlatin.pdf"), "5", "--needle", "needle→", "--needle-page", "1"]);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/latin-1/i);
  });

  it("accepts a needle at the Latin-1 boundary (e.g. café) without refusing", () => {
    const out = join(dir, "boundary.pdf");
    const result = JSON.parse(execFileSync("node",
      [script, out, "5", "--needle", "café", "--needle-page", "2"],
      { encoding: "utf8" }).trim());
    expect(result.ok).toBe(true);
  });

  it("still produces valid, extractable output for a legal invocation", () => {
    const out = join(dir, "legal.pdf");
    const result = JSON.parse(execFileSync("node",
      [script, out, "5", "--needle", "STILL_WORKS_NEEDLE", "--needle-page", "3"],
      { encoding: "utf8" }).trim());
    expect(result.ok).toBe(true);
    const info = execFileSync("pdfinfo", [out], { encoding: "utf8" });
    expect(info).toMatch(/^Pages:\s+5$/m);
    const p3 = execFileSync("pdftotext", ["-f", "3", "-l", "3", out, "-"], { encoding: "utf8" });
    expect(p3).toContain("STILL_WORKS_NEEDLE");
    expect(p3).toContain("Page 3 of 5");
  });
});
