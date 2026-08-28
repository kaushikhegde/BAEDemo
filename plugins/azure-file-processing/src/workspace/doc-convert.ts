import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname, basename } from "node:path";
import type { Config } from "../shared/config.js";
import { writeMarkdownFile, isConvertible } from "../worker/markdown.js";
import { userError } from "../shared/errors.js";

/**
 * Convert an uploaded document to markdown IN PROCESS, in a temp directory.
 *
 * The chatbot used to do this, by running `scripts/convert-to-md.mjs` over the
 * file it had just written into `projects/`. Once documents stopped landing on
 * disk there was nobody left to convert at this door — and an unconverted
 * `.docx` reaching an agent is not a failure anybody sees, it is a document
 * that reads as gibberish.
 *
 * It reuses the WORKER's converter rather than a second implementation, so the
 * small door (`attach_document`) and the big door (`ingest_document`, which
 * converts out in the worker pool) cannot disagree about how the same `.docx`
 * renders. `markdown.ts` says as much about `convert-to-md.mjs`: the engines
 * must not diverge, or the same file converts differently depending on which
 * door it came in by.
 *
 * The temp directory is removed on every path, including a throw. Nothing here
 * touches the workspace tree — that is the entire point of the change.
 */
export interface ConvertedDoc {
  /** `Handling Policy.pdf` becomes `Handling Policy.md`, matching what the same
   *  document uploaded through the other door is called. */
  filename: string;
  content: Buffer;
  converter: string;
  chars: number;
}

export const convertToMarkdown = async (
  bytes: Buffer, originalName: string, cfg: Config,
): Promise<ConvertedDoc> => {
  const ext = extname(originalName);
  if (!ext) {
    throw userError("no_extension",
      `cannot tell what ${JSON.stringify(originalName)} is — it has no file extension, ` +
      `and the converter is chosen by extension.`);
  }
  if (!isConvertible(ext)) {
    // Named rather than attempted: an image or an audio file has a better path
    // and silently storing it as empty markdown would look like success.
    throw userError("not_convertible",
      `${ext} is not a document this pipeline can read. Accepted: .md, .txt, .docx, ` +
      `.pdf, .xlsx, .pptx, .html, .csv, .rtf, .epub and plain text.`);
  }

  const dir = await mkdtemp(join(tmpdir(), "scyne-convert-"));
  try {
    const src = join(dir, `in${ext}`);
    const out = join(dir, "out.md");
    await writeFile(src, bytes);
    const r = await writeMarkdownFile(out, src, ext, originalName, cfg);
    const content = await readFile(out);
    if (!content.length) {
      throw userError("empty_conversion",
        `${originalName} converted to nothing. A scanned PDF with no text layer is the ` +
        `usual cause — it needs OCR before this pipeline can read it.`);
    }
    const stem = basename(originalName, ext);
    return { filename: `${stem}.md`, content, converter: r.converter, chars: r.chars };
  } finally {
    // Best-effort: a temp directory left behind is untidy, and failing the
    // upload over it would be worse than the untidiness.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};
