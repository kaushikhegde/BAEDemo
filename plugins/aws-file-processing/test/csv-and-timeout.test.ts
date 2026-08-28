// The two things that let eight documents sit at `running` for twenty minutes.
//
// A `.csv` went to `@firecrawl/anydoc`, a prebuilt NAPI addon — and nothing in
// the conversion path had a deadline. The `try/catch` around each engine
// catches a THROW; a native call that wedges never throws, it just never
// returns, so the catch was no defence and the streaming fallback below it was
// unreachable. The job could not fail, so nothing reported it, and the caller's
// own timeout was the only thing that ever fired.
//
// Two fixes, tested apart because they are independent: a CSV no longer
// reaches native code at all, and nothing in the path can wait for ever.

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { csvToMarkdown, chooseConverter, isConvertible } from "../src/worker/markdown.js";
import { loadConfig } from "../src/shared/config.js";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cfg = loadConfig({});

describe("csvToMarkdown", () => {
  it("renders a table with a header rule", () => {
    expect(csvToMarkdown("id,name\n1,Alpha\n2,Beta\n")).toBe(
      "| id | name |\n| --- | --- |\n| 1 | Alpha |\n| 2 | Beta |");
  });

  it("honours RFC 4180 quoting — separators and doubled quotes inside a field", () => {
    // The whole reason a CSV cannot be split on commas. A naive parser turns
    // one cell into three and every column after it is wrong.
    const out = csvToMarkdown('a,b\n"x, y","he said ""hi"""\n');
    expect(out).toContain("| x, y | he said \"hi\" |");
  });

  it("keeps a quoted newline inside its cell rather than starting a row", () => {
    const out = csvToMarkdown('a,b\n"line one\nline two",z\n');
    expect(out.split("\n")).toHaveLength(3);        // header, rule, one data row
    expect(out).toContain("line one line two");     // flattened, never split
  });

  it("ends an unterminated quote at end of input instead of throwing", () => {
    // A truncated export is still worth reading. Refusing it would send the
    // whole document down the flat-text path over one bad row.
    expect(() => csvToMarkdown('a,b\n"never closed,z\n')).not.toThrow();
    expect(csvToMarkdown('a,b\n"never closed,z\n')).toContain("never closed");
  });

  it("pads ragged rows rather than dropping the overflow", () => {
    // Losing a column silently is how a data model ends up missing a field
    // nobody can trace back to a source.
    const out = csvToMarkdown("a,b\n1,2,3\n");
    expect(out).toContain("| 1 | 2 | 3 |");
    expect(out).toContain("| a | b |  |");
  });

  it("escapes a pipe, which would otherwise end the cell it sits in", () => {
    expect(csvToMarkdown("a\nx|y\n")).toContain("x\\|y");
  });

  it("is empty for input with no cells, so the caller falls through", () => {
    expect(csvToMarkdown("")).toBe("");
    expect(csvToMarkdown("\n,\n,,\n")).toBe("");
  });

  it("cannot hang: it is a string parser with no I/O", async () => {
    // 20k rows, the shape that wedged the client's run. A bound is asserted
    // rather than merely "it returned" — quadratic behaviour would pass the
    // second and fail a real document.
    const big = "a,b,c\n" + Array.from({ length: 20_000 }, (_, i) => `${i},x,y`).join("\n");
    const t = Date.now();
    const out = csvToMarkdown(big);
    expect(Date.now() - t).toBeLessThan(5_000);
    expect(out.split("\n")).toHaveLength(20_002);   // header, rule, 20k rows
  });
});

describe("a .csv never reaches a native addon", () => {
  const csvAt = async () => {
    const dir = await mkdtemp(join(tmpdir(), "csvconv-"));
    const p = join(dir, "x.csv");
    await writeFile(p, "id,name\n1,Alpha\n");
    return p;
  };

  it("is claimed by the built-in converter, not anydoc", async () => {
    expect(await chooseConverter(await csvAt(), ".csv", cfg)).toBe("csv");
  });

  it("is still a format the pipeline accepts", () => {
    expect(isConvertible(".csv")).toBe(true);
  });

  it("is not listed for anydoc any more", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = await readFile(resolve(here, "../src/worker/markdown.ts"), "utf8");
    const anydocList = src.slice(src.indexOf("const ANYDOC_FORMATS"), src.indexOf("const CSV_FORMATS"));
    expect(anydocList).not.toContain('".csv"');
  });
});

describe("no converter call can wait for ever", () => {
  const source = async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFile(resolve(here, "../src/worker/markdown.ts"), "utf8");
  };

  it("puts a deadline on BOTH structured engines", async () => {
    // Either one left unwrapped reproduces the bug for the formats it owns.
    const src = await source();
    expect(src).toMatch(/withTimeout<any>\(\s*\n?\s*new MarkItDown\(\)\.convertBuffer/);
    expect(src).toMatch(/withTimeout\(\s*\n?\s*toMarkdown\(/);
  });

  it("rejects rather than resolving, so the caller falls through to stream", async () => {
    const src = await source();
    const fn = src.slice(src.indexOf("const withTimeout ="), src.indexOf("* A CSV as a markdown table"));
    expect(fn).toMatch(/reject\(new Error\(/);
    // A resolve would hand the caller an empty document and record it as a
    // successful structured conversion — worse than the flat text it replaces.
    expect(fn).not.toMatch(/resolve\(/);
  });

  it("does not let a losing converter hold the process open", async () => {
    const src = await source();
    const fn = src.slice(src.indexOf("const withTimeout ="), src.indexOf("* A CSV as a markdown table"));
    expect(fn).toMatch(/timer\.unref\?\.\(\)/);
    expect(fn).toMatch(/clearTimeout\(timer\)/);
  });

  it("is configurable, and defaults to something a big .docx can finish inside", () => {
    expect(cfg.convertTimeoutMs).toBe(120_000);
    expect(loadConfig({ CONVERT_TIMEOUT_MS: "5000" }).convertTimeoutMs).toBe(5_000);
  });
});
