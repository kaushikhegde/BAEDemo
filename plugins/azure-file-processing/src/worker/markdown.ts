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
export type Converter = "markitdown" | "anydoc" | "stream";

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
  ".rtf", ".epub", ".csv",
]);

/** Already text: there is nothing to convert, so the bytes are the markdown.
 *  Still written out as `document.md` so every succeeded job has one, and a
 *  consumer never has to special-case the format it started as. */
const PLAIN_FORMATS = new Set([".md", ".markdown", ".txt"]);

export const isConvertible = (ext: string): boolean => {
  const e = ext.toLowerCase();
  return MARKITDOWN_FORMATS.has(e) || ANYDOC_FORMATS.has(e) || PLAIN_FORMATS.has(e);
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

  if (buffered && MARKITDOWN_FORMATS.has(e)) {
    try {
      const MarkItDown = loadMarkItDown();
      const r = await new MarkItDown().convertBuffer(await readFile(path), { file_extension: e });
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
        const r = await toMarkdown(await readFile(path), { extension: e.slice(1) });
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
