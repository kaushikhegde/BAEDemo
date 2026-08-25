import { stat } from "node:fs/promises";
import type { PageText } from "../chunk.js";
import { extractPdf, pdfMetadata, pdfPageCount } from "./pdf.js";
import { extractDocx } from "./docx.js";
import { extractText } from "./text.js";

export { pdfPageCount };

export interface DocMetadata { pages: number; title: string | null; producer: string | null }

/** The formats the PAGE extractor can read — a different, much smaller set
 *  than the formats the plugin now accepts. A spreadsheet or a slide deck has
 *  no page text to stream: it is converted to markdown first and the markdown
 *  is what gets chunked, which is why the worker has to be able to ASK this
 *  rather than discovering it by catching the throw below. */
const PAGEABLE = new Set([".pdf", ".docx", ".txt", ".md", ".markdown"]);

export const canExtractPages = (ext: string): boolean => PAGEABLE.has(ext.toLowerCase());

export function extractPages(
  path: string, ext: string, opts: { pageWindow: number },
): AsyncGenerator<PageText> {
  switch (ext.toLowerCase()) {
    case ".pdf":  return extractPdf(path, opts);
    case ".docx": return extractDocx(path);
    case ".txt":
    case ".markdown":
    case ".md":   return extractText(path);
    default:
      return (async function* () {
        throw new Error(`unsupported extension ${ext}`);
      })();
  }
}

export const readMetadata = async (path: string, ext: string): Promise<DocMetadata> => {
  if (ext.toLowerCase() === ".pdf") return pdfMetadata(path);
  await stat(path);
  return { pages: 1, title: null, producer: null };
};
