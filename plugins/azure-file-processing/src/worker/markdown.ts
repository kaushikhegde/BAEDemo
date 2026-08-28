import { createWriteStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { once } from "node:events";
import type { Config } from "../shared/config.js";
import { log } from "../shared/logger.js";
import { extractPages } from "./extract/index.js";

/** Which engine produced `document.md`. Recorded in result.json rather than
 *  inferred, because the two produce genuinely different documents — one keeps
 *  headings and tables, the other does not — and a reader deciding whether a
 *  capability map's input was any good needs to know which they got. */
export type Converter = "markitdown" | "anydoc" | "csv" | "stream";

export interface MarkdownResult { converter: Converter; chars: number }

/** Formats markitdown-ts reads. Its own dependency list: mammoth (.docx),
 *  pdf-parse (.pdf), xlsx (.xlsx), turndown (.html). Kept in step with
 *  scripts/convert-to-md.mjs, which is the converter every document already
 *  in projects/ went through — the two must not disagree about who owns
 *  what, or the same .docx converts differently depending on which door it
 *  came in by. */
const MARKITDOWN_FORMATS = new Set([
  ".docx", ".doc", ".pdf", ".xlsx", ".html", ".htm", ".xml", ".ipynb",
]);

/** Formats only @firecrawl/anydoc reads — PowerPoint above all, which
 *  markitdown-ts lists unchecked and carries no dependency for. Same split as
 *  scripts/convert-to-md.mjs NATIVE_FORMATS. */
const ANYDOC_FORMATS = new Set([
  ".pptx", ".ppt", ".pptm", ".ppsx", ".pps", ".pot", ".ppsm",
  ".odt", ".ods", ".odp",
  ".xls", ".xlsm", ".xlsb", ".docm",
  ".rtf", ".epub",
]);

/** Comma-separated values, rendered here rather than by a native addon.
 *
 *  A CSV is already text. Handing it to a prebuilt NAPI binary to be told so
 *  bought a markdown table and risked the whole job on a dependency that can
 *  be absent, wrong for the platform, or — the case that cost a client an
 *  afternoon — simply never return. Nothing below can hang: it is a parser
 *  over a string with no I/O and no native code.
 *
 *  Kept in step with `scripts/convert-to-md.mjs`, which owns the same format
 *  by the same rule. The two engines must not disagree, or the same file
 *  converts differently depending on which door it came in by. */
const CSV_FORMATS = new Set([".csv"]);

/** Already text: there is nothing to convert, so the bytes are the markdown.
 *  Still written out as `document.md` so every succeeded job has one, and a
 *  consumer never has to special-case the format it started as. */
const PLAIN_FORMATS = new Set([".md", ".markdown", ".txt"]);

export const isConvertible = (ext: string): boolean => {
  const e = ext.toLowerCase();
  return MARKITDOWN_FORMATS.has(e) || ANYDOC_FORMATS.has(e) || PLAIN_FORMATS.has(e)
    || CSV_FORMATS.has(e);
};

const require_ = createRequire(import.meta.url);

/** Resolved from THIS package's node_modules, unlike scripts/convert-to-md.mjs
 *  which reaches into the chatbot's. The worker runs in a container whose
 *  filesystem is the image's — the chatbot's tree is simply not there — so the
 *  plugin has to declare its own copy. Pinned to the same version the chatbot
 *  declares, since two engines disagreeing about the same .docx is precisely
 *  the drift that comment was guarding against. */
const loadMarkItDown = (): any => {
  const mod = require_("markitdown-ts");
  const MarkItDown = mod.MarkItDown ?? mod.default?.MarkItDown;
  if (!MarkItDown) throw new Error("markitdown-ts exports no MarkItDown");
  return MarkItDown;
};

/** A NAPI prebuilt binary, so unlike markitdown-ts it can be absent or wrong
 *  for the image's platform. Loaded lazily and allowed to fail: a PowerPoint
 *  deck falling back to the streaming extractor produces poor markdown, which
 *  is worse than good markdown and far better than a failed job. */
const loadAnydoc = (): ((buf: Buffer, opts: { extension: string }) => Promise<any>) | null => {
  try {
    const mod = require_("@firecrawl/anydoc");
    return mod.toMarkdown ?? mod.default?.toMarkdown ?? null;
  } catch {
    return null;
  }
};

/**
 * Give one converter call a deadline.
 *
 * Both engines are opaque once entered — markitdown-ts is synchronous inside a
 * promise and anydoc is a native addon — so neither can be cancelled. This does
 * not stop the work; it stops US WAITING for it, and lets the caller fall
 * through to the streaming extractor, which always finishes.
 *
 * That distinction is the whole point. The `try/catch` around each engine
 * catches a THROW. A call that wedges never throws, it just never returns, so
 * the catch is no defence at all and the fallback below it is unreachable.
 * A 176-page PDF and seven CSVs sat at `running` for twenty minutes on exactly
 * this: the job could not fail, so nothing reported it, and the caller's own
 * timeout was the only thing that ever fired.
 */
const withTimeout = async <T>(work: Promise<T>, ms: number, engine: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${engine} did not return within ${ms}ms`)), ms);
        // The loser of the race must not hold the process open: a converter
        // still running when the job is done would keep node alive past it.
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * A CSV as a markdown table.
 *
 * RFC 4180 quoting — doubled quotes inside a quoted field, and separators or
 * newlines that only count when unquoted. An unterminated quote ends at the
 * end of input rather than throwing: a truncated export is still worth reading,
 * and refusing it would send the whole document down the flat-text path over
 * one bad row.
 */
export const csvToMarkdown = (text: string): string => {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }   // an escaped quote
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
      continue;
    }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  const real = rows.filter(r => r.some(cell => cell.trim() !== ""));
  if (!real.length) return "";

  // A pipe would end the cell it sits in, and a newline would end the row.
  const cell = (v: string) => v.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").trim();
  // Ragged rows are normal in exported CSVs. Padding to the widest row keeps
  // the table valid rather than dropping the columns that overflow a short
  // header — losing a column silently is how a data model ends up missing a
  // field nobody can trace.
  const width = Math.max(...real.map(r => r.length));
  const line = (r: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cell(r[i] ?? "")).join(" | ")} |`;

  return [
    line(real[0]),
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...real.slice(1).map(line),
  ].join("\n");
};

const header = (filename: string, how: Converter): string =>
  `<!-- Converted from ${filename} by ${how}. Source archived in Azure Blob Storage. -->\n\n`;

/**
 * Writes `document.md` for one job to `scratch`, and says which engine made it.
 *
 * Both engines want the whole document in memory at once — that is the price
 * of keeping headings and tables, and it is the WORKER's memory, not the
 * model's context, so it costs a container's RAM rather than the thing this
 * plugin exists to protect. Above `markdownMaxBytes` even that is unreasonable,
 * so the streaming extractor writes the file page by page instead: flat text,
 * bounded memory, and a job that finishes. Which one ran is recorded, never
 * guessed at afterwards.
 */
/**
 * Which engine WILL render this file, decided before anything is read.
 *
 * Exported so `writeArtifacts` can ask first. When the answer is `stream`, the
 * markdown is just the page text — exactly what the chunker is about to walk —
 * so it is teed out of that single pass instead of walking the document a
 * second time. Measured: rendering a 634 MB, 40,000-page PDF as a second pass
 * pushed the acceptance suite's bounded-memory job past its ten-minute deadline.
 * Bounded memory was never the problem; doing the work twice was.
 */
export const chooseConverter = async (
  path: string, ext: string, cfg: Config,
  converterOverride: Converter | null = null,
): Promise<Converter> => {
  if (converterOverride) return converterOverride;
  const e = ext.toLowerCase();
  const { size } = await stat(path);
  if (size > cfg.markdownMaxBytes) return "stream";
  if (PLAIN_FORMATS.has(e)) return "markitdown";
  if (CSV_FORMATS.has(e)) return "csv";
  if (MARKITDOWN_FORMATS.has(e)) return "markitdown";
  if (ANYDOC_FORMATS.has(e) && loadAnydoc()) return "anydoc";
  return "stream";
};

export const writeMarkdownFile = async (
  scratch: string, path: string, ext: string, filename: string, cfg: Config,
  /** The engine that ALREADY converted this file, when `path` is a markdown
   *  rendering the worker produced a moment ago rather than the original
   *  upload. Without it a pre-converted .pptx reports `converter: "markitdown"`
   *  — the passthrough that merely copied anydoc's output — and the record of
   *  which engine actually read the deck is lost. */
  converterOverride: Converter | null = null,
): Promise<MarkdownResult> => {
  const e = ext.toLowerCase();
  const { size } = await stat(path);
  const buffered = size <= cfg.markdownMaxBytes;

  if (buffered && PLAIN_FORMATS.has(e)) {
    const text = await readFile(path, "utf8");
    // A pre-converted file arrives carrying the header its real engine wrote;
    // stamping a second one on top would claim the document twice.
    if (converterOverride) return writeString(scratch, text, converterOverride);
    return writeString(scratch, e === ".txt" ? header(filename, "markitdown") + text : text, "markitdown");
  }

  if (buffered && CSV_FORMATS.has(e)) {
    // No try/catch and no timeout: this is a string parser with no I/O and no
    // native code, so there is nothing here that can hang or throw on content.
    // An empty result still falls through, the same as any other engine's.
    const body = csvToMarkdown(await readFile(path, "utf8")).trim();
    if (body) return writeString(scratch, header(filename, "csv") + body + "\n", "csv");
    log.warn("markdown.empty", { filename, ext: e, engine: "csv" });
  }

  if (buffered && MARKITDOWN_FORMATS.has(e)) {
    try {
      const MarkItDown = loadMarkItDown();
      const r = await withTimeout<any>(
        new MarkItDown().convertBuffer(await readFile(path), { file_extension: e }),
        cfg.convertTimeoutMs, "markitdown");
      const body = String(r?.markdown ?? "").trim();
      if (body) return writeString(scratch, header(filename, "markitdown") + body + "\n", "markitdown");
      log.warn("markdown.empty", { filename, ext: e, engine: "markitdown" });
    } catch (err) {
      // Never fatal. A document that will not convert is still a document the
      // streaming extractor can read the words out of, and a job that fails
      // outright leaves the caller with nothing at all.
      log.warn("markdown.engine_failed", {
        filename, ext: e, engine: "markitdown",
        message: String((err as Error)?.message ?? err).slice(0, 200),
      });
    }
  }

  if (buffered && ANYDOC_FORMATS.has(e)) {
    const toMarkdown = loadAnydoc();
    if (toMarkdown) {
      try {
        const r = await withTimeout(
          toMarkdown(await readFile(path), { extension: e.slice(1) }),
          cfg.convertTimeoutMs, "anydoc");
        const body = String(r?.markdown ?? r ?? "").trim();
        if (body) return writeString(scratch, header(filename, "anydoc") + body + "\n", "anydoc");
        log.warn("markdown.empty", { filename, ext: e, engine: "anydoc" });
      } catch (err) {
        log.warn("markdown.engine_failed", {
          filename, ext: e, engine: "anydoc",
          message: String((err as Error)?.message ?? err).slice(0, 200),
        });
      }
    }
  }

  return streamPagesToFile(scratch, path, e, filename, cfg);
};

const writeString = async (
  scratch: string, text: string, converter: Converter,
): Promise<MarkdownResult> => {
  const out = createWriteStream(scratch);
  const done = new Promise<void>((resolve, reject) => {
    out.once("finish", resolve);
    out.once("error", reject);
  });
  out.end(text);
  await done;
  return { converter, chars: text.length };
};

/** The fallback, and the only path a multi-gigabyte document ever takes:
 *  the same page generator that feeds chunking, written straight out to
 *  disk one page at a time. Flat text — no headings, no tables — but the
 *  memory cost is one page regardless of how large the document is. */
const streamPagesToFile = async (
  scratch: string, path: string, ext: string, filename: string, cfg: Config,
): Promise<MarkdownResult> => {
  const out = createWriteStream(scratch);
  let streamError: Error | null = null;
  const done = new Promise<void>((resolve, reject) => {
    out.once("finish", resolve);
    out.once("error", (err) => { streamError = err as Error; reject(err); });
  });
  done.catch(() => {});

  let chars = 0;
  const write = async (s: string) => {
    if (streamError) throw streamError;
    chars += s.length;
    if (!out.write(s)) await once(out, "drain");
  };

  try {
    await write(header(filename, "stream"));
    for await (const page of extractPages(path, ext, { pageWindow: cfg.pageWindow })) {
      await write(page.text.endsWith("\n") ? page.text : `${page.text}\n`);
    }
    if (streamError) throw streamError;
    out.end();
    await done;
  } catch (err) {
    out.destroy();
    throw err;
  }
  return { converter: "stream", chars };
};
