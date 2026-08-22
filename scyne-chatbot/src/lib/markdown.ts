/**
 * Keep the line structure a converted document actually had.
 *
 * CommonMark joins consecutive lines into one paragraph — correct for prose
 * that was soft-wrapped by its author, and destructive for anything
 * `convert-to-md.mjs` produces from a PDF. markitdown-ts flattens a PDF table
 * to one field per line with no blank lines and no table syntax:
 *
 *     Connection Point (NMI)
 *     PK
 *     NMI
 *     Attr   Metering_Type
 *
 * which renders as `Connection Point (NMI) PK NMI Attr Metering_Type …` — a
 * single run-on paragraph where the source had a structure. This restores it by
 * marking each line as a CommonMark HARD break (two trailing spaces), which is
 * faithful rather than clever: the table stays a list of lines, because
 * reconstructing the columns would be inventing them.
 *
 * Deliberately NOT applied to every document. The artefacts the agents write —
 * which the approval gate renders through the same component — are proper
 * markdown with blank lines and real tables, and hard-breaking their wrapped
 * prose would damage documents that read correctly today.
 */

/** Fence openers and closers: ``` or ~~~, optionally indented, with an info string. */
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

export function hardBreaks(source: string): string {
  const lines = String(source ?? "").replace(/\r\n/g, "\n").split("\n");
  let fence: string | null = null;

  return lines
    .map((line, i) => {
      // Code is verbatim by definition. Two trailing spaces inside a fence are
      // part of the code, and adding them would silently edit somebody's
      // snippet — including the Mermaid blocks the renderer turns into diagrams.
      const opener = FENCE.exec(line);
      if (fence) {
        if (opener && line.trim().startsWith(fence)) fence = null;
        return line;
      }
      if (opener) { fence = opener[1][0].repeat(3); return line; }

      const next = lines[i + 1];
      // Nothing to join to: the last line, or a paragraph break that already
      // separates them.
      if (next === undefined || next.trim() === "" || line.trim() === "") return line;
      // Already an explicit break — two spaces or a trailing backslash.
      if (/( {2,}|\\)$/.test(line)) return line;
      return line + "  ";
    })
    .join("\n");
}

/**
 * The provenance banner `convert-to-md.mjs` writes as line 1 of everything it
 * converts. Shown in the preview's header instead, where it belongs — a reader
 * opening a document wants the document, not a note about how it was built.
 */
export function stripConverterBanner(source: string): string {
  return String(source ?? "").replace(/^\s*<!--\s*Converted from[\s\S]*?-->\n*/, "");
}

/**
 * What the renderer is actually handed.
 *
 * A one-line function so the decision that governs `Markdown`'s EIGHT existing
 * call sites — the whole approval-gate preview — is a pure thing a test can
 * hold. Rendering React needs a DOM this package does not carry, and adding one
 * to guard a boolean would be a dependency for a test.
 */
export const renderSource = (source: string, preserveLineBreaks: boolean): string =>
  preserveLineBreaks ? hardBreaks(source) : source;
