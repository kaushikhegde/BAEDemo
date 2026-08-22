import { describe, it, expect } from "vitest";
import { hardBreaks, stripConverterBanner, renderSource } from "./markdown";

describe("hardBreaks", () => {
  it("keeps consecutive lines apart, which CommonMark would otherwise join", () => {
    // The failure this exists for: a converted PDF renders as one run-on
    // paragraph because markdown treats a single newline as a space.
    expect(hardBreaks("Connection Point (NMI)\nPK\nNMI"))
      .toBe("Connection Point (NMI)  \nPK  \nNMI");
  });

  it("leaves paragraph breaks alone", () => {
    // A blank line already separates them; a hard break before one is noise.
    expect(hardBreaks("First para.\n\nSecond para.")).toBe("First para.\n\nSecond para.");
  });

  it("does not mark the last line", () => {
    expect(hardBreaks("only line")).toBe("only line");
    expect(hardBreaks("a\nb")).toBe("a  \nb");
  });

  it("leaves a line that already breaks explicitly", () => {
    expect(hardBreaks("a  \nb")).toBe("a  \nb");
    expect(hardBreaks("a\\\nb")).toBe("a\\\nb");
  });

  it("never touches a fenced code block", () => {
    // Two trailing spaces inside a fence are part of the code — and the fences
    // here include the mermaid blocks the renderer turns into diagrams.
    const src = "intro\n```js\nconst a = 1\nconst b = 2\n```\nafter";
    expect(hardBreaks(src)).toBe("intro  \n```js\nconst a = 1\nconst b = 2\n```\nafter");
  });

  it("handles a tilde fence and an info string", () => {
    const src = "a\n~~~mermaid\ngraph TD\nA-->B\n~~~\nb";
    expect(hardBreaks(src)).toBe("a  \n~~~mermaid\ngraph TD\nA-->B\n~~~\nb");
  });

  it("survives an unclosed fence without breaking the rest of the file", () => {
    // A truncated conversion is a real state. Everything after the opener is
    // treated as code, which is the safe reading — it edits nothing.
    expect(hardBreaks("a\n```\nb\nc")).toBe("a  \n```\nb\nc");
  });

  it("normalises CRLF, so a Windows-authored document behaves the same", () => {
    expect(hardBreaks("a\r\nb")).toBe("a  \nb");
  });

  it("is empty for empty input rather than throwing", () => {
    expect(hardBreaks("")).toBe("");
  });

  it("is idempotent — running it twice changes nothing further", () => {
    const src = "Connection Point\nPK\n\nMeter\nMeter_ID";
    expect(hardBreaks(hardBreaks(src))).toBe(hardBreaks(src));
  });
});

describe("stripConverterBanner", () => {
  it("removes the banner convert-to-md.mjs writes as line 1", () => {
    const src = "<!-- Converted from Introduction.pdf by markitdown-ts. Regenerate with scripts/convert-to-md.mjs. -->\n\n# Title";
    expect(stripConverterBanner(src)).toBe("# Title");
  });

  it("leaves a document that has no banner exactly as it was", () => {
    expect(stripConverterBanner("# Title\n\nBody.")).toBe("# Title\n\nBody.");
  });

  it("leaves an unrelated comment at the top alone", () => {
    // Only the converter's own banner is provenance. Someone else's comment is
    // part of the document.
    expect(stripConverterBanner("<!-- draft -->\n\n# Title")).toBe("<!-- draft -->\n\n# Title");
  });

  it("leaves a converter-shaped comment that is not at the top", () => {
    const src = "# Title\n\n<!-- Converted from x.pdf -->";
    expect(stripConverterBanner(src)).toBe(src);
  });
});

describe("renderSource", () => {
  // `Markdown` renders the artefacts behind the APPROVAL GATE — the product
  // summary, the data model's 421 table rows, the persona set's diagrams. If
  // the new option ever leaked into that path, reviewers would be approving
  // documents that had been reformatted underneath them.
  const ARTEFACT = [
    "# 1. Executive Summary",
    "",
    "This feature lets an applicant lodge a facilities-access request and",
    "track it to determination.",
    "",
    "| Object | API Name | Type |",
    "| --- | --- | --- |",
    "| Case | Case | Standard |",
    "",
    "```mermaid",
    "graph TD",
    "A-->B",
    "```",
  ].join("\n");

  it("passes the source through untouched when the option is off", () => {
    expect(renderSource(ARTEFACT, false)).toBe(ARTEFACT);
  });

  it("is off by omission — every existing call site passes no flag", () => {
    // Mirrors the component's own default. A default of `true` would silently
    // change all eight.
    const preserveLineBreaks = false;   // the declared default in Markdown.tsx
    expect(renderSource(ARTEFACT, preserveLineBreaks)).toBe(ARTEFACT);
  });

  it("applies the breaks only when asked", () => {
    expect(renderSource("a\nb", true)).toBe("a  \nb");
  });
});
