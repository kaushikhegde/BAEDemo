import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PageText } from "../chunk.js";

const run = promisify(execFile);

/** poppler prints "Pages:  412". Reading the trailer only — it does not load
 *  the document. */
export const pdfPageCount = async (path: string): Promise<number> => {
  const { stdout } = await run("pdfinfo", [path], { maxBuffer: 1 << 20 });
  const m = stdout.match(/^Pages:\s+(\d+)$/m);
  if (!m) throw new Error("pdfinfo did not report a page count; is the file a PDF?");
  return Number(m[1]);
};

export const pdfMetadata = async (path: string) => {
  const { stdout } = await run("pdfinfo", [path], { maxBuffer: 1 << 20 });
  const field = (name: string) => stdout.match(new RegExp(`^${name}:\\s+(.*)$`, "m"))?.[1]?.trim() || null;
  return {
    pages: Number(stdout.match(/^Pages:\s+(\d+)$/m)?.[1] ?? 0),
    title: field("Title"),
    producer: field("Producer"),
  };
};

/** One page at a time, in windows. Only a window's worth of text is ever
 *  resident, so peak memory is independent of the document's size. pdftotext
 *  separates pages with a form feed (\f). */
export async function* extractPdf(
  path: string, opts: { pageWindow: number },
): AsyncGenerator<PageText> {
  const total = await pdfPageCount(path);
  const window = Math.max(1, opts.pageWindow);

  for (let first = 1; first <= total; first += window) {
    const last = Math.min(first + window - 1, total);
    const { stdout } = await run(
      "pdftotext", ["-f", String(first), "-l", String(last), "-layout", path, "-"],
      { maxBuffer: 256 * 1024 * 1024, encoding: "utf8" },
    );
    // A window of N pages yields N form-feed-separated sections. pdftotext
    // appends a trailing \f, so the final empty section is dropped rather than
    // becoming a phantom page.
    const sections = stdout.split("\f");
    if (sections.length > 1 && sections[sections.length - 1] === "") sections.pop();
    for (let i = 0; i < last - first + 1; i++) {
      yield { page: first + i, text: sections[i] ?? "" };
    }
  }
}
