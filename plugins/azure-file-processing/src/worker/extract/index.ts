import { stat } from "node:fs/promises";
import type { PageText } from "../chunk.js";
import { extractPdf, pdfMetadata, pdfPageCount } from "./pdf.js";
import { extractDocx } from "./docx.js";
import { extractText } from "./text.js";

export { pdfPageCount };

export interface DocMetadata { pages: number; title: string | null; producer: string | null }

export function extractPages(
  path: string, ext: string, opts: { pageWindow: number },
): AsyncGenerator<PageText> {
  switch (ext.toLowerCase()) {
    case ".pdf":  return extractPdf(path, opts);
    case ".docx": return extractDocx(path);
    case ".txt":
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
